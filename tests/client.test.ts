import * as esbuild from "esbuild";

import { describe, it, expect, vi } from "vitest";
import { ClientSwarmModel } from "../src/client/model.js";
import { ClientSwarmService } from "../src/client/service.js";
import type { SwarmRosterFrame } from "../src/swarm-registry.js";

describe("ClientSwarmModel", () => {
  it("manages session roster state and notifies subscribers", () => {
    const model = new ClientSwarmModel();
    const listener = vi.fn();
    const unsub = model.subscribe(listener);

    expect(model.getSnapshot().bySession).toEqual({});

    const frame: SwarmRosterFrame = {
      type: "roster",
      swarmId: "sw-1",
      sessionId: "sess-1",
      description: "Batch 1",
      total: 2,
      activeCount: 1,
      completedCount: 0,
      failedCount: 0,
      abortedCount: 0,
      members: [
        { index: 1, item: "task 1", phase: "running", retryCount: 0 },
        { index: 2, item: "task 2", phase: "pending", retryCount: 0 },
      ],
      at: 1000,
    };

    model.rosterReceived(frame);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot().bySession["sess-1"]).toBe(frame);

    unsub();
    model.rosterReceived({ ...frame, activeCount: 0, completedCount: 1 });
    expect(listener).toHaveBeenCalledTimes(1); // not called after unsub
  });
});

describe("ClientSwarmService", () => {
  it("subscribes to remote stream with reference counting", async () => {
    const model = new ClientSwarmModel();
    const disposeFn = vi.fn();

    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield {
          value: {
            type: "roster",
            swarmId: "sw-1",
            sessionId: "sess-svc",
            description: "Desc",
            total: 1,
            activeCount: 0,
            completedCount: 1,
            failedCount: 0,
            abortedCount: 0,
            members: [],
            at: 1000,
          },
          accept: vi.fn(),
        };
      },
      dispose: disposeFn,
    };

    const mockRemote = {
      $stream: vi.fn().mockReturnValue(mockStream),
      swarm: {
        roster: vi.fn(),
      },
    };

    const service = new ClientSwarmService(mockRemote as any, model);

    const unsub1 = service.watchSwarm("sess-svc");
    expect(mockRemote.$stream).toHaveBeenCalledTimes(1);

    // Second watcher for same session does not open a second stream
    const unsub2 = service.watchSwarm("sess-svc");
    expect(mockRemote.$stream).toHaveBeenCalledTimes(1);

    // Wait microtask for async loop to process frame
    await new Promise((r) => setTimeout(r, 10));
    expect(model.getSnapshot().bySession["sess-svc"]?.total).toBe(1);

    // First unsubscribe does not dispose stream
    unsub1();
    expect(disposeFn).not.toHaveBeenCalled();

    // Second unsubscribe disposes stream
    unsub2();
    expect(disposeFn).toHaveBeenCalledTimes(1);
  });
});

describe("client bundle integration", () => {
  it("bundles into valid __ModuleLoader__ package exporting inject and apply", async () => {
    let registration: any;
    const mockWindow = {
      __ModuleLoader__: {
        load: (reg: any) => {
          registration = reg;
        },
      },
    };
    (globalThis as any).window = mockWindow;

    // 参数与 scripts/build-client.mjs 保持同步（入口 / external / format / target /
    // banner / footer）。改动 build 脚本时必须同步改这里，否则测试验的就不是发布物。
    // 用 write:false 在内存里打包，避免读盘上可能过期的 dist/client.js——
    // "读旧产物"会让绿灯覆盖面与真实交付物错位。
    const result = await esbuild.build({
      entryPoints: ["src/client/index.ts"],
      bundle: true,
      format: "cjs",
      target: "es2022",
      external: ["react", "react/jsx-runtime", "@deepseek-ai/*", "cordis", "@deepseek-ai/cordis"],
      banner: {
        js: `window.__ModuleLoader__.load({
  id: "dsh-agent-swarm",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
      },
      footer: {
        js: `    return module.exports;
  }
});`,
      },
      write: false,
    });
    const output = result.outputFiles[0];
    if (output === undefined) throw new Error("esbuild produced no output file");
    // eslint-disable-next-line no-eval
    eval(output.text);

    expect(registration).toBeDefined();
    expect(registration.id).toBe("dsh-agent-swarm");

    const React = await import("react");
    const JsxRuntime = await import("react/jsx-runtime");
    const mockRequire = (id: string) => {
      if (id === "react") return React;
      if (id === "react/jsx-runtime") return JsxRuntime;
      return {};
    };

    const modExports = registration.factory(mockRequire);
    expect(modExports.inject).toEqual(["remote", "slots", "locale"]);
    expect(typeof modExports.apply).toBe("function");
  });
});
