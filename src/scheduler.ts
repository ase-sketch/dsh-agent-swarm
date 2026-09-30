/**
 * dsh-agent-swarm — 并发调度器（纯逻辑，零 DSH 依赖）
 *
 * 设计依据：extracted/kimi-code-swarm-analysis/01-机制文档/02-并发调度与限流退避.md。
 * clean-room 重写：只依据机制文档的行为描述重写状态机；未复制上游源码。
 *
 * 节奏契约：
 *   正常模式   首波无间隔连发 initialLaunchLimit 个，之后每 initialLaunchIntervalMs 放 1 个
 *   限流模式   不再有首波，严格按 rateLimitCapacity 放量，每次放量间隔 globalRetryIntervalMs
 *   退避       第 n 次限流重排队 → retryBaseMs * retryFactor^(n-1)（无抖动）
 *   收缩       每次限流容量 -1，非强制收缩有 capacityShrinkDebounceMs 防抖，下限 1
 *   恢复       距最近一次限流满 capacityRecoveryIntervalMs 后容量 +1
 *   重罚/轻罚  首请求未发出就限流 → 全局间隔翻倍；已发出（ready）→ 只推 retryBaseMs
 *   死锁防护   只剩一个未完成任务且它持续限流 → 直接判 failed，不再无限重排队
 *   中断       AbortSignal → 在跑标 aborted、清空队列
 *
 * 本实现相对上游行为描述的**有意偏离**（均为可测的收紧，不是功能变更）：
 *   1. 退避重排队事件（onSuspended）额外携带 retryCount / retryDelayMs / retryReadyAt。
 *      上游只回传"已挂起"这一事实，宿主无从知道还要等多久。
 *   2. 结果同时给出 `state` 与 `outcome` 两个正交维度，且 `state` 由"是否真的启动过"
 *      （曾 markReady 或曾拿到 agentId）决定，而不是只看 agentId 是否存在。
 *   3. 时间语义修正：退避延迟、容量防抖、180s 恢复**一律走注入的 now()**。
 *      上游在部分路径上直接读 Date.now()，与注入时钟混用会让测试无法确定性复现。
 *   4. 容量恢复后把 nextRateLimitLaunchAt 拉回 now（与上游一致），
 *      因此"何时重试"是容量、全局节流、退避就绪时间三者共同决定的复合结果——
 *      测试断言退避公式时应以 onSuspended 回传的 retryReadyAt 为准，而不是墙钟时刻。
 */

import {
  DEFAULT_SWARM_SCHEDULER_CONFIG,
  type SwarmAbandonedEvent,
  type SwarmAttemptContext,
  type SwarmAttemptResult,
  type SwarmSchedulerConfig,
  type SwarmSchedulerDeps,
  type SwarmState,
  type SwarmSuspendedEvent,
  type SwarmTaskResult,
  type SwarmTaskSpec,
  type SwarmTimerHandle,
} from "./types.js";

/** 限流挂起原因文案（写进 onSuspended 事件，供 UI/日志使用）。 */
export const RATE_LIMIT_SUSPENDED_REASON = "Provider rate limit; subagent requeued for retry.";

const ABORTED_WHILE_RUNNING = "The swarm was interrupted before this member finished.";
const ABORTED_BEFORE_START = "The swarm was interrupted before this member was started.";
const TIMED_OUT = "Subagent timed out.";
const ABANDONED_BY_RATE_LIMIT =
  "Subagent was still rate limited while it was the only unfinished member; the swarm gave up on it.";

/** 调度器只读状态快照（测试与宿主日志用）。 */
export interface SwarmSchedulerSnapshot {
  finished: boolean;
  rateLimitMode: boolean;
  rateLimitCapacity: number;
  globalRetryIntervalMs: number;
  nextRateLimitLaunchAt: number;
  startedSuccessCount: number;
  activeCount: number;
  pendingCount: number;
}

/** 每个任务的持久状态，跨重试保留。 */
interface TaskState {
  index: number;
  spec: SwarmTaskSpec;
  retryCount: number;
  retryReadyAt: number;
  agentId?: string;
  /** 是否真的跑起来过（曾 markReady 或曾拿到 agentId）。跨重试保留。 */
  started: boolean;
}

/** 单次尝试，跑完即弃。 */
interface Attempt {
  state: TaskState;
  controller: AbortController;
  ready: boolean;
  timedOut: boolean;
  cleanup(): void;
}

type AttemptOutcome =
  | { type: "settled"; result: SwarmTaskResult }
  | { type: "rate_limited"; agentId?: string; error: unknown };

function resolveConfig(config?: Partial<SwarmSchedulerConfig>): SwarmSchedulerConfig {
  return { ...DEFAULT_SWARM_SCHEDULER_CONFIG, ...config };
}

/**
 * 按 spec 顺序把任务跑完，返回**与输入等长、按 index 落位**的结果数组。
 * 该 Promise 只会 resolve（批次级失败以 failed 结果的形式落位），
 * 唯一会 reject 的情况是调用方传入了非法的 config。
 */
export class SwarmScheduler {
  readonly #deps: SwarmSchedulerDeps;
  readonly #config: SwarmSchedulerConfig;
  readonly #states: TaskState[];
  readonly #results: (SwarmTaskResult | undefined)[];

  #resolve: ((results: SwarmTaskResult[]) => void) | undefined;
  #pending: TaskState[] = [];
  #active = new Set<Attempt>();
  #finished = false;

  #normalLaunchCount = 0;
  #normalLaunchTimer: SwarmTimerHandle | undefined;
  #rateLimitLaunchTimer: SwarmTimerHandle | undefined;

  #rateLimitMode = false;
  #rateLimitCapacity = 1;
  #startedSuccessCount = 0;
  #lastRateLimitAt: number | undefined;
  #lastCapacityShrinkAt: number | undefined;
  #lastCapacityRecoveryAt: number | undefined;
  #globalRetryIntervalMs: number;
  #nextRateLimitLaunchAt = 0;

  #onBatchAbort = (): void => {
    if (this.#finished) return;
    this.#abandonSuspended();
    this.#finishWithAbort();
  };

  constructor(specs: readonly SwarmTaskSpec[], deps: SwarmSchedulerDeps, config?: Partial<SwarmSchedulerConfig>) {
    this.#config = resolveConfig(config);
    if (this.#config.initialLaunchLimit < 1) {
      throw new Error(`initialLaunchLimit must be >= 1, got ${String(this.#config.initialLaunchLimit)}.`);
    }
    if (this.#config.retryBaseMs < 0) {
      throw new Error(`retryBaseMs must be >= 0, got ${String(this.#config.retryBaseMs)}.`);
    }
    if (this.#config.retryFactor < 1) {
      throw new Error(`retryFactor must be >= 1, got ${String(this.#config.retryFactor)}.`);
    }
    this.#deps = deps;
    this.#globalRetryIntervalMs = this.#config.retryBaseMs;
    this.#states = specs.map((spec, i) => ({
      index: i,
      spec,
      retryCount: 0,
      retryReadyAt: 0,
      started: false,
    }));
    this.#results = new Array<SwarmTaskResult | undefined>(specs.length);
    this.#pending = [...this.#states];
  }

  /** 只可调用一次。 */
  run(): Promise<SwarmTaskResult[]> {
    return new Promise<SwarmTaskResult[]>((resolve) => {
      this.#resolve = resolve;
      if (this.#states.length === 0) {
        this.#finish([]);
        return;
      }
      const signal = this.#deps.signal;
      if (signal?.aborted === true) {
        this.#onBatchAbort();
        return;
      }
      signal?.addEventListener("abort", this.#onBatchAbort, { once: true });
      this.#schedule();
    });
  }

  /**
   * 只读状态快照。用于测试断言与宿主日志；不改变任何调度状态。
   * 之所以暴露它，是因为容量收缩/恢复这类行为只体现在"下一次何时放量"上，
   * 没有快照就只能靠脆弱的时序间接推断。
   */
  snapshot(): SwarmSchedulerSnapshot {
    return {
      finished: this.#finished,
      rateLimitMode: this.#rateLimitMode,
      rateLimitCapacity: this.#rateLimitCapacity,
      globalRetryIntervalMs: this.#globalRetryIntervalMs,
      nextRateLimitLaunchAt: this.#nextRateLimitLaunchAt,
      startedSuccessCount: this.#startedSuccessCount,
      activeCount: this.#active.size,
      pendingCount: this.#pending.length,
    };
  }

  // ───────────────────────── 调度主循环 ─────────────────────────

  #schedule(): void {
    if (this.#finished) return;
    if (this.#finishIfComplete()) return;
    if (this.#deps.signal?.aborted === true) return;
    if (this.#rateLimitMode) this.#scheduleRateLimitLaunch();
    else this.#scheduleNormalLaunch();
  }

  #finishIfComplete(): boolean {
    for (const result of this.#results) if (result === undefined) return false;
    this.#finish(this.#results as SwarmTaskResult[]);
    return true;
  }

  #scheduleNormalLaunch(): void {
    // 首波：最多 initialLaunchLimit 个，无间隔连发
    while (
      this.#normalLaunchCount < this.#config.initialLaunchLimit &&
      this.#pending.length > 0 &&
      !this.#rateLimitMode &&
      !this.#isAtConcurrencyLimit()
    ) {
      const state = this.#pending.shift() as TaskState;
      this.#startAttempt(state);
      this.#normalLaunchCount += 1;
    }
    // 首波之后：每 initialLaunchIntervalMs 放一个
    if (
      this.#pending.length === 0 ||
      this.#rateLimitMode ||
      this.#normalLaunchTimer !== undefined ||
      this.#isAtConcurrencyLimit()
    ) {
      return;
    }
    this.#normalLaunchTimer = this.#deps.setTimeout(() => {
      this.#normalLaunchTimer = undefined;
      if (this.#finished || this.#rateLimitMode || this.#pending.length === 0) return;
      if (this.#isAtConcurrencyLimit()) return;
      const state = this.#pending.shift() as TaskState;
      this.#startAttempt(state);
      this.#normalLaunchCount += 1;
      this.#schedule();
    }, this.#config.initialLaunchIntervalMs);
  }

  #isAtConcurrencyLimit(): boolean {
    const max = this.#config.maxConcurrency;
    return max !== undefined && this.#active.size >= max;
  }

  // ───────────────────────── 限流模式 ─────────────────────────

  #scheduleRateLimitLaunch(): void {
    this.#clearRateLimitTimer();
    if (this.#pending.length === 0) return;
    const now = this.#deps.now();
    this.#recoverRateLimitCapacity(now);

    // ① 在跑数已达容量 → 等到容量恢复时刻再唤醒
    if (this.#active.size >= this.#rateLimitCapacity) {
      this.#scheduleRateLimitWakeup(this.#nextCapacityRecoveryAt(), now);
      return;
    }

    // ② 下一个可放量时刻 = max(全局节流, 最早就绪任务)
    const nextAllowedAt = Math.max(this.#nextRateLimitLaunchAt, this.#nextPendingReadyAt());
    const nextWakeupAt = Math.min(nextAllowedAt, this.#nextCapacityRecoveryAt());
    if (nextWakeupAt > now) {
      this.#scheduleRateLimitWakeup(nextWakeupAt, now);
      return;
    }

    // ③ 找一个就绪任务启动
    //
    // 硬并发闸门：maxConcurrency 与 rateLimitCapacity 是**两个独立**的闸门，缺一不可。
    // rateLimitCapacity 只在限流时收紧（可能远大于 maxConcurrency），因此它变小不构成
    // "一定没到并发上限"的保证；而此处一旦漏检，就会在 maxConcurrency 已满时继续补位，
    // 直接违反 SwarmSchedulerConfig.maxConcurrency 的契约（正常模式走
    // #isAtConcurrencyLimit，限流模式此前是漏的）。
    if (this.#isAtConcurrencyLimit()) {
      // 满并发时不启动新任务，但仍**必须**装下一次唤醒定时器。
      //
      // 两种醒来理由都要覆盖，否则会僵住：
      //   ① 在跑任务腾位子 → 经 #handleAttemptOutcome → #schedule 重新进来；
      //   ② 容量恢复时刻到 → 限流模式下 #nextCapacityRecoveryAt 可能先于任何任务释放到达，
      //      若这里不装定时器，180s 恢复就永远等不到 tick（这正是引入本分支时的实测回归）。
      // #scheduleNextRateLimitWakeup 内部已按"在跑数 >= 容量"取恢复时刻、反之取放量时刻，
      // 因此直接复用它即可，不必在此重复判断。
      this.#scheduleNextRateLimitWakeup(now);
      return;
    }
    const pendingIndex = this.#pending.findIndex((state) => state.retryReadyAt <= now);
    if (pendingIndex === -1) return;
    const [state] = this.#pending.splice(pendingIndex, 1) as [TaskState];
    this.#startAttempt(state);
    this.#nextRateLimitLaunchAt = now + this.#globalRetryIntervalMs;
    this.#scheduleNextRateLimitWakeup(now);
  }

  #scheduleRateLimitWakeup(wakeupAt: number, now: number): void {
    if (!Number.isFinite(wakeupAt) || wakeupAt <= now) return;
    this.#rateLimitLaunchTimer = this.#deps.setTimeout(() => {
      this.#rateLimitLaunchTimer = undefined;
      this.#schedule();
    }, wakeupAt - now);
  }

  #scheduleNextRateLimitWakeup(now: number): void {
    if (this.#pending.length === 0) return;
    const nextWakeupAt =
      this.#active.size >= this.#rateLimitCapacity
        ? this.#nextCapacityRecoveryAt()
        : Math.min(
            Math.max(this.#nextRateLimitLaunchAt, this.#nextPendingReadyAt()),
            this.#nextCapacityRecoveryAt(),
          );
    this.#scheduleRateLimitWakeup(nextWakeupAt, now);
  }

  #nextPendingReadyAt(): number {
    let min = Number.POSITIVE_INFINITY;
    for (const state of this.#pending) min = Math.min(min, state.retryReadyAt);
    return min;
  }

  #nextCapacityRecoveryAt(): number {
    if (this.#pending.length === 0 || this.#lastRateLimitAt === undefined) return Number.POSITIVE_INFINITY;
    return (
      Math.max(this.#lastRateLimitAt, this.#lastCapacityRecoveryAt ?? 0) + this.#config.capacityRecoveryIntervalMs
    );
  }

  #enterRateLimitMode(now: number): void {
    if (!this.#rateLimitMode) {
      this.#rateLimitMode = true;
      this.#clearNormalTimer();
      this.#rateLimitCapacity = Math.max(1, this.#startedSuccessCount);
      this.#nextRateLimitLaunchAt = Math.max(this.#nextRateLimitLaunchAt, now + this.#config.retryBaseMs);
      this.#shrinkRateLimitCapacity(now, true);
      return;
    }
    this.#shrinkRateLimitCapacity(now, false);
  }

  #shrinkRateLimitCapacity(now: number, force: boolean): void {
    if (
      !force &&
      this.#lastCapacityShrinkAt !== undefined &&
      now - this.#lastCapacityShrinkAt < this.#config.capacityShrinkDebounceMs
    ) {
      return;
    }
    this.#rateLimitCapacity = Math.max(1, this.#rateLimitCapacity - 1);
    this.#lastCapacityShrinkAt = now;
  }

  #recoverRateLimitCapacity(now: number): void {
    if (this.#nextCapacityRecoveryAt() > now) return;
    this.#rateLimitCapacity += 1;
    this.#lastCapacityRecoveryAt = now;
    this.#nextRateLimitLaunchAt = Math.min(this.#nextRateLimitLaunchAt, now);
  }

  // ───────────────────────── 尝试生命周期 ─────────────────────────

  #startAttempt(state: TaskState): void {
    if (this.#finished || this.#deps.signal?.aborted === true) return;
    const controller = new AbortController();
    const attempt: Attempt = {
      state,
      controller,
      ready: false,
      timedOut: false,
      cleanup: () => undefined,
    };
    attempt.cleanup = this.#linkAttemptSignals(attempt);
    this.#active.add(attempt);
    void this.#runAttempt(attempt).then(
      (outcome) => {
        this.#handleAttemptOutcome(attempt, outcome);
      },
      (error: unknown) => {
        this.#handleAttemptError(attempt, error);
      },
    );
  }

  async #runAttempt(attempt: Attempt): Promise<AttemptOutcome> {
    const state = attempt.state;
    if (attempt.controller.signal.aborted) {
      return { type: "settled", result: this.#abortedResult(state, state.agentId) };
    }

    let agentId = state.agentId;
    const context: SwarmAttemptContext = {
      attempt: state.retryCount + 1,
      signal: attempt.controller.signal,
      markReady: () => {
        this.#markAttemptReady(attempt);
      },
      setAgentId: (id: string) => {
        agentId = id;
        state.agentId = id;
        state.started = true;
      },
      ...(state.agentId === undefined ? {} : { previousAgentId: state.agentId }),
    };

    let outcome: SwarmAttemptResult;
    try {
      outcome = await this.#deps.executor.run(state.spec, context);
    } catch (error) {
      if (this.#deps.isRateLimitError(error)) {
        return { type: "rate_limited", ...(agentId === undefined ? {} : { agentId }), error };
      }
      return { type: "settled", result: this.#failedResult(state, this.#errorMessage(attempt, error)) };
    }

    const result: SwarmTaskResult = {
      spec: state.spec,
      outcome: "completed",
      state: "started",
      ...(agentId === undefined ? {} : { agentId }),
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      ...(outcome.stopReason === undefined ? {} : { stopReason: outcome.stopReason }),
    };
    return { type: "settled", result };
  }

  #linkAttemptSignals(attempt: Attempt): () => void {
    const batchSignal = this.#deps.signal;
    const abortFromBatch = (): void => {
      attempt.controller.abort(batchSignal?.reason);
    };
    const timeoutMs = this.#config.timeoutMs;
    const timeout =
      timeoutMs === undefined || timeoutMs <= 0
        ? undefined
        : this.#deps.setTimeout(() => {
            attempt.timedOut = true;
            attempt.controller.abort(new Error(TIMED_OUT));
          }, timeoutMs);

    if (batchSignal?.aborted === true) abortFromBatch();
    else batchSignal?.addEventListener("abort", abortFromBatch, { once: true });

    return () => {
      if (timeout !== undefined) this.#deps.clearTimeout(timeout);
      batchSignal?.removeEventListener("abort", abortFromBatch);
    };
  }

  #markAttemptReady(attempt: Attempt): void {
    if (this.#finished || attempt.ready || !this.#active.has(attempt)) return;
    attempt.ready = true;
    attempt.state.started = true;
    if (!this.#rateLimitMode) this.#startedSuccessCount += 1;
    if (this.#rateLimitMode) {
      this.#globalRetryIntervalMs = this.#config.retryBaseMs;
      this.#nextRateLimitLaunchAt = this.#deps.now() + this.#globalRetryIntervalMs;
      this.#schedule();
    }
  }

  #handleAttemptOutcome(attempt: Attempt, outcome: AttemptOutcome): void {
    if (!this.#releaseAttempt(attempt)) return;
    if (this.#finished) return;

    if (outcome.type === "settled") {
      this.#results[attempt.state.index] = outcome.result;
    } else if (this.#isOnlyUnfinishedTask(attempt.state) && attempt.state.retryCount >= 1) {
      // 死锁防护：只剩它一个还在限流，且**已经退避重试过至少一次**仍限流 →
      // 再等也等不到"别人完成腾容量"，直接判 failed。
      //
      // 相对上游的**有意偏离**（收紧→放宽，给一次重试机会）：
      // 机制文档 02-并发调度与限流退避.md §8.1 的条件只有 isOnlyUnfinishedTask，
      // 即上游在**首次**限流时就判 failed。理由与代价：
      //   上游代价 = 批次尾部任何一次瞬时限流都会直接判死，该成员永远没有第二次机会，
      //              限流本身高度瞬时（见 spike Q6：子代理内部还在自行重试 5 次），
      //              首次即弃会把可恢复的抖动变成终态失败；
      //   本实现 = 先按 retryBaseMs 退避重试一次；只有**持续**限流（retryCount>=1
      //              仍限流）才放弃，死锁防护的本意（不无限等）依然成立，且不会引入
      //              无限重排队——因为这条分支的判定在每次限流后重跑，不通过就 requeue，
      //              而"只剩它一个"意味着后续每次限流都满足条件，最迟下一次就判死。
      // 校准：retryCount 语义见同文件 #requeueRateLimited（每次 requeue 递增）。
      const error = ABANDONED_BY_RATE_LIMIT;
      const result: SwarmTaskResult = {
        spec: attempt.state.spec,
        outcome: "failed",
        state: this.#startedOf(attempt.state),
        ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }),
        error,
      };
      this.#results[attempt.state.index] = result;
      this.#deps.onAbandoned?.({
        spec: attempt.state.spec,
        ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }),
        outcome: "failed",
        error,
      });
    } else {
      this.#requeueRateLimited(attempt, outcome);
    }
    this.#schedule();
  }

  #handleAttemptError(attempt: Attempt, error: unknown): void {
    if (!this.#releaseAttempt(attempt)) return;
    if (this.#finished) return;
    this.#results[attempt.state.index] = this.#failedResult(attempt.state, this.#errorMessage(attempt, error));
    this.#schedule();
  }

  #releaseAttempt(attempt: Attempt): boolean {
    if (!this.#active.delete(attempt)) return false;
    attempt.cleanup();
    return true;
  }

  #isOnlyUnfinishedTask(state: TaskState): boolean {
    for (let i = 0; i < this.#results.length; i += 1) {
      if (i !== state.index && this.#results[i] === undefined) return false;
    }
    return true;
  }

  // ───────────────────────── 限流重排队 ─────────────────────────

  #requeueRateLimited(attempt: Attempt, outcome: { agentId?: string; error: unknown }): void {
    const state = attempt.state;
    if (outcome.agentId !== undefined) state.agentId = outcome.agentId;

    const now = this.#deps.now();
    this.#lastRateLimitAt = now;
    state.retryCount += 1;

    // 无抖动：retryBaseMs * retryFactor^(retryCount-1)
    const retryDelay = this.#config.retryBaseMs * this.#config.retryFactor ** (state.retryCount - 1);
    state.retryReadyAt = now + retryDelay;
    this.#pending.unshift(state);

    this.#deps.onSuspended?.({
      spec: state.spec,
      ...(state.agentId === undefined ? {} : { agentId: state.agentId }),
      reason: RATE_LIMIT_SUSPENDED_REASON,
      retryCount: state.retryCount,
      retryDelayMs: retryDelay,
      retryReadyAt: state.retryReadyAt,
    });

    this.#enterRateLimitMode(now);

    const classified = this.#deps.classify(outcome.error);
    if (!attempt.ready && classified === "first-request-blocked") {
      // 重罚：连首个请求都没发出去 → 全局间隔翻倍
      this.#globalRetryIntervalMs = Math.max(this.#globalRetryIntervalMs * 2, retryDelay);
      this.#nextRateLimitLaunchAt = Math.max(this.#nextRateLimitLaunchAt, now + this.#globalRetryIntervalMs);
    } else {
      // 轻罚：请求已发出，运行中才被限流 → 只推 retryBaseMs
      this.#nextRateLimitLaunchAt = Math.max(this.#nextRateLimitLaunchAt, now + this.#config.retryBaseMs);
    }
  }

  // ───────────────────────── 结果构造 ─────────────────────────

  /** `state` 属性：子代理是否真的启动过（与 outcome 正交）。 */
  #startedOf(state: TaskState): SwarmState {
    return state.started || state.agentId !== undefined ? "started" : "not_started";
  }

  /** 超时文案优先于原始错误（与机制文档 §12 的优先级一致）。 */
  #errorMessage(attempt: Attempt, error: unknown): string {
    if (attempt.timedOut) return TIMED_OUT;
    return error instanceof Error ? error.message : String(error);
  }

  #failedResult(state: TaskState, error: string): SwarmTaskResult {
    const message = error;
    return {
      spec: state.spec,
      outcome: "failed",
      state: this.#startedOf(state),
      ...(state.agentId === undefined ? {} : { agentId: state.agentId }),
      error: message,
    };
  }

  #abortedResult(state: TaskState, agentId: string | undefined): SwarmTaskResult {
    const started = state.started || state.agentId !== undefined;
    const id = agentId ?? state.agentId;
    return {
      spec: state.spec,
      outcome: "aborted",
      state: this.#startedOf(state),
      ...(id === undefined ? {} : { agentId: id }),
      error: started ? ABORTED_WHILE_RUNNING : ABORTED_BEFORE_START,
    };
  }

  #abandonSuspended(): void {
    for (const state of this.#pending) {
      if (state.agentId === undefined) continue;
      this.#deps.onAbandoned?.({
        spec: state.spec,
        agentId: state.agentId,
        outcome: "cancelled",
        error: ABORTED_BEFORE_START,
      });
    }
    for (const attempt of this.#active) {
      if (attempt.ready) continue;
      const agentId = attempt.state.agentId;
      if (agentId === undefined) continue;
      this.#deps.onAbandoned?.({
        spec: attempt.state.spec,
        agentId,
        outcome: "cancelled",
        error: ABORTED_BEFORE_START,
      });
    }
  }

  #finishWithAbort(): void {
    if (this.#finished) return;
    this.#clearNormalTimer();
    this.#clearRateLimitTimer();
    for (const attempt of this.#active) {
      attempt.controller.abort(this.#deps.signal?.reason);
    }
    const results = this.#states.map((state) => {
      const existing = this.#results[state.index];
      if (existing !== undefined) return existing;
      return this.#abortedResult(state, state.agentId);
    });
    this.#finish(results);
  }

  #finish(results: SwarmTaskResult[]): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#cleanup();
    this.#resolve?.(results);
  }

  #cleanup(): void {
    this.#deps.signal?.removeEventListener("abort", this.#onBatchAbort);
    this.#clearNormalTimer();
    this.#clearRateLimitTimer();
    for (const attempt of this.#active) attempt.cleanup();
    this.#active.clear();
  }

  #clearNormalTimer(): void {
    if (this.#normalLaunchTimer === undefined) return;
    this.#deps.clearTimeout(this.#normalLaunchTimer);
    this.#normalLaunchTimer = undefined;
  }

  #clearRateLimitTimer(): void {
    if (this.#rateLimitLaunchTimer === undefined) return;
    this.#deps.clearTimeout(this.#rateLimitLaunchTimer);
    this.#rateLimitLaunchTimer = undefined;
  }
}

/** 便捷入口。 */
export function runSwarm(
  specs: readonly SwarmTaskSpec[],
  deps: SwarmSchedulerDeps,
  config?: Partial<SwarmSchedulerConfig>,
): Promise<SwarmTaskResult[]> {
  return new SwarmScheduler(specs, deps, config).run();
}