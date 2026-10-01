/**
 * dsh-agent-swarm — Client 端（模型 / 流服务 / 槽位组件）行为测试
 *
 * 覆盖：会话快照模型、按会话引用计数的流观察服务（含异常可见性与流终止后可重建）、
 * 重试倒计时纯逻辑与 1 秒定时器生命周期、样式一次性注入、以及发布物（__ModuleLoader__ 包）契约。
 */

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi } from "vitest";
import { ClientSwarmModel, latestBatchOf, mergeRosterFrame } from "../src/client/model.js";
import { ClientSwarmService } from "../src/client/service.js";
import {
  RetryTicker,
  earliestRetryAt,
  ensureCssInjected,
  retrySecondsLeft,
  selectBatch,
  summarizeBatches,
} from "../src/client/SwarmHeaderAction.js";
import type { SwarmMemberView, SwarmRosterFrame } from "../src/swarm-registry.js";

/** 构造一帧最小可用的 roster 帧。 */
function rosterFrame(sessionId: string, over: Partial<SwarmRosterFrame> = {}): SwarmRosterFrame {
  return {
    type: "roster",
    swarmId: "sw-1",
    sessionId,
    description: "Desc",
    total: 1,
    activeCount: 0,
    completedCount: 1,
    failedCount: 0,
    abortedCount: 0,
    members: [],
    at: 1000,
    ...over,
  };
}

/** 构造一个成员视图。 */
function member(over: Partial<SwarmMemberView> = {}): SwarmMemberView {
  return { index: 1, item: "task", phase: "pending", retryCount: 0, ...over };
}

/** 让消费循环跑完一轮（流是异步迭代器，需要一次宏任务）。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

/**
 * 极简 document 替身：只用于观察 ensureCssInjected 的 DOM 行为。
 * 不引入 jsdom——本任务的约束是零新依赖。
 */
function installFakeDocument() {
  const appended: any[] = [];
  const head = {
    appendChild: (el: any) => {
      appended.push(el);
    },
  };
  const doc = {
    head,
    createElement: (_tag: string) => ({ dataset: {} as Record<string, string>, textContent: "" }),
    querySelector: (selector: string) => {
      const match = /^style\[data-plugin-css="(.+)"\]$/.exec(selector);
      if (!match) return null;
      return appended.find((el) => el.dataset.pluginCss === match[1]) ?? null;
    },
  };
  (globalThis as any).document = doc;
  return {
    doc,
    appended,
    restore: () => {
      delete (globalThis as any).document;
    },
  };
}

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
    expect(model.getSnapshot().bySession["sess-1"]?.batches).toEqual([frame]);
    expect(latestBatchOf(model.getSnapshot().bySession["sess-1"])).toBe(frame);

    unsub();
    model.rosterReceived({ ...frame, activeCount: 0, completedCount: 1 });
    expect(listener).toHaveBeenCalledTimes(1); // not called after unsub
  });
});

describe("多批次合并（同一会话并发的几次调用）", () => {
  it("带 visibleSwarmIds 的帧：按可见集合排序并清理退出的批次", () => {
    const a = rosterFrame("s", { swarmId: "a" });
    const b = rosterFrame("s", { swarmId: "b" });
    let batches = mergeRosterFrame([], { ...a, visibleSwarmIds: ["a"] });
    batches = mergeRosterFrame(batches, { ...b, visibleSwarmIds: ["a", "b"] });
    expect(batches.map((x) => x.swarmId)).toEqual(["a", "b"]);
    // a 的新帧原位替换，顺序不变
    batches = mergeRosterFrame(batches, { ...a, completedCount: 9, visibleSwarmIds: ["a", "b"] });
    expect(batches.map((x) => [x.swarmId, x.completedCount])).toEqual([
      ["a", 9],
      ["b", 1],
    ]);
    // 新一组开始：a、b 退出可见集合
    const c = rosterFrame("s", { swarmId: "c", visibleSwarmIds: ["c"] });
    expect(mergeRosterFrame(batches, c).map((x) => x.swarmId)).toEqual(["c"]);
  });

  it("尚未收到帧的可见批次暂缺，不凭空构造", () => {
    const b = rosterFrame("s", { swarmId: "b", visibleSwarmIds: ["a", "b"] });
    expect(mergeRosterFrame([], b).map((x) => x.swarmId)).toEqual(["b"]);
  });

  it("不带 visibleSwarmIds 的旧帧：按 swarmId 替换或追加，且有保留上限", () => {
    let batches: ReturnType<typeof mergeRosterFrame> = [];
    for (let i = 0; i < 12; i += 1) batches = mergeRosterFrame(batches, rosterFrame("s", { swarmId: `b${String(i)}` }));
    expect(batches).toHaveLength(8);
    expect(batches[batches.length - 1]?.swarmId).toBe("b11");
  });

  it("selectBatch：未选或已不可见时回到最新批次", () => {
    const batches = [rosterFrame("s", { swarmId: "a" }), rosterFrame("s", { swarmId: "b" })];
    expect(selectBatch(batches, undefined)?.swarmId).toBe("b");
    expect(selectBatch(batches, "a")?.swarmId).toBe("a");
    expect(selectBatch(batches, "gone")?.swarmId).toBe("b");
    expect(selectBatch([], undefined)).toBeUndefined();
  });

  it("summarizeBatches：徽标对全部可见批次聚合（此前只看最新一个）", () => {
    expect(summarizeBatches([])).toEqual({ badgeText: "0", isLive: false });
    const running = rosterFrame("s", { swarmId: "a", total: 4, activeCount: 2, completedCount: 1 });
    const done = rosterFrame("s", { swarmId: "b", total: 3, activeCount: 0, completedCount: 3 });
    expect(summarizeBatches([running, done])).toEqual({ badgeText: "2/7", isLive: true });
    expect(summarizeBatches([done, { ...running, activeCount: 0, completedCount: 4 }])).toEqual({
      badgeText: "7/7",
      isLive: false,
    });
  });
});

describe("ClientSwarmModel 流失败态", () => {
  it("streamFailed 记录可见错误并通知订阅者，新帧到达后清除该会话的失败标记", () => {
    const model = new ClientSwarmModel();
    const listener = vi.fn();
    const unsub = model.subscribe(listener);

    model.streamFailed("sess-1", "socket hang up");
    expect(listener).toHaveBeenCalledTimes(1);
    const failure = model.getSnapshot().streamFailures["sess-1"];
    expect(failure?.message).toBe("socket hang up");
    expect(typeof failure?.at).toBe("number");

    // 空 sessionId 不入表，也不通知
    model.streamFailed("", "boom");
    expect(model.getSnapshot().streamFailures[""]).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);

    // 流恢复：同一会话的新 roster 帧清掉失败标记，否则面板会一直挂着过期错误
    model.rosterReceived(rosterFrame("sess-1"));
    expect(model.getSnapshot().streamFailures["sess-1"]).toBeUndefined();
    unsub();
  });
});

describe("ClientSwarmService", () => {
  it("subscribes to remote stream with reference counting", async () => {
    const model = new ClientSwarmModel();
    const disposeFn = vi.fn();
    // 流在 dispose 之前保持开启（真实 roster 流是长连接，不会自己结束），
    // 这样才能把"引用计数"与"流终止"两件事分开验证。
    const release: Array<() => void> = [];

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
        await new Promise<void>((resolve) => {
          release.push(resolve);
        });
      },
      dispose: () => {
        disposeFn();
        release.forEach((r) => r());
      },
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
    expect(latestBatchOf(model.getSnapshot().bySession["sess-svc"])?.total).toBe(1);

    // First unsubscribe does not dispose stream
    unsub1();
    expect(disposeFn).not.toHaveBeenCalled();

    // Second unsubscribe disposes stream
    unsub2();
    expect(disposeFn).toHaveBeenCalledTimes(1);
  });
});

describe("ClientSwarmService 流异常可见性与重建", () => {
  it("流异常不再静默：错误进入模型，失效条目被摘除，下一次 watchSwarm 可重建", async () => {
    const model = new ClientSwarmModel();
    const disposers: any[] = [];
    let release: Array<() => void> = [];
    let opened = 0;

    const mockRemote = {
      $stream: vi.fn(() => {
        opened += 1;
        const call = opened;
        const disposeFn = vi.fn(() => {
          release.forEach((r) => r());
          release = [];
        });
        disposers.push(disposeFn);
        return {
          async *[Symbol.asyncIterator]() {
            if (call === 1) throw new Error("socket hang up");
            yield { value: rosterFrame("sess-z"), accept: vi.fn() };
            // 重建后的流是长连接：推送首帧后保持开启，直到被释放
            await new Promise<void>((resolve) => {
              release.push(resolve);
            });
          },
          dispose: disposeFn,
        };
      }),
      swarm: { roster: vi.fn() },
    };

    const service = new ClientSwarmService(mockRemote as any, model);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      service.watchSwarm("sess-z");
      await flush();

      // ① 可见：异常写进模型（面板据此渲染错误），并有一条带 sessionId 上下文的日志
      const failure = model.getSnapshot().streamFailures["sess-z"];
      expect(failure?.message).toContain("socket hang up");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("sess-z");
      // 终止的 carrier 被释放，不留下已死的流占位
      expect(disposers[0]).toHaveBeenCalledTimes(1);

      // ② 可重建：失效条目已摘除，下一次订阅开的是新流（修复前这里仍是第一条死流）
      expect(mockRemote.$stream).toHaveBeenCalledTimes(1);
      const freshUnsub = service.watchSwarm("sess-z");
      expect(mockRemote.$stream).toHaveBeenCalledTimes(2);
      await flush();
      expect(latestBatchOf(model.getSnapshot().bySession["sess-z"])?.sessionId).toBe("sess-z");

      // ③ 新流恢复正常后失败标记被清除
      expect(model.getSnapshot().streamFailures["sess-z"]).toBeUndefined();
      freshUnsub();
      expect(disposers[1]).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("流非异常地自然结束（非主动取消）同样上报，不留静默僵尸", async () => {
    const model = new ClientSwarmModel();
    const disposeFn = vi.fn();
    const mockRemote = {
      $stream: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield { value: rosterFrame("sess-e"), accept: vi.fn() };
          // 迭代器自然结束：宿主那边关了流，而订阅者还在
        },
        dispose: disposeFn,
      })),
      swarm: { roster: vi.fn() },
    };

    const service = new ClientSwarmService(mockRemote as any, model);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      service.watchSwarm("sess-e");
      await flush();

      expect(model.getSnapshot().streamFailures["sess-e"]?.message).toContain("stream ended");
      expect(disposeFn).toHaveBeenCalledTimes(1);

      // 条目已摘除 → 重新订阅开新流
      service.watchSwarm("sess-e");
      expect(mockRemote.$stream).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("用户主动取消订阅不产生误报，且取消后仍可重新订阅", async () => {
    const model = new ClientSwarmModel();
    const release: Array<() => void> = [];
    const disposeFn = vi.fn(() => {
      release.forEach((r) => r());
    });
    const mockRemote = {
      $stream: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield { value: rosterFrame("sess-u"), accept: vi.fn() };
          await new Promise<void>((resolve) => {
            release.push(resolve);
          });
        },
        dispose: disposeFn,
      })),
      swarm: { roster: vi.fn() },
    };

    const service = new ClientSwarmService(mockRemote as any, model);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const unsub = service.watchSwarm("sess-u");
      await flush();
      unsub();
      await flush();

      expect(disposeFn).toHaveBeenCalledTimes(1);
      expect(model.getSnapshot().streamFailures["sess-u"]).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();

      service.watchSwarm("sess-u");
      expect(mockRemote.$stream).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("失效流的陈旧释放器不会误停重建后的新流", async () => {
    const model = new ClientSwarmModel();
    const disposers: any[] = [];
    const release: Array<() => void> = [];
    let opened = 0;

    const mockRemote = {
      $stream: vi.fn(() => {
        opened += 1;
        const call = opened;
        const disposeFn = vi.fn(() => {
          release.forEach((r) => r());
        });
        disposers.push(disposeFn);
        return {
          async *[Symbol.asyncIterator]() {
            if (call === 1) throw new Error("boom");
            yield { value: rosterFrame("sess-s"), accept: vi.fn() };
            await new Promise<void>((resolve) => {
              release.push(resolve);
            });
          },
          dispose: disposeFn,
        };
      }),
      swarm: { roster: vi.fn() },
    };

    const service = new ClientSwarmService(mockRemote as any, model);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const staleUnsub = service.watchSwarm("sess-s");
      await flush(); // 第一条流异常终止，条目被摘除
      const freshUnsub = service.watchSwarm("sess-s");
      await flush(); // 新流推送首帧后保持开启
      expect(latestBatchOf(model.getSnapshot().bySession["sess-s"])?.sessionId).toBe("sess-s");

      staleUnsub(); // 陈旧释放器只该作用于自己那条死流
      expect(disposers[1]).not.toHaveBeenCalled();
      expect(model.getSnapshot().streamFailures["sess-s"]).toBeUndefined();

      freshUnsub();
      expect(disposers[1]).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("重试倒计时（纯逻辑）", () => {
  it("earliestRetryAt 只认 retrying 且带 retryReadyAt 的成员，并取最近时刻", () => {
    expect(earliestRetryAt(undefined)).toBeNull();
    expect(earliestRetryAt([])).toBeNull();
    expect(earliestRetryAt([member({ phase: "running" })])).toBeNull();
    expect(earliestRetryAt([member({ phase: "retrying", retryReadyAt: undefined })])).toBeNull();
    expect(
      earliestRetryAt([
        member({ index: 1, phase: "retrying", retryReadyAt: 5000 }),
        member({ index: 2, phase: "running" }),
        member({ index: 3, phase: "retrying", retryReadyAt: 3000 }),
      ]),
    ).toBe(3000);
  });

  it("retrySecondsLeft 向上取整，已到点返回 0（不显示负数或 0 秒）", () => {
    expect(retrySecondsLeft(5000, 5000)).toBe(0);
    expect(retrySecondsLeft(5000, 5001)).toBe(0);
    expect(retrySecondsLeft(5000, 4000)).toBe(1);
    expect(retrySecondsLeft(4200, 4000)).toBe(1);
    expect(retrySecondsLeft(10500, 9000)).toBe(2);
  });
});

describe("RetryTicker", () => {
  it("按 1 秒节拍运行，且只在存在未来截止时刻时存在（到点自停、无成员时清理）", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const onTick = vi.fn();
      const ticker = new RetryTicker(onTick);

      // 无待重试成员 → 不起表
      ticker.sync(null);
      expect(ticker.running).toBe(false);
      vi.advanceTimersByTime(5000);
      expect(onTick).not.toHaveBeenCalled();

      // 已过点的截止时刻 → 仍不起表
      ticker.sync(Date.now() - 1);
      expect(ticker.running).toBe(false);
      vi.advanceTimersByTime(3000);
      expect(onTick).not.toHaveBeenCalled();

      // 未来截止时刻 → 起表；重复 sync 不重复起表
      const deadline = Date.now() + 2500;
      ticker.sync(deadline);
      expect(ticker.running).toBe(true);
      ticker.sync(deadline);
      vi.advanceTimersByTime(1000);
      expect(onTick).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
      expect(onTick).toHaveBeenCalledTimes(2);

      // 到点自停：不再常驻
      vi.advanceTimersByTime(1000);
      expect(ticker.running).toBe(false);
      const settled = onTick.mock.calls.length;
      vi.advanceTimersByTime(10_000);
      expect(onTick.mock.calls.length).toBe(settled);

      // 显式清理幂等
      ticker.stop();
      ticker.stop();
      expect(ticker.running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ensureCssInjected", () => {
  it("只注入一次样式标签，重复调用幂等（可安全用于 apply 期与挂载期）", () => {
    const fake = installFakeDocument();
    try {
      ensureCssInjected();
      ensureCssInjected();
      expect(fake.appended).toHaveLength(1);
      expect(fake.appended[0].dataset.plugin).toBe("dsh-agent-swarm");
      expect(fake.appended[0].dataset.pluginCss).toBe("dsh-agent-swarm/style.css");
      expect(fake.appended[0].textContent).toContain(".dsh-swarm-root");
    } finally {
      fake.restore();
    }
  });

  it("无 document 环境下静默跳过而不抛错", () => {
    delete (globalThis as any).document;
    expect(() => ensureCssInjected()).not.toThrow();
  });
});

describe("dsh.client 声明", () => {
  it("client.inject 只声明客户端半真正消费的插件（不再挂无人引用的 primitives）", () => {
    const pkg = JSON.parse(
      fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    );
    expect(pkg.dsh.client.inject).toEqual(["@deepseek-ai/dsh-client-locale"]);
    expect(pkg.dsh.client.platform).toBe("web");
  });
});

describe("client bundle integration", () => {
  /**
   * 参数与 scripts/build-client.mjs 保持同步（入口 / external / format / target /
   * banner / footer）。改动 build 脚本时必须同步改这里，否则测试验的就不是发布物。
   * 用 write:false 在内存里打包，避免读盘上可能过期的 dist/client.js——
   * "读旧产物"会让绿灯覆盖面与真实交付物错位。
   */
  async function buildRegistration(): Promise<any> {
    let registration: any;
    const mockWindow = {
      __ModuleLoader__: {
        load: (reg: any) => {
          registration = reg;
        },
      },
    };
    (globalThis as any).window = mockWindow;

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
    return registration;
  }

  async function loadPluginExports(): Promise<any> {
    const registration = await buildRegistration();
    const React = await import("react");
    const JsxRuntime = await import("react/jsx-runtime");
    const mockRequire = (id: string) => {
      if (id === "react") return React;
      if (id === "react/jsx-runtime") return JsxRuntime;
      return {};
    };
    return { registration, modExports: registration.factory(mockRequire) };
  }

  it("bundles into valid __ModuleLoader__ package exporting inject and apply", async () => {
    const { registration, modExports } = await loadPluginExports();

    expect(registration).toBeDefined();
    expect(registration.id).toBe("dsh-agent-swarm");
    expect(modExports.inject).toEqual(["remote", "slots", "locale"]);
    expect(typeof modExports.apply).toBe("function");
  });

  /** 用替身上下文跑一次 apply，捕获槽位注册选项、子插件声明与释放句柄。 */
  async function applyPlugin(modExports: any) {
    const remoteDispose = vi.fn();
    const slotDispose = vi.fn();
    let slotOptions: any;
    let panelPlugin: any;
    let panelDispose: (() => void) | undefined;
    const ctx: any = {
      remote: { $mount: vi.fn(async () => remoteDispose) },
      slots: {
        // 官方 ui-jobs 插件同款契约：inject(key, () => register(options, Component))。
        // 宿主在渲染 outlet 时调用该工厂，这里立刻调用以便观察注册选项。
        inject: vi.fn((_key: string, factory: () => unknown) => {
          factory();
          return slotDispose;
        }),
        register: vi.fn((options: any, _component: unknown) => {
          slotOptions = options;
          return slotDispose;
        }),
      },
      locale: { register: vi.fn(() => vi.fn()) },
      effect: vi.fn((cb: () => unknown) => {
        cb();
      }),
      // 父/子 fiber 拆分：真实宿主用 ctx.plugin 加载内联子插件。
      // 这里同步执行子 apply 并保留其释放句柄；子 ctx 复用同一批替身，既有断言照旧生效。
      plugin: vi.fn((plugin: any) => {
        panelPlugin = plugin;
        const childCtx = {
          remote: ctx.remote,
          slots: ctx.slots,
          locale: ctx.locale,
          effect: ctx.effect,
        };
        panelDispose = plugin.apply(childCtx) as (() => void) | undefined;
        return { dispose: () => panelDispose?.() };
      }),
    };
    const dispose = await modExports.apply(ctx);
    return { ctx, slotOptions, slotDispose, remoteDispose, dispose, getPanelPlugin: () => panelPlugin };
  }

  it("命名空间服务只对声明它的 fiber 可见：必须在子 fiber 的 inject 里声明 remote.swarm，且挂载先于子插件加载", async () => {
    const { modExports } = await loadPluginExports();
    const fake = installFakeDocument();
    try {
      const { ctx, getPanelPlugin } = await applyPlugin(modExports);
      const panel = getPanelPlugin();

      expect(panel).toBeDefined();
      // 消费侧：子 fiber 必须逐字声明点号服务名，否则运行期会被 cordis 隔离挡掉
      //（0.3.4 面板报的 cannot get property "remote.swarm" without inject 就是这个原因）。
      expect(panel.inject).toContain("remote.swarm");
      expect(panel.inject).toContain("remote");
      // 提供侧：父 fiber 绝不能声明自己挂载出来的服务——那要等它自己的 apply 跑完，会死锁。
      expect(modExports.inject).not.toContain("remote.swarm");
      // 顺序：先 $mount 提供命名空间，再加载子插件消费。
      expect(ctx.remote.$mount).toHaveBeenCalledTimes(1);
      expect(ctx.plugin).toHaveBeenCalledTimes(1);
      expect(ctx.remote.$mount.mock.invocationCallOrder[0]).toBeLessThan(
        ctx.plugin.mock.invocationCallOrder[0] as number,
      );
    } finally {
      fake.restore();
    }
  });

  it("apply 期一次性注入样式（不再每次 re-render 都查 DOM）", async () => {
    const { modExports } = await loadPluginExports();
    const fake = installFakeDocument();
    try {
      const { ctx, slotOptions } = await applyPlugin(modExports);

      expect(fake.appended).toHaveLength(1);
      expect(fake.appended[0].dataset.pluginCss).toBe("dsh-agent-swarm/style.css");
      expect(fake.appended[0].textContent).toContain(".dsh-swarm-root");
      expect(ctx.remote.$mount).toHaveBeenCalledTimes(1);
      expect(ctx.locale.register).toHaveBeenCalledWith("agentSwarm", expect.anything());

      // 槽位注册契约不变
      expect(ctx.slots.inject).toHaveBeenCalledWith(
        "conversation.session.header.actions",
        expect.any(Function),
      );
      expect(slotOptions.name).toBe("conversation.session.header.actions");
      expect(slotOptions.id).toBe("agent-swarm");
      expect(slotOptions.order).toBe(30);
      expect(slotOptions.locale).toBe("agentSwarm");

      // 卸载可逆：槽位与 remote 都被释放
      const { dispose, slotDispose, remoteDispose } = await applyPlugin(modExports);
      await dispose();
      expect(slotDispose).toHaveBeenCalled();
      expect(remoteDispose).toHaveBeenCalled();
    } finally {
      fake.restore();
    }
  });

  it("槽位注入属性引用稳定（不再每次 inject 新建闭包，避免订阅抖动）", async () => {
    const { modExports } = await loadPluginExports();
    const fake = installFakeDocument();
    try {
      const { slotOptions } = await applyPlugin(modExports);

      const injected1 = slotOptions.inject();
      const injected2 = slotOptions.inject();
      expect(injected1).toBe(injected2);
      expect(typeof injected1.watchSwarm).toBe("function");
      expect(injected1.watchSwarm).toBe(injected2.watchSwarm);
      expect(injected1.useSwarm).toBe(injected2.useSwarm);
    } finally {
      fake.restore();
    }
  });
});
