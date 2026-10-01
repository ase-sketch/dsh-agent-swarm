/**
 * dsh-agent-swarm — 批次执行（宿主集成层）
 *
 * 职责：拿到 batch-plan.ts 产出的批次计划后，开批次 → 接好调度器 → 每个成员经
 * `ctx.subagents.start()` 派发 one-shot 子代理 → 收齐全部结果 → 收批次。
 *
 * 不变量（缺一不可）：
 *   1. start() **成功后**必须有配对 dispose()（spike Q2.3；start 抛错时无 run 可 dispose）
 *   2. stopReason "aborted" 归取消/超时，绝不当限流（spike Q5）
 *   3. 不向 start 传它不支持的字段（如 timeout）；单任务超时由调度器的超时闸门 abort 成员信号实现
 *   4. parent 传 exec.agent，子代理沙箱档位据此自动继承（spike Q9）
 *   5. 成员终态由**批次信号**归属，不是成员信号（见 settleOutcomeAfter）
 *   6. **失败必须用 throw 表达**：调度器把 executor 的 resolve 一律当作 completed
 *      （scheduler.ts #runAttempt 无条件写 outcome:"completed"），只有 reject 才落 failed/aborted
 *   7. beginBatch / endBatch 严格配对（finally 收批次）
 */

import type { Context } from "@deepseek-ai/cordis";
// ctx.subagents 的类型来自 @deepseek-ai/dsh-subagent 对 Context 的 declare module 增强；
// batch-plan.ts 的 `import type` 已把它拉进编译单元。
import type {
  SwarmAttemptContext,
  SwarmAttemptResult,
  SwarmOutcome,
  SwarmRateLimitClass,
  SwarmTaskResult,
  SwarmTaskSpec,
} from "./types.js";
import { runSwarm } from "./scheduler.js";
import type { SwarmRegistry } from "./swarm-registry.js";
import type { RateLimitWatchRouter } from "./rate-limit-signal.js";
import { toSchedulerConfig, type SwarmAgentOptions, type SwarmPluginConfig } from "./config.js";
import type { SwarmBatchPlan, SwarmParentAgent } from "./batch-plan.js";

/** 插件实例级的宿主装配（apply 期确定，跨批次共享）。 */
export interface SwarmHost {
  ctx: Context;
  config: SwarmPluginConfig;
  /** 面板数据源。 */
  registry: SwarmRegistry;
  /** 限流信号路由；限流接线关闭时为 undefined。 */
  rateLimit: RateLimitWatchRouter | undefined;
}

// ───────────────────────── 限流判定 ─────────────────────────

/**
 * 被限流拖死的单次尝试。带品牌，是调度器"应重排队退避而不是落 failed"的**唯一**信号。
 *
 * 只有限流接线开启（config.rateLimit.enabled）时 runMember 才会抛出它；关闭时它永不出现，
 * isRateLimitError 恒假，调度器的整条限流分支（退避、容量收缩与恢复、`retrying` 相位、面板退避 UI）
 * 不触发——与接线前的行为逐字节一致。判定依据见 rate-limit-signal.ts。
 */
class SwarmRateLimitedFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwarmRateLimitedFailure";
  }
}

function isRateLimitError(error: unknown): boolean {
  return error instanceof SwarmRateLimitedFailure;
}

/**
 * 限流档位：一律按"运行中被限流"（轻罚）。
 *
 * 理由：DSH 的 start() 成功即意味着子代理已发布并开始首轮，限流只可能发生在子代理自己的请求上；
 * "首个请求还没发出就被限流"（重罚）在 DSH 里没有可观测的对应物——它要求在子代理首个成功步骤之前
 * 就把调度判定为未就绪，而那需要上游机制文档对"ready"的精确定义。保持 types.ts 契约里的安全默认。
 */
function classifyRateLimit(_error: unknown): SwarmRateLimitClass {
  return "in-flight-limited";
}

// ───────────────────────── 成员结局 ─────────────────────────

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
 * 宿主侧成员终态的归属判定：**批次信号是否已 abort** 是唯一判据。
 *
 * 语义：批次被中断（用户取消 / 上游 abort）时，调度器在 #finishWithAbort 里把所有尚未落定结果的
 * 成员统一判成 aborted，这是 XML 的权威口径；registry 因此必须按同一判据落终态，两个口径才不会
 * 再次分叉。非中断收场（真实失败、单任务超时、子代理自报 aborted）一律 failed。
 *
 * ⚠️ 不要改用 attempt.signal.aborted 判——它"看起来更近"，却是错的：
 *   调度器自己的超时闸门（scheduler.ts #linkAttemptSignals）在超时那一刻执行
 *   attempt.controller.abort(new Error("Subagent timed out."))，而 attempt.controller.signal
 *   正是 executor 拿到的 attempt.signal。也就是说**超时同样会把 attempt.signal 置成 aborted**，
 *   与批次中断在这一位上完全同形；据此判定会把超时成员错记成 aborted，而 XML 侧对超时打的是
 *   failed。tests/plugin.test.ts 的 WP-C2 ③a 用例就是这条反例的护栏。
 *
 * 两种到达顺序都成立：
 *   ① 先中断、后收场 → 此刻批次信号已 aborted → aborted，与 XML 一致；
 *   ② 先收场、后中断 → 判定发生在中断之前 → failed；调度器已记录该成员结果，
 *      随后的中断不覆写它（#finishWithAbort 保留已有结果），XML 同样是 failed。
 *
 * 已知边界：判定与调度器真正落定该成员结果之间隔着 runMember finally 里的 await run.dispose()。
 * 若中断恰好落进这段窗口，registry 会停在 failed 而 XML 已被 #finishWithAbort 改判 aborted；
 * 彻底闭合需要改调度器/宿主的分工（把落终态推迟到 dispose 之后），不在本次改动范围内。
 */
function settleOutcomeAfter(batchSignal: AbortSignal): "aborted" | "failed" {
  return batchSignal.aborted ? "aborted" : "failed";
}

/**
 * 内部结局 → registry 成员终态相位的**唯一**映射点。
 *
 * 内部结局的取值域比 registry 的三态宽，来源有两处：
 *   - 调度器 SwarmAbandonedEvent.outcome：`"failed" | "cancelled"`（cancelled = 批次被中断而放弃）；
 *   - 结果级 SwarmOutcome：`"completed" | "failed" | "aborted"`。
 * 映射表：completed → completed；failed → failed；aborted 与 cancelled → aborted（同为"中断"档）。
 */
function toSettledPhase(outcome: SwarmOutcome | "cancelled"): "completed" | "failed" | "aborted" {
  if (outcome === "completed") return "completed";
  if (outcome === "failed") return "failed";
  return "aborted";
}

// ───────────────────────── 单成员派发 ─────────────────────────

/** 一批成员共享的派发上下文：execute 期一次性确定，执行期只读。 */
interface MemberDispatch {
  ctx: Context;
  provider: string;
  parent: SwarmParentAgent;
  /** 本批次的生效路由覆盖（缺省 = 继承父 agent）。 */
  agentOptions: SwarmAgentOptions | undefined;
  /** 透传给 start 的委派深度上限（undefined = 不传）。 */
  maxDepth: number | undefined;
  registry: SwarmRegistry;
  /** 限流信号路由；关闭时为 undefined（不观察、不判限流）。 */
  rateLimit: RateLimitWatchRouter | undefined;
  swarmId: string;
  /** 批次级信号（exec.signal）：只判"批次是否被中断"，不判单个成员的信号。 */
  batchSignal: AbortSignal;
  /** 成员总数（拼 label 用）。 */
  total: number;
}

/** 子代理标签里 item 部分的最大码元数（超出截断并补 `…`）。 */
export const MEMBER_LABEL_ITEM_MAX_CHARS = 80;

/**
 * 子代理显示标签：`<序号>/<总数>: <item 摘要>`。
 *
 * 为什么必须截断、折叠空白：label 会随 `subagent/catalog` 事件**持久化进父会话日志**
 * 并显示在子代理目录里（spike Q2.2）。item 可以是整份文件——128 个 100KB 的 item 会把
 * 十几 MB 原文复制进父会话日志；多行 item 也会把单行标签撑成多行。
 * 成员的完整 prompt 仍原样派发，截断只影响显示标签。
 */
export function memberLabel(spec: SwarmTaskSpec, total: number): string {
  const oneLine = String(spec.item).replace(/\s+/g, " ").trim();
  const item =
    oneLine.length > MEMBER_LABEL_ITEM_MAX_CHARS ? `${oneLine.slice(0, MEMBER_LABEL_ITEM_MAX_CHARS)}…` : oneLine;
  return `${String(spec.index)}/${String(total)}: ${item}`;
}

/**
 * 派发**一个**子代理并落成 SwarmAttemptResult；失败一律 throw（见文件头不变量 6）。
 *
 * registry 的成员相位在这里随派发进程推进：starting → running → completed/failed/aborted。
 * markSettled 对已落定成员是粘性的（swarm-registry.ts），所以 catch 里可以无条件再落一次。
 */
async function runMember(
  dispatch: MemberDispatch,
  spec: SwarmTaskSpec,
  attempt: SwarmAttemptContext,
): Promise<SwarmAttemptResult> {
  const { ctx, registry, swarmId, batchSignal } = dispatch;
  let run;
  try {
    registry.markStarting(swarmId, spec.index);

    // 成员信号就是调度器的 attempt.signal：它同时承载批次中断（exec.signal 级联）与单任务超时
    // （调度器 #linkAttemptSignals 的超时闸门以 "Subagent timed out." 为原因 abort 它）。
    // 这里**不再**另拼 AbortSignal.timeout：两个同时长计时器会竞速，超时文案的确定性
    // 只能靠"恰好谁先创建"；单一来源后，超时的取消与文案出自同一个闸门。
    run = await ctx.subagents.start(dispatch.provider, {
      parent: dispatch.parent,
      prompt: [{ type: "text", text: spec.prompt }],
      label: memberLabel(spec, dispatch.total),
      signal: attempt.signal,
      ...(dispatch.agentOptions === undefined ? {} : { agentOptions: dispatch.agentOptions }),
      ...(dispatch.maxDepth === undefined ? {} : { maxDepth: dispatch.maxDepth }),
    });
  } catch (error) {
    const detail = `Subagent could not be started: ${error instanceof Error ? error.message : String(error)}`;
    registry.markSettled(swarmId, spec.index, "failed", detail);
    throw new SwarmTaskFailure(detail);
  }

  // start 已成功：从这一刻起 run 存在，**必须**配对 dispose。
  // 子会话 id 即 run.id（spike：in-process driver 以 childId 作为 run.id；待实机验证）。
  const childSessionId = String(run.id);
  const watch = dispatch.rateLimit?.watch(childSessionId);
  attempt.setAgentId(run.id);
  registry.setAgentId(swarmId, spec.index, run.id);
  attempt.markReady();
  registry.markReady(swarmId, spec.index);

  try {
    const result = await run.result;
    if (result.stopReason === "completed") {
      registry.markSettled(swarmId, spec.index, toSettledPhase(result.stopReason));
      return { result: joinContentBlocks(result.output), stopReason: result.stopReason };
    }
    const detail = failureDetail(result);
    const assessment = watch?.assess(result.stopReason);
    if (assessment?.rateLimited === true) {
      // 交给调度器退避重排队；成员相位由 onSuspended（retrying）或判死后的 onAbandoned（failed）推进，
      // 这里不落终态——markSettled 是粘性的，提前落 failed 会让后续的 retrying 永远显示不出来。
      throw new SwarmRateLimitedFailure(
        `${detail}; rate limited (${String(assessment.failureCode)}) after ${String(assessment.rateLimitRetries)} retries inside the subagent`,
      );
    }
    // 落终态与 catch 用同一条判据（批次信号），不用子代理自报的 stopReason：
    // 子代理自报 "aborted" 只说明它被取消，不说明**批次**被打断——单任务超时同样会让成员优雅
    // 收场成 aborted，而 XML 侧对这条路径打的是 failed。详见 settleOutcomeAfter。
    throw new SwarmTaskFailure(detail);
  } catch (error) {
    if (!(error instanceof SwarmRateLimitedFailure)) {
      registry.markSettled(
        swarmId,
        spec.index,
        settleOutcomeAfter(batchSignal),
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  } finally {
    dispatch.rateLimit?.release(childSessionId);
    // 幂等 dispose；即使 await run.result 抛错也必须走到这里。
    await run.dispose();
  }
}

// ───────────────────────── 整批执行 ─────────────────────────

/**
 * 开批次 → 接好调度器的依赖与配置 → 跑完一整批 → 无论成败都收批次。
 *
 * beginBatch / endBatch 严格配对：调度器只在 config 非法时抛错，此时 finally 仍然要收批次，
 * 否则会话面板会永远停在 running（成员相位还留在 pending）。
 */
export async function runSwarmBatch(
  host: SwarmHost,
  plan: SwarmBatchPlan,
  batchSignal: AbortSignal,
): Promise<readonly SwarmTaskResult[]> {
  const { ctx, config, registry } = host;
  const { specs } = plan;
  const swarmId = registry.beginBatch(plan.sessionId, plan.description, specs, Date.now(), plan.routeLabel);
  const dispatch: MemberDispatch = {
    ctx,
    provider: plan.provider,
    parent: plan.parent,
    agentOptions: plan.agentOptions,
    maxDepth: plan.maxDepth,
    registry,
    rateLimit: host.rateLimit,
    swarmId,
    batchSignal,
    total: specs.length,
  };

  try {
    return await runSwarm(
      specs,
      {
        now: () => Date.now(),
        setTimeout: (handler, ms) => setTimeout(handler, ms),
        clearTimeout: (handle) => {
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        },
        signal: batchSignal,
        isRateLimitError,
        classify: classifyRateLimit,
        onSuspended: (event) => {
          registry.markSuspended(swarmId, event.spec.index, event.retryCount, event.retryReadyAt, event.reason);
        },
        onAbandoned: (event) => {
          // 内部结局（failed / cancelled）经唯一映射点落到 registry 三态。
          registry.markSettled(swarmId, event.spec.index, toSettledPhase(event.outcome), event.error);
        },
        executor: {
          run: (spec, attempt) => runMember(dispatch, spec, attempt),
        },
      },
      toSchedulerConfig(config),
    );
  } finally {
    registry.endBatch(swarmId);
  }
}
