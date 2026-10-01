/**
 * dsh-agent-swarm — 批次执行（宿主集成层）
 *
 * 职责：拿到 batch-plan.ts 产出的批次计划后，开批次 → 接好调度器 → 每个成员经
 * `ctx.subagents.start()` 派发 one-shot 子代理 → 收齐全部结果 → 收批次。
 *
 * 不变量（缺一不可）：
 *   1. start() **成功后**必须有配对 dispose()（spike Q2.3；start 抛错时无 run 可 dispose）
 *   2. stopReason "aborted" 归取消/超时，绝不当限流（spike Q5）
 *   3. 不向 start 传它不支持的字段（如 timeout）
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
import { toSchedulerConfig, type SwarmAgentOptions, type SwarmPluginConfig } from "./config.js";
import type { SwarmBatchPlan, SwarmParentAgent } from "./batch-plan.js";

// ───────────────────────── 限流判定（一期：不判）─────────────────────────

/**
 * 一期限流判定（M3 实机验证前的保守实现）：**不猜**，结果级一律不判限流。
 *
 * 为什么不能按错误码判：in-process（spawn）路径下，子代理结果只有 stopReason，
 * **没有** diagnostic / failure.code（spike Q6：429 在子代理内部的重试层被吃掉）。
 *
 * ⚠️ 恒返回 false 意味着调度器的整条限流分支（退避、容量收缩与恢复、`retrying` 相位、
 * 面板退避 UI）**当前完全不触发**。能力状态与启用前置条件见 docs/spec.md「交付状态」与
 * .agents/notes/implemented/process/2026-10-01-rate-limit-capability-status.md。
 */
function isRateLimitErrorPhaseOne(_error: unknown): boolean {
  return false;
}

/** 一期不判限流，此处仅为注入点保留语义（执行层无法区分 → 按"运行中被限流"轻罚）。 */
function classifyRateLimitPhaseOne(_error: unknown): SwarmRateLimitClass {
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
  taskTimeoutMs: number;
  registry: SwarmRegistry;
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

    const timeoutMs = dispatch.taskTimeoutMs;
    const signal =
      timeoutMs > 0
        ? AbortSignal.any([attempt.signal, AbortSignal.timeout(timeoutMs)])
        : attempt.signal;

    run = await ctx.subagents.start(dispatch.provider, {
      parent: dispatch.parent,
      prompt: [{ type: "text", text: spec.prompt }],
      label: memberLabel(spec, dispatch.total),
      signal,
      ...(dispatch.agentOptions === undefined ? {} : { agentOptions: dispatch.agentOptions }),
    });
  } catch (error) {
    const detail = `Subagent could not be started: ${error instanceof Error ? error.message : String(error)}`;
    registry.markSettled(swarmId, spec.index, "failed", detail);
    throw new SwarmTaskFailure(detail);
  }

  // start 已成功：从这一刻起 run 存在，**必须**配对 dispose。
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
    // 落终态与 catch 用同一条判据（批次信号），不用子代理自报的 stopReason：
    // 子代理自报 "aborted" 只说明它被取消，不说明**批次**被打断——单任务超时同样会让成员优雅
    // 收场成 aborted，而 XML 侧对这条路径打的是 failed。详见 settleOutcomeAfter。
    throw new SwarmTaskFailure(failureDetail(result));
  } catch (error) {
    registry.markSettled(
      swarmId,
      spec.index,
      settleOutcomeAfter(batchSignal),
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  } finally {
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
  ctx: Context,
  config: SwarmPluginConfig,
  plan: SwarmBatchPlan,
  registry: SwarmRegistry,
  batchSignal: AbortSignal,
): Promise<readonly SwarmTaskResult[]> {
  const { specs } = plan;
  const swarmId = registry.beginBatch(plan.sessionId, plan.description, specs, Date.now(), plan.routeLabel);
  const dispatch: MemberDispatch = {
    ctx,
    provider: plan.provider,
    parent: plan.parent,
    agentOptions: plan.agentOptions,
    taskTimeoutMs: config.taskTimeoutMs,
    registry,
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
        isRateLimitError: isRateLimitErrorPhaseOne,
        classify: classifyRateLimitPhaseOne,
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
