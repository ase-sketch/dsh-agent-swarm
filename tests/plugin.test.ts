/**
 * dsh-agent-swarm — 插件契约测试（M2）
 *
 * 两层：
 *   A. mock Context 契约测试：捕获 ctx.tools.register 的入参、stub ctx.subagents.start，
 *      断言 inject 键、defineTool 形态、六道校验的结构化失败、start/dispose 配对、
 *      signal 级联、失败聚合与 XML 如实呈现。
 *   B. 真实 Loader 加载测试：用 @deepseek-ai/cordis + cordis-plugin-loader 走真实
 *      插件加载路径，断言插件确实被激活（apply 被调用、工具注册成功、卸载即注销）。
 *
 * 说明：M1 的纯函数行为由既有三个测试文件覆盖，这里只测"集成层接线是否正确"。
 */

import { describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import * as plugin from "../src/index.js";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  DEFAULT_SWARM_SCHEDULER_CONFIG,
  DEFAULT_TASK_TIMEOUT_MS,
  SWARM_MAX_SUBAGENTS,
  SWARM_MIN_ITEMS,
} from "../src/types.js";
import type { SwarmBatch, SwarmPhase, SwarmRegistry } from "../src/swarm-registry.js";

// ───────────────────────── mock Context ─────────────────────────

interface StartCall {
  provider: string;
  request: Record<string, unknown>;
}

interface MockContextOptions {
  /** 每个成员的 stopReason（按调用次序循环取用）。 */
  stopReasons?: string[];
  /** 覆盖 apply 收到的 config（默认为 defaultConfig()）；用于观察描述是否跟随 config 变。 */
  config?: Parameters<typeof plugin.apply>[1];
  /** start() 直接抛错的调用序号（0-based）。 */
  failStartAt?: number[];
  /** run.result 是否 reject。 */
  rejectResultAt?: number[];
}

interface MockHarness {
  ctx: Context;
  definition: ToolDefinition;
  /** apply 返回的 disposer（注销工具用）。 */
  dispose: () => void;
  startCalls: StartCall[];
  disposeCount: number;
  /** 桩 registry 当前是否持有已注册的工具。 */
  isRegistered(): boolean;
}

const FAKE_AGENT = { id: "agent-under-test", session: { id: "session-under-test" } };

function createHarness(options: MockContextOptions = {}): MockHarness {
  const stopReasons = options.stopReasons ?? [];
  const failStartAt = new Set(options.failStartAt ?? []);
  const rejectResultAt = new Set(options.rejectResultAt ?? []);
  const startCalls: StartCall[] = [];
  let disposeCount = 0;

  // 已注册工具的"槽位"：register 写入，disposer 清空。
  // 观察槽位本身（而不是局部 definition 变量）才能证明注销真的发生了。
  const registry = { current: undefined as ToolDefinition | undefined };

  const ctx = new Context() as unknown as Context & Record<string, unknown>;

  Object.defineProperty(ctx, "tools", {
    configurable: true,
    value: {
      register: (def: ToolDefinition) => {
        registry.current = def;
        return () => {
          registry.current = undefined;
        };
      },
    },
  });

  let callIndex = 0;
  Object.defineProperty(ctx, "subagents", {
    configurable: true,
    value: {
      start: (provider: string, request: Record<string, unknown>) => {
        const current = callIndex;
        callIndex += 1;
        startCalls.push({ provider, request });
        if (failStartAt.has(current)) {
          return Promise.reject(new Error(`provider "${String(provider)}" refused to start`));
        }
        const stopReason = stopReasons[current] ?? "completed";
        return Promise.resolve({
          id: `run-${String(current)}`,
          localAgent: undefined,
          result: rejectResultAt.has(current)
            ? Promise.reject(new Error("infrastructure fault"))
            : Promise.resolve({
                output: [{ type: "text", text: `result of member ${String(current)}` }],
                stopReason,
              }),
          dispose: () => {
            disposeCount += 1;
            return Promise.resolve();
          },
        });
      },
    },
  });

  const dispose = plugin.apply(ctx, options.config ?? defaultConfig());
  if (registry.current === undefined) throw new Error("apply() did not register a tool");
  return {
    ctx,
    get definition() {
      // 注册后固定不变：契约测试全部在注册完成后才用它。
      if (registry.current === undefined) throw new Error("tool was unregistered");
      return registry.current;
    },
    dispose,
    startCalls,
    get disposeCount() {
      return disposeCount;
    },
    isRegistered: () => registry.current !== undefined,
  };
}

function defaultConfig(): Parameters<typeof plugin.apply>[1] {
  return {
    provider: "spawn",
    firstWave: 5,
    releaseIntervalMs: 700,
    backoffInitialMs: 3000,
    retryFactor: 2,
    shrinkDebounceMs: 2000,
    recoverIntervalMs: 180_000,
    taskTimeoutMs: 7_200_000,
    maxItems: 128,
  };
}

/** 最小可用的执行上下文。 */
function makeExec(signal = new AbortController().signal): Record<string, unknown> {
  return { callId: "call-1", name: "agent_swarm", signal, agent: FAKE_AGENT };
}

function validArgs(overrides: Record<string, unknown> = {}) {
  return {
    description: "review the docs",
    prompt_template: "Review {{item}} and report findings.",
    items: ["a.md", "b.md", "c.md"],
    ...overrides,
  };
}

// ───────────────────────── A. 插件声明形态 ─────────────────────────

describe("A. 插件声明形态", () => {
  it("只用具名导出，绝不 export default", () => {
    expect(plugin.name).toBe("agent-swarm");
    expect(typeof plugin.apply).toBe("function");
    expect(plugin.Config).toBeDefined();
    // Loader 只认具名导出；有 default 会让它走 unwrapExports 分支，掩盖真实缺陷。
    expect("default" in plugin).toBe(false);
  });

  it("inject 恰好是 tools 与 subagents 两个服务键", () => {
    expect([...plugin.inject]).toEqual(["tools", "subagents"]);
  });

  it("Config 给全部字段默认值：provider=spawn、超时 2h、maxItems=128、调度参数取默认表", () => {
    const resolved = (plugin.Config as (v?: unknown) => unknown)() as Record<string, unknown>;
    expect(resolved).toMatchObject({
      provider: "spawn",
      firstWave: 5,
      releaseIntervalMs: 700,
      backoffInitialMs: 3000,
      retryFactor: 2,
      shrinkDebounceMs: 2000,
      recoverIntervalMs: 180_000,
      maxItems: 128,
    });
    // 单任务超时默认值与宿主配置共用同一具名常量（src/types.ts 的 DEFAULT_TASK_TIMEOUT_MS）
    expect(resolved.taskTimeoutMs).toBe(DEFAULT_TASK_TIMEOUT_MS);
    // 2h 只属于"宿主侧默认值"：绝不能并入调度器默认表——调度器的 timeoutMs 默认语义是
    // undefined = 不超时，把它一起默认成 2h 属于行为变更，这里钉死这条边界。
    expect("timeoutMs" in DEFAULT_SWARM_SCHEDULER_CONFIG).toBe(false);
    expect(DEFAULT_SWARM_SCHEDULER_CONFIG.timeoutMs).toBeUndefined();
  });
});

// ───────────────────────── B. defineTool 形态 ─────────────────────────

describe("B. defineTool 注册形态", () => {
  it("工具名、参数映射与 required 只写布尔 true", () => {
    const { definition } = createHarness();
    expect(definition.name).toBe("agent_swarm");
    const parameters = definition.parameters as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(parameters.properties).sort()).toEqual([
      "description",
      "items",
      "prompt_template",
    ]);
    expect(parameters.required?.slice().sort()).toEqual([
      "description",
      "items",
      "prompt_template",
    ]);
    expect(parameters.properties.items).toMatchObject({ type: "array" });
  });

  it("工具描述是英文自拟文本，覆盖用途/六道校验/分工/禁止嵌套", () => {
    const { definition } = createHarness();
    const description = definition.description;
    expect(description).toMatch(/subagents/i);
    // 六道硬校验
    expect(description).toMatch(/at least \d+ entries/);
    expect(description).toMatch(/at most \d+ entries/);
    expect(description).toMatch(/prompt_template/);
    expect(description).toMatch(/\{\{item\}\}/);
    // 与单个 subagent 工具的分工
    expect(description).toMatch(/single-subagent tool/i);
    // 禁止嵌套
    expect(description).toMatch(/depth is capped at 1/i);
    expect(description).toMatch(/[Nn]esting a swarm/);
  });

  it("工具描述的数量插值生效上限：宿主调低 maxItems 后文案必须跟着调低", () => {
    // 期望文本刻意用 effectiveMax = min(config.maxItems, SWARM_MAX_SUBAGENTS) 拼出，
    // 而不是写死 "2"/"128"：文案若退回协议常量，宿主一调低就会红——
    // 守护的正是"模型收到的上界 == 实际拒绝它时用的上界"。
    const effectiveMax = Math.min(defaultConfig().maxItems, SWARM_MAX_SUBAGENTS);
    expect(effectiveMax).toBe(SWARM_MAX_SUBAGENTS); // 本用例走默认配置，生效值就是协议常量
    const { definition } = createHarness();
    const description = definition.description;
    expect(description).toContain(`N (${String(SWARM_MIN_ITEMS)} to ${String(effectiveMax)})`);
    expect(description).toContain(`items must contain at least ${String(SWARM_MIN_ITEMS)} entries.`);
    expect(description).toContain(`items must contain at most ${String(effectiveMax)} entries.`);

    // 参数级文案同源：items 的说明同样在告诉模型数量边界
    const items = (definition.parameters as { properties: { items: { description: string } } }).properties.items;
    expect(items.description).toContain(
      `at least ${String(SWARM_MIN_ITEMS)} and at most ${String(effectiveMax)} entries.`,
    );
  });

  it("output.schema 是 {xml:string}，render 两参并返回内容块数组", () => {
    const { definition } = createHarness();
    const output = definition.output as {
      schema: { type: string; properties: Record<string, unknown> };
      render: (args: unknown, value: unknown) => unknown[];
    };
    expect(output.schema.type).toBe("object");
    expect(output.schema.properties.xml).toMatchObject({ type: "string" });
    expect(output.render.length).toBe(2);
    expect(output.render({}, { xml: "<x/>" })).toEqual([{ type: "text", text: "<x/>" }]);
  });

  it("isConcurrencySafe 恒为 true", () => {
    const { definition } = createHarness();
    expect(definition.isConcurrencySafe?.(validArgs())).toBe(true);
  });

  it("不声明任何审批字段（spike Q8：没有这种机制，不声明即不弹窗）", () => {
    const { definition } = createHarness();
    const keys = Object.keys(definition as unknown as Record<string, unknown>);
    expect(keys).not.toContain("approvalRule");
    expect(keys.filter((key) => key.toLowerCase().includes("approval"))).toEqual([]);
  });

  it("apply 返回 disposer，调用即注销工具（ctx 副作用可逆）", () => {
    const harness = createHarness();
    // 桩 registry 的 register 记录“已注册”，disposer 记录“已注销”，
    // 两者都经过同一个可变槽位，才能观察注销是否真的发生。
    expect(harness.isRegistered()).toBe(true);
    harness.dispose();
    expect(harness.isRegistered()).toBe(false);
  });
});

// ───────────────────────── C. 校验失败的结构化错误 ─────────────────────────

describe("C. 六道硬校验在启动任何子代理之前完成", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["items 少于 2", { items: ["only-one"] }, "ITEMS_TOO_FEW"],
    ["items 超过 128", { items: Array.from({ length: 129 }, (_, i) => `item-${String(i)}`) }, "TOO_MANY_SUBAGENTS"],
    ["有 items 无 template", { prompt_template: "" }, "PROMPT_TEMPLATE_REQUIRED"],
    ["template 缺占位符", { prompt_template: "no placeholder here" }, "PROMPT_TEMPLATE_PLACEHOLDER_MISSING"],
    ["展开后 prompt 重复", { items: ["same", "same "] }, "DUPLICATE_PROMPTS"],
  ];

  it.each(cases)("%s → 抛结构化错误且不派发任何子代理", async (_label, args, code) => {
    const harness = createHarness();
    await expect(harness.definition.execute(validArgs(args), makeExec() as never)).rejects.toMatchObject({
      name: "SwarmValidationError",
      swarmErrorCode: code,
    });
    expect(harness.startCalls).toHaveLength(0);
  });

  it("校验失败带机器可读 details", async () => {
    const harness = createHarness();
    await expect(
      harness.definition.execute(validArgs({ items: ["a"] }), makeExec() as never),
    ).rejects.toMatchObject({
      swarmErrorCode: "ITEMS_TOO_FEW",
      swarmErrorDetails: { itemCount: 1, min: 2 },
    });
  });

  it("config.maxItems 只能把硬上限调低，调低后按策略上限拒绝且不派发子代理", async () => {
    const items = Array.from({ length: 5 }, (_, i) => `item-${String(i)}`);
    const ctx = new Context() as unknown as Context & Record<string, unknown>;
    let definition: ToolDefinition | undefined;
    const startCalls: unknown[] = [];
    Object.defineProperty(ctx, "tools", {
      configurable: true,
      value: { register: (def: ToolDefinition) => void (definition = def) },
    });
    Object.defineProperty(ctx, "subagents", {
      configurable: true,
      value: { start: (...args: unknown[]) => void startCalls.push(args) },
    });
    // maxItems=3 低于 128 硬上限 → 生效值为 3
    plugin.apply(ctx, { ...defaultConfig(), maxItems: 3 });
    if (definition === undefined) throw new Error("not registered");
    await expect(
      definition.execute(
        validArgs({ items }),
        makeExec() as never,
      ),
    ).rejects.toMatchObject({
      name: "SwarmValidationError",
      swarmErrorCode: "TOO_MANY_SUBAGENTS",
      swarmErrorDetails: { total: 5, max: 3 },
    });
    expect(startCalls).toHaveLength(0);
  });

  it("config.maxItems 调高无效：128 硬上限不可绕过", async () => {
    const items = Array.from({ length: 129 }, (_, i) => `item-${String(i)}`);
    const harness = createHarness();
    const ctx = harness.ctx as unknown as Context & Record<string, unknown>;
    // 用一个把 maxItems 调到 999 的 config 重新注册
    let definition: ToolDefinition | undefined;
    const startCalls: unknown[] = [];
    Object.defineProperty(ctx, "tools", {
      configurable: true,
      value: { register: (def: ToolDefinition) => void (definition = def) },
    });
    Object.defineProperty(ctx, "subagents", {
      configurable: true,
      value: { start: (...args: unknown[]) => void startCalls.push(args) },
    });
    plugin.apply(ctx, { ...defaultConfig(), maxItems: 999 });
    if (definition === undefined) throw new Error("not registered");
    await expect(
      definition.execute(validArgs({ items }), makeExec() as never),
    ).rejects.toMatchObject({ swarmErrorCode: "TOO_MANY_SUBAGENTS" });
    expect(startCalls).toHaveLength(0);
  });


  it("F2 回归：连续两次 apply 后 stream 仍读到新 tool 执行的帧", async () => {
    const harness = createHarness();
    const ctx = harness.ctx;

    // 第一次 apply 已在 createHarness() 中完成
    const remote = ctx.get("swarmRemote") as any;
    expect(remote).toBeDefined();

    // 开启 stream 监听
    const ac = new AbortController();
    const frames: any[] = [];
    const streamPromise = (async () => {
      for await (const frame of remote.roster({ sessionId: "session-under-test" }, ac.signal)) {
        frames.push(frame);
        if (frame.type === "roster" && frame.completedCount === 2) break;
      }
    })();

    // 第二次 apply（重入/配置更新）
    let secondToolDef: ToolDefinition | undefined;
    Object.defineProperty(ctx, "tools", {
      configurable: true,
      value: {
        register: (def: ToolDefinition) => {
          secondToolDef = def;
          return () => {};
        },
      },
    });
    plugin.apply(ctx, { ...defaultConfig(), firstWave: 10 });
    expect(secondToolDef).toBeDefined();

    // 用第二次 apply 注册出的 tool 执行任务
    await secondToolDef!.execute(
      validArgs({ description: "Second apply batch", items: ["A", "B"] }),
      makeExec() as never,
    );

    await streamPromise;
    ac.abort();

    const rosterFrames = frames.filter((f) => f.type === "roster");
    const lastRoster = rosterFrames[rosterFrames.length - 1];
    expect(lastRoster).toBeDefined();
    expect(lastRoster?.description).toBe("Second apply batch");
    expect(lastRoster?.total).toBe(2);
    expect(lastRoster?.completedCount).toBe(2);
  });

  it("缺父 agent 时明确报错", async () => {
    const harness = createHarness();
    const exec = { callId: "c", name: "agent_swarm", signal: new AbortController().signal };
    await expect(harness.definition.execute(validArgs(), exec as never)).rejects.toThrow(
      /requires a calling agent/,
    );
  });
});

// ───────────────────────── D. 派发红线 ─────────────────────────

describe("D. 派发红线", () => {
  it("start 收到的字段：parent=exec.agent、prompt 文本块、label、signal；无 timeout", async () => {
    const harness = createHarness();
    await harness.definition.execute(validArgs(), makeExec() as never);
    expect(harness.startCalls).toHaveLength(3);
    const first = harness.startCalls[0] as StartCall;
    expect(first.provider).toBe("spawn");
    expect(first.request.parent).toBe(FAKE_AGENT);
    expect(first.request.prompt).toEqual([
      { type: "text", text: "Review a.md and report findings." },
    ]);
    expect(typeof first.request.label).toBe("string");
    expect(first.request.signal).toBeInstanceOf(AbortSignal);
    // start 请求没有 timeout 字段（spike Q2.2）
    expect(first.request).not.toHaveProperty("timeout");
  });

  it("每个 start 成功都配对一次 dispose", async () => {
    const harness = createHarness();
    await harness.definition.execute(validArgs(), makeExec() as never);
    expect(harness.startCalls).toHaveLength(3);
    expect(harness.disposeCount).toBe(3);
  });

  it("run.result reject 时仍配对 dispose（finally）", async () => {
    const harness = createHarness({ rejectResultAt: [0, 1, 2] });
    await harness.definition.execute(validArgs(), makeExec() as never);
    expect(harness.disposeCount).toBe(3);
  });

  it("start() 抛错时没有 run，不应 dispose，但该成员记为 failed", async () => {
    const harness = createHarness({ failStartAt: [1] });
    const result = (await harness.definition.execute(validArgs(), makeExec() as never)) as { xml: string };
    // 成功 start 的两个成员各 dispose 一次；失败的那个没有 run
    expect(harness.disposeCount).toBe(2);
    expect(result.xml).toContain('outcome="failed"');
  });

  it("单任务超时信号 = AbortSignal.any([批次信号, 超时])，父中断能级联到成员", async () => {
    const controller = new AbortController();
    const harness = createHarness();
    const pending = harness.definition.execute(validArgs(), makeExec(controller.signal) as never);
    await vi.waitFor(() => {
      expect(harness.startCalls.length).toBeGreaterThan(0);
    });
    // 父 signal 被中断 → start 收到的 signal 应随之 abort（级联）
    const memberSignal = (harness.startCalls[0] as StartCall).request.signal as AbortSignal;
    expect(memberSignal.aborted).toBe(false);
    controller.abort();
    await vi.waitFor(() => {
      expect(memberSignal.aborted).toBe(true);
    });
    await pending;
  });

  it("回归 F1：taskTimeoutMs<=0 时不拼 AbortSignal.timeout，成员信号就是批次信号", async () => {
    // 修复前：无条件 AbortSignal.timeout(0) 会在一个微任务后 abort，
    // 等于把每个成员秒杀成 aborted（配置成"不超时"反而全灭）。
    const controller = new AbortController();
    const ctx = new Context() as unknown as Context & Record<string, unknown>;
    let definition: ToolDefinition | undefined;
    const startCalls: StartCall[] = [];
    Object.defineProperty(ctx, "tools", {
      configurable: true,
      value: { register: (def: ToolDefinition) => void (definition = def) },
    });
    Object.defineProperty(ctx, "subagents", {
      configurable: true,
      value: {
        start: (provider: string, request: Record<string, unknown>) => {
          startCalls.push({ provider, request });
          const signal = request.signal as AbortSignal;
          return Promise.resolve({
            id: `run-${String(startCalls.length)}`,
            localAgent: undefined,
            // 挂起直到被 abort，这样断言期间 attempt 仍存活，级联可观测。
            // 时序本身就是回归证据：若修复前拼了 AbortSignal.timeout(0)，
            // 每个成员会在一个微任务后被 abort，永远走不到 completed。
            result: new Promise((resolve) => {
              const finish = (): void => {
                resolve({
                  output: [{ type: "text", text: "ok" }],
                  stopReason: signal.aborted ? "aborted" : "completed",
                });
              };
              if (signal.aborted) {
                finish();
                return;
              }
              signal.addEventListener("abort", finish, { once: true });
            }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    });
    // taskTimeoutMs = 0 表示"不设单任务超时"
    plugin.apply(ctx, { ...defaultConfig(), taskTimeoutMs: 0 });
    if (definition === undefined) throw new Error("not registered");
    const pending = definition.execute(validArgs(), makeExec(controller.signal) as never) as Promise<{
      xml: string;
    }>;

    // 等所有成员真正派发出去（此时它们仍挂在 signal 上等待）
    await vi.waitFor(() => {
      expect(startCalls).toHaveLength(3);
    });
    const memberSignal = (startCalls[0] as StartCall).request.signal as AbortSignal;

    // 关键断言：signal 没有被自动 abort。
    // 修复前无条件 AbortSignal.timeout(0) 会让信号在一��微任务后变 aborted，
    // 配置成「不超时」反而把每个成员秒杀——这里就是那道护栏。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(memberSignal.aborted).toBe(false);

    // 父中断依然能级联到成员（成员信号派生自批次信号，不是独立信号）
    controller.abort();
    expect(memberSignal.aborted).toBe(true);

    // 三个成员都落在 aborted 档（批次级中断），而不是 completed。
    // 这同时说明：它们是被我们**手动**中断的，而不是被一个 0ms 超时秒杀——
    // 若修复前拼了 AbortSignal.timeout(0)，在 controller.abort() 之前它们早已 aborted。
    const result = await pending;
    expect(result.xml).toContain("<summary>aborted: 3</summary>");
  });

  it("回归 F2：taskTimeoutMs 透传给调度器，超时成员落 Subagent timed out. 文案", async () => {
    // 修复前：runSwarm 没接 timeoutMs，调度器永远不会打出这句文案。
    const ctx = new Context() as unknown as Context & Record<string, unknown>;
    let definition: ToolDefinition | undefined;
    Object.defineProperty(ctx, "tools", {
      configurable: true,
      value: { register: (def: ToolDefinition) => void (definition = def) },
    });
    Object.defineProperty(ctx, "subagents", {
      configurable: true,
      value: {
        start: (_provider: string, request: Record<string, unknown>) =>
          Promise.resolve({
            id: "run-timeout",
            localAgent: undefined,
            // 只有被 abort 才会 settle：真实 provider 在 signal 触发后返回 aborted。
            // 修复前这里用永不 settle 的 Promise，会让用例超时而非验证文案。
            result: new Promise((resolve) => {
              (request.signal as AbortSignal).addEventListener(
                "abort",
                () => resolve({ output: [], stopReason: "aborted" }),
                { once: true },
              );
            }),
            dispose: () => Promise.resolve(),
          }),
      },
    });
    // 很短的超时，让调度器的闸门先于任何真实完成触发
    plugin.apply(ctx, { ...defaultConfig(), taskTimeoutMs: 10 });
    if (definition === undefined) throw new Error("not registered");
    const result = (await definition.execute(validArgs(), makeExec() as never)) as { xml: string };
    expect(result.xml).toContain("Subagent timed out.");
    expect(result.xml).toContain('<summary>failed: 3</summary>');
  });

  it("stopReason=aborted 归取消，绝不触发限流重排队", async () => {
    const harness = createHarness({ stopReasons: ["aborted", "completed", "completed"] });
    const result = (await harness.definition.execute(validArgs(), makeExec() as never)) as { xml: string };
    // 只 start 一次/成员（没有重排队 → 没有额外的 start 调用）
    expect(harness.startCalls).toHaveLength(3);
    // aborted 成员如实落在 XML 里：判为 failed 且 stop_reason 记为 aborted。
    // 一期不做"取消 vs 失败"的 outcome 细分（调度器只认 completed/failed/aborted
    // 三档，而取消在结果级与失败同形），所以断言失败档 + stop_reason 即可。
    // 刻意不用整串 toContain：属性集合会随功能扩展变化（agent_id 正是本轮新增的，
    // 以后还可能加 mode/耗时等），整串比较会把"属性多了/少了"这种无语义差异变成回归噪音。
    // 改为先按正则定位成员元素，再逐项断言真正关心的语义：身份、相位、结局、正文、agent_id。
    // 说明：失败路径不产出 stop_reason 属性（scheduler 的 #failedResult 只带
    // spec/outcome/state/agentId/error），aborted 这个 stopReason 只体现在失败正文里，
    // 因此这里不对 stop_reason 做断言。
    const abortedElement = /<subagent\b[^>]*>aborted<\/subagent>/.exec(result.xml)?.[0];
    expect(abortedElement).toBeDefined();
    const element = abortedElement as string;
    expect(element).toContain('item="a.md"');
    expect(element).toContain('state="started"');
    expect(element).toContain('outcome="failed"');
    // 开标签与闭标签之间的正文必须是 aborted 原文
    expect(/<subagent\b[^>]*>([\s\S]*)<\/subagent>/.exec(element)?.[1]).toBe("aborted");
    // agent_id 为本轮新增属性；实测值 run-0（harness 桩按 start 调用序返回 run-<n>）
    expect(element).toContain('agent_id="run-0"');
  });
});

// ───────────────────────── E. 失败聚合与 XML ─────────────────────────

describe("E. 收齐全部结果再渲染，个别失败不拖垮整次调用", () => {
  it("部分成员失败时 execute 仍然成功返回，XML 如实分列成败", async () => {
    const harness = createHarness({ stopReasons: ["completed", "error", "completed"] });
    const result = (await harness.definition.execute(validArgs(), makeExec() as never)) as { xml: string };
    expect(result.xml).toContain("<agent_swarm_result>");
    expect(result.xml).toContain("<summary>completed: 2, failed: 1</summary>");
    expect(result.xml).toContain('outcome="completed"');
    expect(result.xml).toContain('outcome="failed"');
  });

  it("全部失败也不抛：execute 返回 XML，由模型读结果决定下一步", async () => {
    const harness = createHarness({ stopReasons: ["error", "error", "error"] });
    const result = (await harness.definition.execute(validArgs(), makeExec() as never)) as { xml: string };
    expect(result.xml).toContain("<summary>failed: 3</summary>");
  });

  it("成员编号与 items 顺序一致，1 起始", async () => {
    const harness = createHarness();
    const result = (await harness.definition.execute(validArgs(), makeExec() as never)) as { xml: string };
    expect(result.xml).toContain('item="a.md"');
    expect(result.xml).toContain('item="b.md"');
    expect(result.xml).toContain('item="c.md"');
  });

  it("成员输出含 XML 特殊字符时被转义，不破坏结构", async () => {
    const ctx = new Context() as unknown as Context & Record<string, unknown>;
    let definition: ToolDefinition | undefined;
    Object.defineProperty(ctx, "tools", {
      configurable: true,
      value: { register: (def: ToolDefinition) => void (definition = def) },
    });
    Object.defineProperty(ctx, "subagents", {
      configurable: true,
      value: {
        start: (_p: string, request: Record<string, unknown>) => {
          const text = String((request.prompt as Array<{ text: string }>)[0]?.text ?? "");
          return Promise.resolve({
            id: "run-x",
            localAgent: undefined,
            result: Promise.resolve({
              output: [{ type: "text", text: `5 < 6 & 7 > 3 for ${String(text)}` }],
              stopReason: "completed",
            }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    });
    plugin.apply(ctx, defaultConfig());
    if (definition === undefined) throw new Error("not registered");
    const result = (await definition.execute(validArgs(), makeExec() as never)) as { xml: string };
    expect(result.xml).toContain("&lt;");
    expect(result.xml).toContain("&amp;");
    // 结构仍然完整：3 个成员 + 收尾标签
    expect(result.xml.match(/<subagent /g)).toHaveLength(3);
    expect(result.xml.trimEnd().endsWith("</agent_swarm_result>")).toBe(true);
  });
});

// ───────────────────────── F. 真实 Loader 加载路径 ─────────────────────────

describe("F. 真实 Loader 加载路径", () => {
  /**
   * 走 cordis-plugin-loader 的真实加载路径：Entry.create → _init → import
   * → unwrapExports → registry.plugin → apply。
   *
   * 唯一被替换的是**模块装载**这一步：Loader 的 seam 换成直接 import 本仓的
   * **真实构建产物** dist/index.js（生产上 DSH 加载的就是它），并把它的具名导出
   * 交回 Loader；解包（unwrapExports）、注册、激活、卸载全部是 Loader 的真实实现。
   */
  it("cordis-plugin-loader 真实加载插件，激活后工具可用、卸载后消失", async () => {
    const root = new Context();
    const loaderCtx = root.plugin(Loader, {});
    await loaderCtx;

    const loader = root.get("loader") as unknown as {
      internal: unknown;
      create: (options: { name: string; config?: unknown }) => Promise<string>;
      remove: (id: string) => void;
      resolve: (id: string) => { fiber?: { inertia?: Promise<unknown> } };
      await: () => Promise<void>;
    };
    // 用真实 seam 替换模块装载：加载**真实构建产物** dist/index.js，
    // 把它的具名导出原样交回 Loader（经 unwrapExports 处理），
    // 不再像以前那样手写一个只含 4 个具名导出的伪命名空间——那会绕过
    // unwrapExports，让 AGENTS.md 红线「绝不写 export default」无人守护。
    //
    // 关键：apply 仍需是**全新的函数引用**。Cordis 的插件注册表以 apply 函数本身
    // 作为注册表键（registry.resolve → plugin.apply）；而 ESM 模块缓存让
    // import("../dist/index.js") 每次都返回**同一个**命名空间对象（同一份 apply
    // 引用）。真实运行时每个 entry 是一次全新 import，拿到全新模块实例与其全新
    // apply；同进程内我们无法复刻"全新模块实例"，于是保留这层最小薄包装
    // 转发调用来造出全新 apply 引用——export 本身取自真实 dist/index.js。
    const dist = (await import("../dist/index.js")) as typeof plugin;
    (loader as { internal: unknown }).internal = {
      import: async () => ({
        name: dist.name,
        inject: dist.inject,
        Config: dist.Config,
        apply: (ctx: Context, config: Parameters<typeof dist.apply>[1]) => dist.apply(ctx, config),
      }),
    };

    // 桩服务：注册表记录已注册工具，disposer 把它摘掉。
    const registered: ToolDefinition[] = [];
    root.provide("tools", {
      register: (def: ToolDefinition) => {
        registered.push(def);
        return () => {
          const index = registered.indexOf(def);
          if (index >= 0) registered.splice(index, 1);
        };
      },
    });
    root.provide("subagents", { start: () => Promise.reject(new Error("unused in this test")) });

    const entryId = await loader.create({ name: "dsh-agent-swarm", config: defaultConfig() });
    expect(entryId).toBeTruthy();
    // create 只登记条目；import → apply 是异步的，等它落定再断言。
    await loader.await();

    // 插件已激活：Loader 解包具名导出并调用了 apply，工具已注册。
    expect(registered.map((def) => def.name)).toEqual(["agent_swarm"]);

    // 卸载该 entry → 插件 fiber dispose → apply 返回的 disposer 注销工具。
    // 这正是 Cordis 记录的可逆副作用：dispose 链最终走到 ctx.tools.register 的 disposer。
    //
    // 注意时序：Loader.remove 内部只发起 fiber.dispose()（不 await）；而 dispose 链是
    // 异步落定的，fiber.inertia 才是"卸载真正完成"的信号。必须等 inertia，否则读到的是
    // "已发起卸载"而非"已注销"。
    const fiber = loader.resolve(entryId).fiber;
    loader.remove(entryId);
    await fiber?.inertia;
    expect(registered).toHaveLength(0);

    // 再卸载 Loader 服务本身，确认没有残留注册。
    await loaderCtx.dispose();
    expect(registered).toHaveLength(0);
  });

  it("node 直接 import 断言导出形态（Loader 路径的独立交叉验证）", async () => {
    const loaded = (await import("../src/index.js")) as Record<string, unknown>;
    expect(loaded.name).toBe("agent-swarm");
    expect(typeof loaded.apply).toBe("function");
    expect(typeof loaded.Config).toBe("function");
    expect(loaded.default).toBeUndefined();
    // inject 必须恰好是两个服务键，且不含任何审批元数据
    expect(loaded.inject).toEqual(["tools", "subagents"]);
  });

  it("真实构建产物 dist/index.js 同样只用具名导出，绝不 export default（红线）", async () => {
    // 直接守 AGENTS.md 红线：生产实际加载的 dist/index.js 若出现 default 导出，
    // Loader 会走 unwrapExports 分支掩盖真实缺陷。这里对构建产物断言。
    const dist = (await import("../dist/index.js")) as Record<string, unknown>;
    expect("default" in dist).toBe(false);
    expect(dist.name).toBe("agent-swarm");
    expect(typeof dist.apply).toBe("function");
    expect(typeof dist.Config).toBe("function");
    expect(dist.inject).toEqual(["tools", "subagents"]);
  });
});

// ───────────────────────── G. WP-C2：中断 / 失败 / 超时三类收场的 registry 与 XML 同结论 ─────────────────────────

/**
 * 读取插件自己持有的 registry（走真实接线：apply 里的 ctx.get("swarmRemote")）。
 * 这里断言的是**对外可见的成员相位与批次状态**，不是内部方法有没有被调用。
 */
function registryOf(ctx: Context): SwarmRegistry {
  const remote = ctx.get("swarmRemote") as unknown as { getRegistry?: () => SwarmRegistry } | undefined;
  const registry = remote?.getRegistry?.();
  if (registry === undefined) throw new Error("swarmRemote is not wired on this context");
  return registry;
}

/** 最新批次的成员相位，按 index 升序（与 XML 里各成员的顺序一致）。 */
function phasesOf(batch: SwarmBatch | undefined): SwarmPhase[] {
  if (batch === undefined) return [];
  return [...batch.members.values()].sort((a, b) => a.index - b.index).map((member) => member.phase);
}

function latestBatchOf(ctx: Context): SwarmBatch | undefined {
  // 会话 id 与 makeExec() 里 FAKE_AGENT.session.id 一致
  return registryOf(ctx).getLatestBatch("session-under-test");
}

/**
 * "只受信号驱动"的 provider 桩：start 返回的 run.result 一直挂着，直到成员信号 abort 才收场。
 * 这样测到的是"成员已经在跑、随后批次被中断"的真实时序，而不是"还没跑起来就被放弃"
 * （后者走调度器 onAbandoned 路径，根本到不了宿主侧 catch）。
 */
function createSignalDrivenHarness(options: {
  /** run.result 在成员信号 abort 后的收场方式。 */
  settle: "reject" | "resolve-aborted";
  /** 传给 apply 的单任务超时（0 = 不设超时）。 */
  taskTimeoutMs: number;
  /** 首个成员不等待信号、立刻因自身原因失败（用于"先失败、后中断"的到达顺序）。 */
  firstFailsImmediately?: boolean;
}): { ctx: Context; definition: ToolDefinition; memberSignals: AbortSignal[] } {
  const ctx = new Context() as unknown as Context & Record<string, unknown>;
  const memberSignals: AbortSignal[] = [];
  let definition: ToolDefinition | undefined;

  Object.defineProperty(ctx, "tools", {
    configurable: true,
    value: {
      register: (def: ToolDefinition) => {
        definition = def;
        return () => {
          definition = undefined;
        };
      },
    },
  });

  Object.defineProperty(ctx, "subagents", {
    configurable: true,
    value: {
      start: (_provider: string, request: Record<string, unknown>) => {
        const signal = request.signal as AbortSignal;
        memberSignals.push(signal);
        return Promise.resolve({
          id: "run-" + String(memberSignals.length),
          localAgent: undefined,
          result: new Promise((resolve, reject) => {
            if (options.firstFailsImmediately === true && memberSignals.length === 1) {
              reject(new Error("member 1 failed on its own before any interrupt"));
              return;
            }
            const settle = (): void => {
              if (options.settle === "resolve-aborted") {
                resolve({ output: [], stopReason: "aborted" });
                return;
              }
              reject(new Error("run.result rejected after the swarm was interrupted"));
            };
            if (signal.aborted) {
              settle();
              return;
            }
            signal.addEventListener("abort", settle, { once: true });
          }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  });

  plugin.apply(ctx, { ...defaultConfig(), taskTimeoutMs: options.taskTimeoutMs });
  if (definition === undefined) throw new Error("apply() did not register a tool");
  return { ctx, definition, memberSignals };
}

describe("G. WP-C2：中断 / 失败 / 超时三类收场的结论一致性", () => {
  it("① 批次中断后在跑成员以 reject 收场 → 成员 aborted、批次 aborted、XML aborted", async () => {
    const harness = createSignalDrivenHarness({ settle: "reject", taskTimeoutMs: 0 });
    const controller = new AbortController();
    const pending = harness.definition.execute(
      validArgs({ items: ["a.md", "b.md"] }),
      makeExec(controller.signal) as never,
    ) as Promise<{ xml: string }>;

    // 前置条件：两个成员都已真正在跑（registry 相位 running = 已 markReady），此刻才中断。
    // 未 ready 的尝试由调度器 onAbandoned 直接落 aborted，走不到宿主侧 catch——必须排掉。
    await vi.waitFor(() => {
      expect(phasesOf(latestBatchOf(harness.ctx))).toEqual(["running", "running"]);
    });

    controller.abort();
    const result = await pending;

    // XML（权威口径）：成员与 summary 都落在 aborted
    expect(result.xml).toContain("<summary>aborted: 2</summary>");
    expect(result.xml).toContain('outcome="aborted"');
    expect(result.xml).not.toContain('outcome="failed"');

    // registry：成员相位与批次状态必须与 XML 同结论
    const batch = latestBatchOf(harness.ctx);
    expect(batch?.status).toBe("aborted");
    expect(phasesOf(batch)).toEqual(["aborted", "aborted"]);
    // 终态 detail 仍然透传 reject 的原因（修复不得顺手丢掉它）。
    // 成员索引自 1 起（与 XML 编号一致），故取 members.get(1)。
    expect(batch?.members.get(1)?.detail).toContain("rejected after the swarm was interrupted");
  });

  it("② 纯失败（无中断）→ 成员 failed、批次 failed、XML failed（防过度修复）", async () => {
    const harness = createHarness({ rejectResultAt: [0, 1, 2] });
    const result = (await harness.definition.execute(validArgs(), makeExec() as never)) as { xml: string };

    expect(result.xml).toContain("<summary>failed: 3</summary>");
    expect(result.xml).not.toContain('outcome="aborted"');

    const batch = latestBatchOf(harness.ctx);
    expect(batch?.status).toBe("failed");
    expect(phasesOf(batch)).toEqual(["failed", "failed", "failed"]);
    expect(batch?.members.get(1)?.detail).toContain("infrastructure fault");
  });

  it("④ 先失败、后中断：已落定的失败不被随后的中断改写（另一种到达顺序）", async () => {
    const harness = createSignalDrivenHarness({
      settle: "reject",
      taskTimeoutMs: 0,
      firstFailsImmediately: true,
    });
    const controller = new AbortController();
    const pending = harness.definition.execute(
      validArgs({ items: ["a.md", "b.md"] }),
      makeExec(controller.signal) as never,
    ) as Promise<{ xml: string }>;

    // 等成员① 自己失败并落定，成员② 仍在跑——此刻中断才是"后到"
    await vi.waitFor(() => {
      expect(phasesOf(latestBatchOf(harness.ctx))).toEqual(["failed", "running"]);
    });

    controller.abort();
    const result = await pending;

    expect(result.xml).toContain("<summary>failed: 1, aborted: 1</summary>");
    expect(result.xml).toContain('outcome="failed"');
    expect(result.xml).toContain('outcome="aborted"');

    const batch = latestBatchOf(harness.ctx);
    expect(phasesOf(batch)).toEqual(["failed", "aborted"]);
    expect(batch?.status).toBe("failed");
    // 成员① 的 detail 仍是它自己的失败原因，没有被中断文案覆写
    expect(batch?.members.get(1)?.detail).toContain("failed on its own before any interrupt");
  });

  it("③a 超时（成员以 reject 收场）→ 成员 failed、批次 failed、XML failed，不误判成 aborted", async () => {
    const harness = createSignalDrivenHarness({ settle: "reject", taskTimeoutMs: 20 });
    const result = (await harness.definition.execute(
      validArgs({ items: ["a.md", "b.md"] }),
      makeExec() as never,
    )) as { xml: string };

    expect(result.xml).toContain("<summary>failed: 2</summary>");
    expect(result.xml).toContain("Subagent timed out.");
    expect(result.xml).not.toContain('outcome="aborted"');

    // 判别式为什么不看成员信号：调度器自己的超时闸门会 abort 成员信号，
    // reason 就是它写的那句超时文案——"超时"在成员信号上与"批次中断"完全同形。
    expect(harness.memberSignals[0]?.aborted).toBe(true);
    expect(String((harness.memberSignals[0]?.reason as Error | undefined)?.message)).toMatch(/timed out/i);

    const batch = latestBatchOf(harness.ctx);
    expect(batch?.status).toBe("failed");
    expect(phasesOf(batch)).toEqual(["failed", "failed"]);
  });

  it("③b 超时（成员优雅自报 aborted）→ 成员 failed、批次 failed、XML failed", async () => {
    const harness = createSignalDrivenHarness({ settle: "resolve-aborted", taskTimeoutMs: 20 });
    const result = (await harness.definition.execute(
      validArgs({ items: ["a.md", "b.md"] }),
      makeExec() as never,
    )) as { xml: string };

    // 子代理自报 "aborted" 只说明它被取消，不说明**批次**被打断；XML 侧这条路径是 failed。
    expect(result.xml).toContain("<summary>failed: 2</summary>");
    expect(result.xml).toContain('outcome="failed"');
    expect(result.xml).not.toContain('outcome="aborted"');

    const batch = latestBatchOf(harness.ctx);
    expect(batch?.status).toBe("failed");
    expect(phasesOf(batch)).toEqual(["failed", "failed"]);
    // 自报的原因没丢，只是相位与 XML 对齐成 failed
    expect(batch?.members.get(1)?.detail).toContain("aborted");
  });
});

// ───────────────────────── H. WP-P2-2：宿主终态映射与 XML 渲染同结论 ─────────────────────────

/** 从 XML 按渲染顺序取出每个成员的 (item, outcome)，供与 registry 相位逐项对照。 */
function memberOutcomesFromXml(xml: string): Array<{ item: string; outcome: string }> {
  return [...xml.matchAll(/<subagent\b([^>]*)>/g)].map((match) => {
    const attrs = match[1] ?? "";
    return {
      item: /item="([^"]*)"/.exec(attrs)?.[1] ?? "",
      outcome: /outcome="([^"]*)"/.exec(attrs)?.[1] ?? "",
    };
  });
}

/** registry 侧的同一批成员，按 index 升序（= XML 各成员的渲染顺序）。 */
function memberPhasesOf(batch: SwarmBatch | undefined): Array<{ item: string; outcome: string }> {
  if (batch === undefined) return [];
  return [...batch.members.values()]
    .sort((a, b) => a.index - b.index)
    .map((member) => ({ item: member.item, outcome: member.phase }));
}

describe("H. WP-P2-2：内部结局经宿主映射后与 XML 渲染同结论", () => {
  it("completed 档与 cancelled（批次中断、成员尚未启动）档：逐成员相位与 XML outcome 一致", async () => {
    // ① completed 档：成员真的跑完 → 走宿主 toSettledPhase 的 completed 分支
    const completedHarness = createHarness();
    const completedRun = (await completedHarness.definition.execute(
      validArgs(),
      makeExec() as never,
    )) as { xml: string };
    expect(memberOutcomesFromXml(completedRun.xml).map((member) => member.outcome)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    // 同一输入：宿主经 helper 落到 registry 的相位，必须与 XML 渲染出的 outcome 逐成员同结论
    expect(memberOutcomesFromXml(completedRun.xml)).toEqual(
      memberPhasesOf(latestBatchOf(completedHarness.ctx)),
    );

    // ② cancelled 档：批次在任何成员启动之前就已被中断——这些成员只能经调度器
    //    onAbandoned（outcome: "cancelled"）落终态，也就是宿主 toSettledPhase 的 cancelled 分支。
    const interruptedHarness = createHarness();
    const controller = new AbortController();
    controller.abort();
    const interruptedRun = (await interruptedHarness.definition.execute(
      validArgs(),
      makeExec(controller.signal) as never,
    )) as { xml: string };
    // 前置条件：一个成员都没启动（否则测到的是"成员已在跑"的另一条路径）
    expect(interruptedHarness.startCalls).toHaveLength(0);
    expect(memberOutcomesFromXml(interruptedRun.xml).map((member) => member.outcome)).toEqual([
      "aborted",
      "aborted",
      "aborted",
    ]);
    expect(memberOutcomesFromXml(interruptedRun.xml)).toEqual(
      memberPhasesOf(latestBatchOf(interruptedHarness.ctx)),
    );
  });
});

// ───────────────────────────────────── I. WP-P2-6：描述上限与运行时校验同源 ───────────────────────────────

/**
 * 模型能看见的两份文案：工具描述与参数 items 描述。
 * 两者都必须写**生效上限**，而非协议常量 128。
 */
function descriptionsOf(definition: ToolDefinition): { tool: string; items: string } {
  return {
    tool: definition.description,
    items: (definition.parameters as { properties: { items: { description: string } } }).properties.items
      .description,
  };
}

describe("I. WP-P2-6：策略上限与工具描述联动", () => {
  it("① maxItems=10：工具描述与参数描述都写 10，不存在“可提交 128 条”的误导表述", () => {
    // 修复前的病态：描述写死常量 128，模型照 128 规划，然后被第 11 条拒掉。
    const { definition } = createHarness({ config: { ...defaultConfig(), maxItems: 10 } });
    const { tool, items } = descriptionsOf(definition);

    // 两份文案的可提交上界各自写 10（工具描述说 "at most 10 entries"，
    // 参数描述说 "at least 2 and at most 10 entries"）——两者不得分叉。
    expect(tool).toContain("items must contain at most 10 entries.");
    expect(items).toContain("at least 2 and at most 10 entries.");
    // 工具描述另一处数量（N 的范围）也跟着调低
    expect(tool).toContain("N (2 to 10)");

    for (const text of [tool, items]) {
      // 任何把 128 写成"可提交上限"的表述都不得存在
      expect(text).not.toMatch(/at most 128/);
      expect(text).not.toMatch(/N \\(2 to 128\\)/);
      // 但协议硬上限的说明必须保留：它解释的是"宿主为什么只能调低"
      expect(text).toContain("protocol hard limit is 128");
      expect(text).toContain("cannot be raised");
      // 且必须明说本部署生效值，避免把 128 误读成本部署上限
      expect(text).toMatch(/effective limit on this deployment is 10|host can only lower the cap, and more than 10/);
    }
  });

  it("② maxItems=10：传 11 条时报错的 details.max 与描述里的上限完全一致", async () => {
    // 同一个数字同时出现在文案与错误 details 里，才算"描述 == 校验"。
    const harness = createHarness({ config: { ...defaultConfig(), maxItems: 10 } });
    const items = Array.from({ length: 11 }, (_, i) => `item-${String(i)}`);
    await expect(
      harness.definition.execute(validArgs({ items }), makeExec() as never),
    ).rejects.toMatchObject({
      name: "SwarmValidationError",
      swarmErrorCode: "TOO_MANY_SUBAGENTS",
      swarmErrorDetails: { total: 11, max: 10 },
    });
    // 拒绝发生在任何子代理启动之前
    expect(harness.startCalls).toHaveLength(0);

    // 把描述里的上限拿出来与 details.max 对照：两份文案写的是同一个数，
    // 而非仅似然相等的两个常量。
    const { tool, items: paramText } = descriptionsOf(harness.definition);
    const toolLimit = /at most (\d+) entries/.exec(tool)?.[1];
    const paramLimit = /at least \d+ and at most (\d+) entries/.exec(paramText)?.[1];
    expect(toolLimit).toBe("10");
    expect(paramLimit).toBe("10");
  });

  it("③ 默认配置（未设 maxItems）：描述写 128，且仍保留协议硬上限说明", () => {
    // 回归护栏：本次改动只能让描述跟随 maxItems，不能改动未设该项时的默认口径。
    // 这里走 Schema 解析的真实默认值（而非测试自己写的 defaultConfig）。
    const appliedConfig = (plugin.Config as (v?: unknown) => unknown)() as Parameters<
      typeof plugin.apply
    >[1];
    const effectiveMax = Math.min(appliedConfig.maxItems, SWARM_MAX_SUBAGENTS);
    expect(effectiveMax).toBe(SWARM_MAX_SUBAGENTS);

    const { definition } = createHarness({ config: appliedConfig });
    const { tool, items } = descriptionsOf(definition);
    expect(tool).toContain(`N (${String(SWARM_MIN_ITEMS)} to ${String(SWARM_MAX_SUBAGENTS)})`);
    expect(tool).toContain(`items must contain at most ${String(SWARM_MAX_SUBAGENTS)} entries.`);
    expect(items).toContain(
      `at least ${String(SWARM_MIN_ITEMS)} and at most ${String(SWARM_MAX_SUBAGENTS)} entries.`,
    );
    for (const text of [tool, items]) {
      expect(text).toContain("protocol hard limit is 128");
      expect(text).toContain("cannot be raised");
    }
  });

  it("④ maxItems 调高无效：生效上限仍是 128，不会把宿主拼的数写进描述", () => {
    // 协议常量不可绕过：文案必须与校验一样对 128 收敛，
    // 否则会出现"文案允许 999、校验只收 128"的新分叉。
    const { definition } = createHarness({ config: { ...defaultConfig(), maxItems: 999 } });
    const { tool, items } = descriptionsOf(definition);
    expect(tool).toContain("items must contain at most 128 entries.");
    expect(items).toContain("at least 2 and at most 128 entries.");
    for (const text of [tool, items]) {
      expect(text).not.toContain("999");
    }
  });
});
