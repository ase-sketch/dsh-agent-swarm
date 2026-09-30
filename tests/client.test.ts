import * as fs from "node:fs/promises";

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
    let streamYield: (val: any) => void;

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

    const bundleContent = await fs.readFile("dist/client.js", "utf-8");
    // eslint-disable-next-line no-eval
    eval(bundleContent);

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
