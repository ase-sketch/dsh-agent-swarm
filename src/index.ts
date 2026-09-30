/**
 * dsh-agent-swarm — 插件集成层（DSH 依赖的唯一文件）
 *
 * 职责：把 M1 的纯函数层（validate → scheduler → result-xml）接到 DSH runtime 上。
 *   1. 声明插件元信息（name / inject / Config）与 apply(ctx, config)
 *   2. 通过 ctx.tools.register 注册 `agent_swarm` 工具
 *   3. 在 executor 内用 ctx.subagents.start 派发 one-shot 子代理
 *   4. 收齐全部结果后一次性渲染 XML 返回模型
 *
 * 本文件是 DSH 侧适配的唯一入口；M1 四个纯函数文件不依赖 DSH，保持可单测。
 *
 * 关键契约（docs/spike-dsh-api.md + 0.2.0-rc.2 实装类型双向核对）：
 *   - 命名导出 name / inject / Config / apply，**不写 export default**
 *   - inject 只需要 ["tools", "subagents"]：注册工具 + 派发子代理
 *   - ctx.subagents.start 返回的是 run 句柄，**成功 start 后必须 finally 配对 dispose()**，否则泄漏
 *   - start 请求无 timeout 字段：单任务超时自建 AbortSignal.any([父signal, AbortSignal.timeout])
 *   - stopReason "aborted" 归"取消"而非"限流"
 *   - 不设任何审批字段（spike Q8：无 approvalRule 机制，不调 ctx.approval 即不弹窗）
 */

import Schema from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
// ContentBlock 定义在 @deepseek-ai/dsh-llm（dsh-tools 的依赖）。我们不直接依赖它，
// 而是从本文件真正产出的那处声明反推结构类型，避免为一次类型注解新增一条依赖。
type ContentBlock = { type: "text"; text: string };
// `import type` 仍会把该包的 declare module 增强拉进编译单元：
// 它给 Context 增补了 `subagents: SubagentRuntime`，也导出 SubagentStartRequest。
import type { SubagentStartRequest } from "@deepseek-ai/dsh-subagent";
import {
  DEFAULT_SWARM_SCHEDULER_CONFIG,
  SWARM_ERROR_CODES,
  SWARM_MAX_SUBAGENTS,
  type SwarmAttemptContext,
  type SwarmAttemptResult,
  type SwarmRateLimitClass,
  type SwarmTaskResult,
  type SwarmTaskSpec,
  type SwarmValidationError,
} from "./types.js";
import { validateSwarmInput } from "./validate.js";
import { runSwarm } from "./scheduler.js";
import { renderSwarmResult } from "./result-xml.js";
import { SwarmRegistry } from "./swarm-registry.js";
import { SwarmRemote } from "./remote.js";

// ───────────────────────── 插件元信息 ─────────────────────────

export const name = "agent-swarm";

/**
 * 只申请两个服务：tools（注册工具）与 subagents（派发子代理）。
 * 刻意不声明 systemPrompt / sessionProjections，避免多拔奇这两个服务。
 */
export const inject = ["tools", "subagents"] as const;

/** 插件配置：provider、调度节奏、单任务超时、items 上限、子代理固定路由。 */
export const Config = Schema.object({
  /** 子代理 provider 名（不硬编码调用方，默认官方 spawn 进程内 provider）。 */
  provider: Schema.string().default("spawn"),
  /** 首波并发（照上游实测默认 5）。 */
  firstWave: Schema.natural().default(DEFAULT_SWARM_SCHEDULER_CONFIG.initialLaunchLimit),
  /** 首波之后每个任务的放量间隔（默认 700ms）。 */
  releaseIntervalMs: Schema.natural().default(DEFAULT_SWARM_SCHEDULER_CONFIG.initialLaunchIntervalMs),
  /** 限流退避基数（默认 3000ms × retryFactor^n）。 */
  backoffInitialMs: Schema.natural().default(DEFAULT_SWARM_SCHEDULER_CONFIG.retryBaseMs),
  /** 限流退避指数因子（默认 2）。 */
  retryFactor: Schema.natural().default(DEFAULT_SWARM_SCHEDULER_CONFIG.retryFactor),
  /** 容量收缩防抖间隔（默认 2000ms）。 */
  shrinkDebounceMs: Schema.natural().default(DEFAULT_SWARM_SCHEDULER_CONFIG.capacityShrinkDebounceMs),
  /** 容量恢复检查间隔（默认 180s 恢复 +1）。 */
  recoverIntervalMs: Schema.natural().default(DEFAULT_SWARM_SCHEDULER_CONFIG.capacityRecoveryIntervalMs),
  /** 单任务超时，默认 2h。start() 无 timeout 字段，由 AbortSignal.timeout 自建。 */
  taskTimeoutMs: Schema.natural().default(7_200_000),
  /**
   * items 数量上限（策略上限）。取 SWARM_MAX_SUBAGENTS 与本项的较小者作为生效值：
   * 硬校验 128 不可绕过（协议契约），本项只允许宿主把它**调低**，不允许调高。
   */
  maxItems: Schema.natural().default(SWARM_MAX_SUBAGENTS),
  /**
   * 子代理 LLM 路由（写死，不开 modelSelectionSettings，避免命中会话白名单拒绝）。
   * 不传 → 子代理自动继承父 agent 的 provider/model/effort/maxTokens。
   * 传了 → 需要 provider 声明 capabilities.agentOptions。
   */
  agentOptions: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
    reasoningEffort: Schema.string().min(1),
    maxTokens: Schema.natural().min(1),
  }), // 不给 .default()：schemastery 的对象属性本就可缺省，缺省即 undefined
});

/**
 * 父 Agent 的最小结构类型。
 * 直接取自 SubagentStartRequest["parent"]，避免为一个类型注解引入整个 dsh-agent 依赖。
 */
type SwarmParentAgent = SubagentStartRequest["parent"];

/**
 * 子代理路由覆盖。取自 SubagentStartRequest["agentOptions"] 的元素类型，
 * 保证 config 里存的字符串在 start() 处能被 DSH 的品牌类型接受。
 */
type SwarmAgentOptions = NonNullable<SubagentStartRequest["agentOptions"]>;

/** 插件配置解析后的形状（Config 已给全部字段默认值，apply 收到的就是完整配置）。 */
export interface SwarmPluginConfig {
  provider: string;
  firstWave: number;
  releaseIntervalMs: number;
  backoffInitialMs: number;
  retryFactor: number;
  shrinkDebounceMs: number;
  recoverIntervalMs: number;
  taskTimeoutMs: number;
  /** 生效的 items 上限 = min(config.maxItems, SWARM_MAX_SUBAGENTS)。 */
  maxItems: number;
  /** 见上方 SwarmAgentOptions：品牌化的路由覆盖，缺省则继承父 agent。 */
  agentOptions?: SwarmAgentOptions;
}

// ───────────────────────── 工具描述（面向模型，全文自拟）─────────────────────────

/**
 * 工具描述：英文、面向模型、全部自拟（clean-room，未复制任何上游原文）。
 * 覆盖四块：用途 / 五条硬校验 / 与单个 subagent 工具的分工 / 禁止嵌套（maxDepth=1）。
 */
const TOOL_DESCRIPTION = [
  "Dispatch a batch of independent, same-shaped tasks as multiple parallel subagents, and receive every member's result in one aggregated XML report.",
  "",
  "Use this when you have N (2 to 128) self-contained subtasks of the same kind that can run in parallel without depending on each other's output — reviewing N files the same way, researching N independent topics, applying one transform to N inputs. Each entry in items is substituted into prompt_template and dispatched as its own subagent; the call returns a single <agent_swarm_result> block listing every member's outcome and output.",
  "",
  "Hard requirements (the call is rejected before any subagent starts if violated):",
  "1. items must contain at least 2 entries.",
  "2. items must contain at most 128 entries.",
  "3. if you provide items, you must also provide prompt_template.",
  "4. prompt_template must contain the {{item}} placeholder, which is replaced once per item.",
  "5. every item must expand to a distinct prompt; items that expand to the same prompt are rejected.",
  "",
  "How to choose between this tool and a single-subagent tool:",
  "- Use this tool for several independent, same-shaped tasks that benefit from running at the same time.",
  "- Use a single-subagent tool when the work is one cohesive task, or when a later step depends on an earlier step's result — swarm members cannot see each other or your intermediate work.",
  "- Do not call this tool from inside a swarm member's subtask. Nesting a swarm within a swarm member is not supported (delegation depth is capped at 1); call it from your own turn instead.",
  "",
  "Individual members may fail; that is reported per member in the result rather than failing the whole call. Read the per-member outcomes to decide what to do next.",
].join("\n");

// ───────────────────────── 限流判定（一期：时间与存活率启发式）─────────────────────────

/**
 * 一期限流判定（M3 实机验证前的保守实现）。
 *
 * 为什么不能按错误码判：in-process（spawn）路径下，子代理结果只有 stopReason，
 * **没有** diagnostic / failure.code（见 spike Q6：限流与 429 信息在子代理内部的
 * 重试层被吃掉，父层拿不到稳定信号）。因此"检测 429"在一期写不出来。
 *
 * 一期策略：**不猜**。结果级一律不判限流（返回 false → 终态 failed），
 * 避免把普通错误误当限流把整批拖进无限重排队。
 *
 * ⚠️ 交付态订正（2026-10-01 审查）：恒返回 false 意味着调度器的整条限流分支
 * （退避、容量收缩与恢复、`retrying` 相位、面板退避 UI）**当前完全不触发**。
 * 此处原写「容量收缩/恢复/退避仍然照常工作，只是不由错误码触发」——该表述与代码事实
 * 相反（这些机制的唯一入口就是本判定），已删除。能力状态与启用前置条件见
 * docs/spec.md「交付状态」与 .agents/notes/implemented/process/2026-10-01-rate-limit-capability-status.md。
 *
 * **M3 待办（spike R1）**：改用子会话 `llm/retry` 事件，在 failure.code === "RATE_LIMIT"
 * 时于**子代理级**触发退避，而不是在结果级判定。本函数与 {@link classifyRateLimitPhaseOne}
 * 就是那个注入点——调度器通过 SwarmSchedulerDeps 接收二者，实装时替换即可，无需改调度器。
 * 启用前必须先补该子系统的三处缺口（容量无上界、限流模式无退出路径、并发闸门与容量恢复互锁），
 * 否则宿主的 maxConcurrency 一旦被装配即可能让批次停摆。
 */
function isRateLimitErrorPhaseOne(_error: unknown): boolean {
  return false;
}

/** 一期不判限流，此处仅为注入点保留语义（执行层无法区分 → 按"运行中被限流"轻罚）。 */
function classifyRateLimitPhaseOne(_error: unknown): SwarmRateLimitClass {
  return "in-flight-limited";
}

// ───────────────────────── 子代理派发 ─────────────────────────

/**
 * 把 M1 的结构化校验错误包装成可抛出的 Error。
 * 
 * 三个附加字段让调用方（模型 / 日志 / 测试）既能读到人话，也能按 code 做机器判定：
 *   name = "SwarmValidationError"、swarmErrorCode、swarmErrorDetails。
 */
function swarmValidationError(error: SwarmValidationError): Error {
  const wrapped = new Error(error.message) as Error & {
    swarmErrorCode?: string;
    swarmErrorDetails?: Record<string, unknown>;
  };
  wrapped.name = "SwarmValidationError";
  wrapped.swarmErrorCode = error.code;
  if (error.details !== undefined) wrapped.swarmErrorDetails = error.details;
  return wrapped;
}

/**
 * 单成员失败。带品牌以免与调度器的"限流判定"混淆：
 * 调度器只对 isRateLimitError 认可的 rejection 做重排队，本错误不是限流。
 */
class SwarmTaskFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwarmTaskFailure";
  }
}

/** 把子代理的 output 内容块拼成一段纯文本（供 XML body 使用）。 */
function joinContentBlocks(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter((text) => text !== "")
    .join("\n");
}

/** 失败详情拼接：stopReason + 可选 diagnostic（in-process 路径通常没有 diagnostic）。 */
function failureDetail(result: { stopReason: string; diagnostic?: string }): string {
  return result.diagnostic === undefined
    ? result.stopReason
    : `${String(result.stopReason)}; diagnostic: ${String(result.diagnostic)}`;
}

/**
 * 派发**一个**子代理并落成 SwarmAttemptResult。
 *
 * 红线（依赖顺序，缺一不可）：
 *   1. start() **成功后**必须有配对 dispose()（spike Q2.3；start 抛错时无 run 可 dispose）
 *   2. stopReason "aborted" 归取消/超时，绝不当限流（spike Q5）
 *   3. 不向 start 传它不支持的字段（如 timeout；超时自建 AbortSignal.timeout）
 *   4. parent 传 exec.agent，子代理沙箱档位据此自动继承（spike Q9）
 *
 * **失败必须用 throw 表达**：调度器把 executor 的「resolve」一律当作 completed
 * （scheduler.ts #runAttempt 无条件写 outcome:"completed"），只有 reject 才落 failed/aborted。
 * 所以这里不返回"失败对象"，而是抛出——否则失败成员会被 XML 谎报成 completed。
 */
async function runOneTask(
  ctx: Context,
  config: SwarmPluginConfig,
  spec: SwarmTaskSpec,
  attempt: SwarmAttemptContext,
  parent: SwarmParentAgent,
  label: string,
  swarmId?: string,
  registry?: SwarmRegistry,
): Promise<SwarmAttemptResult> {
  // 向 provider 发出首个请求前不动；成功 start 之后立刻标记。
  // 这是区分"首个请求未发出就失败"（重罚）与"运行中失败"（轻罚）的唯一依据（types.ts 契约）。
  let run;
  try {
    if (registry && swarmId) {
      registry.markStarting(swarmId, spec.index);
    }

    const timeoutMs = config.taskTimeoutMs;
    const signal =
      timeoutMs > 0
        ? AbortSignal.any([attempt.signal, AbortSignal.timeout(timeoutMs)])
        : attempt.signal;

    run = await ctx.subagents.start(config.provider, {
      parent,
      prompt: [{ type: "text", text: spec.prompt }],
      label,
      signal,
      ...(config.agentOptions === undefined ? {} : { agentOptions: config.agentOptions }),
    });
  } catch (error) {
    const detail = `Subagent could not be started: ${error instanceof Error ? error.message : String(error)}`;
    if (registry && swarmId) {
      registry.markSettled(swarmId, spec.index, "failed", detail);
    }
    throw new SwarmTaskFailure(detail);
  }

  // start 已成功：从这一刻起 run 存在，**必须**配对 dispose。
  attempt.setAgentId(run.id);
  if (registry && swarmId) {
    registry.setAgentId(swarmId, spec.index, run.id);
  }

  attempt.markReady();
  if (registry && swarmId) {
    registry.markReady(swarmId, spec.index);
  }

  try {
    const result = await run.result;
    if (result.stopReason === "completed") {
      if (registry && swarmId) {
        registry.markSettled(swarmId, spec.index, "completed");
      }
      return { result: joinContentBlocks(result.output), stopReason: result.stopReason };
    }
    const detail = failureDetail(result);
    const outcome = result.stopReason === "aborted" ? "aborted" : "failed";
    if (registry && swarmId) {
      registry.markSettled(swarmId, spec.index, outcome, detail);
    }
    throw new SwarmTaskFailure(detail);
  } catch (error) {
    if (registry && swarmId) {
      const batch = registry.getBatch(swarmId);
      const member = batch?.members.get(spec.index);
      if (member && member.phase !== "completed" && member.phase !== "failed" && member.phase !== "aborted") {
        registry.markSettled(swarmId, spec.index, "failed", error instanceof Error ? error.message : String(error));
      }
    }
    throw error;
  } finally {
    // 幂等 dispose；即使 await run.result 抛错也必须走到这里。
    await run.dispose();
  }
}

// ───────────────────────── 工具注册与 apply ─────────────────────────

/** 扁平参数映射：description / prompt_template / items；required 只写布尔 true。 */
const TOOL_PARAMETERS = {
  description: {
    type: "string",
    required: true,
    description: "One short sentence describing what this whole batch accomplishes.",
  },
  prompt_template: {
    type: "string",
    required: true,
    description:
      "Prompt template sent to every member, containing the {{item}} placeholder. Each entry of items is substituted for it to form one member's full prompt.",
  },
  items: {
    type: "array",
    items: { type: "string" },
    required: true,
    description: "The independent per-member inputs, at least 2 and at most 128 entries.",
  },
} as const;

/** 输出契约：{ xml: string }，render 两参（args, value），返回内容块数组。 */
const TOOL_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { xml: { type: "string" } },
  },
  render: (_args: unknown, value: { xml: string }): ContentBlock[] => [{ type: "text", text: value.xml }],
} as const;

/**
 * 插件入口。只做两件有副作用的事：注册工具、返回它的 disposer。
 *
 * ctx 副作用可逆性：Cordis 会把 apply 返回的函数登记为该 fiber 的 effect，
 * 卸载时自动调用 → ctx.tools.register 的 disposer 随之注销工具。
 * 本文件不注册监听器、不起定时器，故无其他需要清理的副作用。
 */
export function apply(ctx: Context, config: SwarmPluginConfig): () => void {
  const existingRemote = ctx.get("swarmRemote") as SwarmRemote | undefined;
  const registry = existingRemote ? existingRemote.getRegistry() : new SwarmRegistry();
  if (!existingRemote) {
    new SwarmRemote(ctx, registry);
  }

  const agentSwarm = defineTool({
    name: "agent_swarm",
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: TOOL_OUTPUT,
    // 与官方 subagent 工具一致：允许模型在同一条消息里并发调用多个 agent_swarm。
    isConcurrencySafe: () => true,
    async execute(
      args: { description: string; prompt_template: string; items: string[] },
      exec: ToolRunContext,
    ): Promise<{ xml: string }> {
      // ① 校验 + 展开：五条硬校验在任何子代理启动前完成。
      const validation = validateSwarmInput({
        description: args.description,
        promptTemplate: args.prompt_template,
        items: args.items,
      });
      if (!validation.ok) {
        // 结构化错误：code + 人可读 message + 机器可读 details 全部带出去。
        // 抛异常即工具失败（spike Q7.4：execute 不返回 isError，失败就是抛）。
        throw swarmValidationError(validation.error);
      }
      const specs = validation.specs;

      // ①b 宿主策略上限：M1 的 128 硬校验不可绕过，config.maxItems 只能把它调低。
      // 这里在**启动任何子代理之前**拒绝，与五条硬校验同一层（同样结构化报错）。
      const effectiveMax = Math.min(config.maxItems, SWARM_MAX_SUBAGENTS);
      if (specs.length > effectiveMax) {
        throw swarmValidationError({
          code: SWARM_ERROR_CODES.TOO_MANY_SUBAGENTS,
          message: `This deployment accepts at most ${String(effectiveMax)} swarm members, got ${String(specs.length)}.`,
          details: { total: specs.length, max: effectiveMax },
        });
      }

      // ② 父 Agent：必填项，缺失即抛（官方包同样写法）。
      const parent = exec.agent;
      if (parent === undefined) {
        throw new Error("agent_swarm requires a calling agent (exec.agent was undefined)");
      }

      // 获取会话标识（用于会话面板隔离）
      const sessionId =
        (parent as { session?: { id?: string } })?.session?.id ??
        (parent as { sessionId?: string })?.sessionId ??
        (exec as { session?: { id?: string } })?.session?.id ??
        "session-default";

      const swarmId = registry.beginBatch(sessionId, args.description, specs);

      // ③ 调度：executor 内派发子代理；批次信号 = exec.signal（用户中断级联）。
      let results: readonly SwarmTaskResult[];
      try {
        results = (await runSwarm(
          specs,
          {
            now: () => Date.now(),
            setTimeout: (handler, ms) => setTimeout(handler, ms),
            clearTimeout: (handle) => {
              clearTimeout(handle as ReturnType<typeof setTimeout>);
            },
            signal: exec.signal,
            isRateLimitError: isRateLimitErrorPhaseOne,
            classify: classifyRateLimitPhaseOne,
            onSuspended: (event) => {
              registry.markSuspended(
                swarmId,
                event.spec.index,
                event.retryCount,
                event.retryReadyAt,
                event.reason,
              );
            },
            onAbandoned: (event) => {
              const outcome = event.outcome === "cancelled" ? "aborted" : "failed";
              registry.markSettled(swarmId, event.spec.index, outcome, event.error);
            },
            executor: {
              run: (spec, attempt) =>
                runOneTask(
                  ctx,
                  config,
                  spec,
                  attempt,
                  parent,
                  `${String(spec.index)}/${String(specs.length)}: ${String(spec.item)}`,
                  swarmId,
                  registry,
                ),
            },
          },
          {
            initialLaunchLimit: config.firstWave,
            initialLaunchIntervalMs: config.releaseIntervalMs,
            retryBaseMs: config.backoffInitialMs,
            retryFactor: config.retryFactor,
            capacityShrinkDebounceMs: config.shrinkDebounceMs,
            capacityRecoveryIntervalMs: config.recoverIntervalMs,
            // 调度器自己的超时闸门：命中后该成员落 "Subagent timed out." 文案（failed）。
            // 把它透传给调度器，是为了保留这条可读文案；实际取消仍然由上面 executor 里
            // 那个 AbortSignal.timeout 完成（调度器只负责标记与文案，不负责杀进程）。
            timeoutMs: config.taskTimeoutMs,
          },
        )) as readonly SwarmTaskResult[];
      } finally {
        registry.endBatch(swarmId);
      }

      // ④ 收齐全部结果后一次性渲染：个别成员失败不拖垮整个工具调用，
      //    失败与成功在 XML 里如实分列（spike Q7.4 末条）。
      const xml = renderSwarmResult(results, { omitNotStarted: false });
      return { xml };
    },
  });

  return ctx.tools.register(agentSwarm);
}
