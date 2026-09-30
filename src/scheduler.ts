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
 *   死锁防护   判死条件是**双重（or）**，两条各自独立成立即判 failed、不再无限重排队：
 *             ① 单成员尾部：只剩它一个未完成 且 它已退避重试过（retryCount>=1）仍限流；
 *             ② per-task 上限：它自己的 retryCount 已达 config.maxRateLimitRetries。
 *             ② 与"是否唯一未完成"**无关**——缺了它，≥2 个成员同时持续限流时 ① 恒不成立，
 *             而退避分支没有上限，批次会被无限重排队、批次 Promise 永不 resolve
 *             （2026-10-01 审查实测：2 成员 / 3 成员各推进 1 小时虚拟时间，settled 恒 false）。
 *             maxRateLimitRetries 未设（undefined）时 ② 不成立，等价于该字段引入前的行为。
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
 *   5. 宿主注入的函数（onSuspended / onAbandoned / classify）抛错不再逃逸：就地收下并
 *      **并进该成员的结果文案**，调度继续跑完整批。上游未描述该情形；但逃逸的代价是整批
 *      静默停摆，且错误从"该成员的结果"里彻底消失（既未处理 rejection、又没落任何文案）。
 *   6. 限流模式下"有 pending 且未结束"时**必然**留下一个未来的唤醒定时器：唤醒候选时刻
 *      （全局节流 / 退避就绪 / 容量恢复）可能是过去时，此时不再直接丢弃，而是退到容量恢复
 *      刻度。理由与覆盖的返回路径见 #scheduleNextRateLimitWakeup。
 */

import {
  DEFAULT_SWARM_SCHEDULER_CONFIG,
  type SwarmAbandonedEvent,
  type SwarmAttemptContext,
  type SwarmAttemptResult,
  type SwarmRateLimitClass,
  type SwarmSchedulerConfig,
  type SwarmSchedulerDeps,
  type SwarmState,
  type SwarmSuspendedEvent,
  type SwarmTaskResult,
  type SwarmTaskSpec,
  type SwarmTimerHandle,
} from "./types.js";

/**
 * 限流挂起原因文案（写进 onSuspended 事件，供 UI/日志使用）。
 *
 * clean-room：本仓自拟英文文案（语义 = provider 限流、该成员已重排队等待重试），
 * 与上游同语义文本不存在连续 6 词重合。改写它不影响任何机器判定——
 * 机器判定只看 onSuspended 的 retryCount / retryReadyAt 与 outcome，不看这句人读文案。
 */
export const RATE_LIMIT_SUSPENDED_REASON =
  "The provider applied a rate limit to this member; it is back in the queue and will be retried.";

const ABORTED_WHILE_RUNNING = "The swarm was interrupted before this member finished.";
const ABORTED_BEFORE_START = "The swarm was interrupted before this member was started.";
const TIMED_OUT = "Subagent timed out.";
const ABANDONED_BY_RATE_LIMIT =
  "Subagent was still rate limited while it was the only unfinished member; the swarm gave up on it.";

/**
 * 判死条件的第二条（per-task 重试上限）专用文案。
 *
 * 为什么与 ABANDONED_BY_RATE_LIMIT 分开而不是复用：两条判死路径的原因不同——
 * 前者是"批次尾部只剩它，腾不出别人来"；后者是"它自己重试次数到顶了"（哪怕旁边还有别的成员在跑）。
 * 共用一句会让"为什么被放弃"在成员多于一个时彻底说不清，排查时只能靠猜。
 */
const ABANDONED_BY_RETRY_LIMIT = (limit: number): string =>
  `Subagent stayed rate limited after ${String(limit)} retries; the swarm gave up on it.`;

/**
 * 宿主回调抛错告警前缀。并进受影响成员的结果文案，保证"没被吞掉"这件事在任何 outcome
 * 下都可观测：completed 走 `result`、failed/aborted 走 `error`——与 result-xml.ts 的
 * bodyOf 取值口径一致，否则 completed 成员的告警渲染后不可见。
 */
const HOST_CALLBACK_FAILED = "host callback failed";

/** 把该成员累计的宿主回调失败以 `; ` 追加到结果文案后（不覆盖原文案；空文案不带前导分隔符）。 */
function appendHostCallbackFailures(text: string, failures: readonly string[]): string {
  if (failures.length === 0) return text;
  const notes = failures.map((failure) => `${HOST_CALLBACK_FAILED}: ${failure}`).join("; ");
  return text === "" ? notes : `${text}; ${notes}`;
}

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
  /**
   * 宿主回调在本成员身上抛出的错误（`<message> (from <source>)`）。跨重试保留：
   * 抛错发生在调用回调的那一刻，而该成员的结果要到之后才成形——记在任务状态上，
   * 才能保证最终结果一定带着它（见 #withHostFailures）。
   */
  hostFailures: string[];
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
  /** 首次 run() 返回的批次 Promise；重复调用原样返回它（见 run 的幂等说明）。 */
  #runPromise: Promise<SwarmTaskResult[]> | undefined;
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
    // maxConcurrency 是可选参数（undefined = 无上限），但**给定**就必须是 >= 1 的整数：
    //   0  → `active.size >= 0` 恒真 → 限流模式静默不放量（且不装任何唤醒）；
    //   NaN → 与任何数比较都 false → 闸门形同虚设；
    //   负数/小数 → 同上或语义不明。
    // 三者都会把"只有非法 config 才会抛"的契约变成静默失效，所以在构造期一并挡掉。
    if (this.#config.maxConcurrency !== undefined) {
      const maxConcurrency = this.#config.maxConcurrency;
      if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
        throw new Error(`maxConcurrency must be an integer >= 1 when set, got ${String(maxConcurrency)}.`);
      }
    }
    // maxRateLimitRetries 同理：undefined = 无上限（向后兼容），给定就必须是 >= 1 的整数。
    // 0 / NaN / 小数 / 负数分别会变成"第一次限流就判死"/"比较恒假"/"语义不明"/"第一次就判死"，
    // 即把这条判死条件变成静默失效或语义漂移——与 maxConcurrency 同样在构造期挡掉。
    if (this.#config.maxRateLimitRetries !== undefined) {
      const maxRateLimitRetries = this.#config.maxRateLimitRetries;
      if (!Number.isInteger(maxRateLimitRetries) || maxRateLimitRetries < 1) {
        throw new Error(
          `maxRateLimitRetries must be an integer >= 1 when set, got ${String(maxRateLimitRetries)}.`,
        );
      }
    }
    this.#deps = deps;
    this.#globalRetryIntervalMs = this.#config.retryBaseMs;
    this.#states = specs.map((spec, i) => ({
      index: i,
      spec,
      retryCount: 0,
      retryReadyAt: 0,
      started: false,
      hostFailures: [],
    }));
    this.#results = new Array<SwarmTaskResult | undefined>(specs.length);
    this.#pending = [...this.#states];
  }

  /**
   * 启动批次；**幂等**——重复调用返回首次启动的那个 Promise。
   *
   * 为什么选"返回同一个 Promise"而不是"第二次抛错"：
   *   ① 类契约是"该 Promise 只会 resolve（批次级失败以 failed 结果落位），唯一会 reject
   *      的情况是非法 config"；第二次调用 run() 不是非法 config，抛错会让调用方拿到契约外
   *      的异常，还可能被误判成"批次失败"；
   *   ② 旧实现每次调用都新建 Promise 并覆盖 #resolve，首个 Promise 会永远挂着、且**没有任何
   *      可观测信号**——幂等正是消除该形态的最小手段；
   *   ③ 宿主侧更安全：重入（重试包装、卸载后重挂再跑）拿到的是同一批结果，而不是第二次调度。
   */
  run(): Promise<SwarmTaskResult[]> {
    if (this.#runPromise !== undefined) return this.#runPromise;
    const promise = new Promise<SwarmTaskResult[]>((resolve) => {
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
    this.#runPromise = promise;
    return promise;
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
    //（统一走 funnel，让"有 pending 就有未来唤醒"这一不变量只有一个武装点）
    if (this.#active.size >= this.#rateLimitCapacity) {
      this.#scheduleNextRateLimitWakeup(now);
      return;
    }

    // ② 下一个可放量时刻 = max(全局节流, 最早就绪任务)
    const nextAllowedAt = Math.max(this.#nextRateLimitLaunchAt, this.#nextPendingReadyAt());
    const nextWakeupAt = Math.min(nextAllowedAt, this.#nextCapacityRecoveryAt());
    if (nextWakeupAt > now) {
      // funnel 会用同样的输入算出同一个时刻（此刻 active < 容量，故取 min(...) 分支）。
      this.#scheduleNextRateLimitWakeup(now);
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
    if (pendingIndex === -1) {
      // 理论上不可达（推导见 #nextRateLimitWakeupAt），但同样不允许裸 return：
      // 只要 pending 非空，就必须留下唤醒。
      this.#scheduleNextRateLimitWakeup(now);
      return;
    }
    const [state] = this.#pending.splice(pendingIndex, 1) as [TaskState];
    this.#startAttempt(state);
    this.#nextRateLimitLaunchAt = now + this.#globalRetryIntervalMs;
    this.#scheduleNextRateLimitWakeup(now);
  }

  /** 武装唤醒定时器。调用方（#nextRateLimitWakeupAt）保证 wakeupAt 有限且在未来。 */
  #scheduleRateLimitWakeup(wakeupAt: number, now: number): void {
    if (!Number.isFinite(wakeupAt) || wakeupAt <= now) return; // 兜底：不装一个立即自旋的定时器
    this.#rateLimitLaunchTimer = this.#deps.setTimeout(() => {
      this.#rateLimitLaunchTimer = undefined;
      this.#schedule();
    }, wakeupAt - now);
  }

  /**
   * 限流模式下**唯一**的唤醒武装点，且是"全函数"：只要 pending 非空，就必然留下未来的定时器。
   *
   * 为什么必须做成全函数：唤醒时刻由四个来源共同决定（全局节流、退避就绪、容量恢复、
   * 并发闸门），其中 maxConcurrency 的释放时刻**不可预测**——只能等某个在跑成员 settle。
   * 于是"下一个可放量时刻"完全可能是过去时（典型：退避早就到期，但满并发一直压着）。
   * 旧实现在这种情形下直接把唤醒丢掉，批次就只能靠"恰好有人 settle"续命；
   * 实测：满并发且无 settle 时推进 4.5e6 虚拟毫秒，仍是 active=1 / pending=7。
   *
   * 覆盖的返回路径——#scheduleRateLimitLaunch 的每一个出口都汇到这里，不再有旁路：
   *   ① 在跑数 ≥ 容量；② 放量时刻未到；③ 并发闸门已满；④ 找不到就绪任务（理论上不可达）；
   *   ⑤ 刚放量一个之后。
   * ① 的候选（容量恢复刻度）天然在未来；② 已经过 `> now` 判定；③④⑤ 若候选已过期，
   * 则由 #nextRateLimitWakeupAt 退到容量恢复刻度。合起来即"有 pending 且未结束 ⇒ 有未来唤醒"。
   */
  #scheduleNextRateLimitWakeup(now: number): void {
    if (this.#pending.length === 0) return;
    this.#scheduleRateLimitWakeup(this.#nextRateLimitWakeupAt(now), now);
  }

  /**
   * 计算下一次限流唤醒时刻，返回值**必然 > now**（因此在 #scheduleRateLimitWakeup 里一定会装上）。
   *
   * 候选过期时退到容量恢复刻度，而不是随便退一个短间隔（例如 now + 1）：容量恢复是由时钟
   * 决定、**必然发生在未来**的下一个状态变化点（#recoverRateLimitCapacity 在同一轮已把恢复
   * 时刻推到 now 之后），所以它既保证"定时器真的会触发一次状态变化"，又不会退化成忙等
   * ——恢复间隔是 180s 量级，每轮最多多一次 tick。
   */
  #nextRateLimitWakeupAt(now: number): number {
    const candidate =
      this.#active.size >= this.#rateLimitCapacity
        ? this.#nextCapacityRecoveryAt()
        : Math.min(
            Math.max(this.#nextRateLimitLaunchAt, this.#nextPendingReadyAt()),
            this.#nextCapacityRecoveryAt(),
          );
    if (Number.isFinite(candidate) && candidate > now) return candidate;
    const recoveryAt = this.#nextCapacityRecoveryAt();
    if (Number.isFinite(recoveryAt) && recoveryAt > now) return recoveryAt;
    // 兜底（限流模式下 lastRateLimitAt 必有值、且此处 pending 非空，故理论上不可达）：
    // 仍要给出一个有限且未来的复查刻度，绝不静默返回。
    const interval = this.#config.capacityRecoveryIntervalMs;
    return now + (Number.isFinite(interval) && interval > 0 ? interval : 1);
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

  /**
   * 容量恢复：每满 capacityRecoveryIntervalMs 就把容量 +1（无上界）。
   *
   * **为什么不设上界（父代理 2026-10-01 判定，勿加 ceiling）**：
   *   ① 唯一实际风险是"容量超过宿主设定的并发上限"，而这道闸门由 maxConcurrency 独立把关
   *      （#isAtConcurrencyLimit；限流模式下两个闸门都要过），容量再大也放不出超过
   *      maxConcurrency 的并发——上限的收益是零。
   *   ② 反过来，给容量设硬上限会把"可自愈"变成"可能永久锁死"：早期一次瞬时限流把容量压到 1
   *      之后，只要上界恰好等于当时的容量，恢复就再也推不动容量，批次只能靠成员陆续 settle
   *      慢慢磨。
   *   ③ 容量只影响"何时放量"的节奏，不影响正确性；因此收紧它带来的风险大于收益。
   */
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
    return { type: "settled", result: this.#withHostFailures(state, result) };
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

    const deathError = outcome.type === "settled" ? undefined : this.#rateLimitDeathCause(attempt.state);
    if (outcome.type === "settled") {
      this.#results[attempt.state.index] = outcome.result;
    } else if (deathError !== undefined) {
      // 死锁防护：两条判死条件任一成立即判 failed（详见 #rateLimitDeathCause）。
      const error = deathError;
      const result: SwarmTaskResult = {
        spec: attempt.state.spec,
        outcome: "failed",
        state: this.#startedOf(attempt.state),
        ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }),
        error,
      };
      this.#results[attempt.state.index] = result;
      this.#callHostCallback(attempt.state, "onAbandoned", () => {
        this.#deps.onAbandoned?.({
          spec: attempt.state.spec,
          ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }),
          outcome: "failed",
          error,
        });
      });
      // 该分支的结果在调用回调**之前**就落了位，回调抛错同样不得静默：把告警补进文案。
      this.#results[attempt.state.index] = this.#withHostFailures(attempt.state, result);
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

  /**
   * 限流判死判定：**双重（or）**，任一条件成立就返回该成员的失败文案，否则返回 undefined。
   *
   * ① 单成员尾部（原有条件，保留）：只剩它一个未完成 且 已退避重试过（retryCount>=1）仍限流。
   *   它覆盖"排在我后面的都没了、也腾不出别人来"的批次尾部场景；
   *   相对上游机制文档 §8.1 的**有意放宽**（上游首次限流即判死）理由不变：
   *   限流高度瞬时，首次即弃会把可恢复的抖动变成终态失败，故先给 retryBaseMs 退避一次。
   *
   * ② per-task 重试上限（新增，与"是否唯一未完成"无关）：retryCount >= maxRateLimitRetries。
   *   **为什么必须有它**：① 在 ≥2 个成员同时持续限流时恒为 false（每个成员都还"有别人没完成"），
   *   而重排队分支没有次数上限 → 无限重排队，批次 Promise 永不 resolve。
   *   2026-10-01 实测：2 成员 / 3 成员同时持续限流、各推进 1 小时虚拟时间，settled 恒 false，
   *   onAbandoned 0 次。② 让这条路必然落定，且按成员各自计数——一个成员限流到顶，
   *   不会连坐拖死同批仍在健康跑完的其它成员。
   *
   * 两条各自独立成立即判死，且文案可区分（调用方据此能说出"为什么被放弃"）。
   * 校准：retryCount 语义见 #requeueRateLimited——每次 requeue 递增 1，故
   * "已重排队 N 次后仍在第 N+1 次尝试里限流"时 retryCount === N。
   */
  #rateLimitDeathCause(state: TaskState): string | undefined {
    if (this.#isOnlyUnfinishedTask(state) && state.retryCount >= 1) {
      return ABANDONED_BY_RATE_LIMIT;
    }
    const limit = this.#config.maxRateLimitRetries;
    if (limit !== undefined && state.retryCount >= limit) {
      return ABANDONED_BY_RETRY_LIMIT(limit);
    }
    return undefined;
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

    this.#callHostCallback(state, "onSuspended", () => {
      this.#deps.onSuspended?.({
        spec: state.spec,
        ...(state.agentId === undefined ? {} : { agentId: state.agentId }),
        reason: RATE_LIMIT_SUSPENDED_REASON,
        retryCount: state.retryCount,
        retryDelayMs: retryDelay,
        retryReadyAt: state.retryReadyAt,
      });
    });

    this.#enterRateLimitMode(now);

    const classified = this.#classifyRateLimit(state, outcome.error);
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
    return this.#describeThrown(error);
  }

  #describeThrown(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }

  // ───────────────────────── 宿主回调容纳 ─────────────────────────

  /**
   * 调用宿主注入的回调；抛错一律就地收下并记到该成员身上。
   *
   * 为什么必须收：这些回调是在 `#runAttempt(...).then(onOk, onErr)` 的 continuation 里被
   * **同步**调用的。抛错会同时造成两件事——
   *   (a) 该 continuation 变成一个**未处理 rejection**：宿主只看到"调度器炸了"，
   *       而没有任何成员的结果能反映它（错误从可观测面上消失）；
   *   (b) 紧随其后的 `#schedule()` 被跳过 → 不再武装任何定时器 → 批次永不收尾。
   * 收下之后 (b) 自动消失，而 (a) 的可观测性由 #withHostFailures 兜住。
   */
  #callHostCallback(state: TaskState, source: string, call: () => void): void {
    try {
      call();
    } catch (thrown) {
      state.hostFailures.push(`${this.#describeThrown(thrown)} (from ${source})`);
    }
  }

  /**
   * 取限流档位；`deps.classify` 抛错时按契约里的安全默认继续（轻罚），并记录告警。
   * 默认值依据 types.ts 的契约说明："执行函数无法区分时返回 in-flight-limited（轻罚，安全默认）"。
   */
  #classifyRateLimit(state: TaskState, error: unknown): SwarmRateLimitClass {
    try {
      return this.#deps.classify(error);
    } catch (thrown) {
      state.hostFailures.push(`${this.#describeThrown(thrown)} (from classify)`);
      return "in-flight-limited";
    }
  }

  /**
   * 把该成员累计的宿主回调失败并进结果文案——不静默吞掉，也不改动"谁成功了"这一事实。
   *
   * 字段选择必须跟着渲染口径走（result-xml.ts 的 bodyOf）：completed 的正文取 `result`，
   * 其余取 `error`；若一律写 error，completed 成员的告警渲染后就不见了——那等于静默吞掉。
   */
  #withHostFailures(state: TaskState, result: SwarmTaskResult): SwarmTaskResult {
    if (state.hostFailures.length === 0) return result;
    if (result.outcome === "completed") {
      return { ...result, result: appendHostCallbackFailures(result.result ?? "", state.hostFailures) };
    }
    return { ...result, error: appendHostCallbackFailures(result.error ?? "", state.hostFailures) };
  }

  #failedResult(state: TaskState, error: string): SwarmTaskResult {
    const message = error;
    return this.#withHostFailures(state, {
      spec: state.spec,
      outcome: "failed",
      state: this.#startedOf(state),
      ...(state.agentId === undefined ? {} : { agentId: state.agentId }),
      error: message,
    });
  }

  #abortedResult(state: TaskState, agentId: string | undefined): SwarmTaskResult {
    const started = state.started || state.agentId !== undefined;
    const id = agentId ?? state.agentId;
    return this.#withHostFailures(state, {
      spec: state.spec,
      outcome: "aborted",
      state: this.#startedOf(state),
      ...(id === undefined ? {} : { agentId: id }),
      error: started ? ABORTED_WHILE_RUNNING : ABORTED_BEFORE_START,
    });
  }

  /**
   * 批次中断时，把所有"还没走到终态"的成员统一通知宿主：它们已被放弃。
   *
   * 必须覆盖两类，缺一类宿主就收不到终态：
   *   ① 仍在队列里的成员——既可能是**从未启动**的排队成员（没有 agentId），
   *      也可能是限流重排队后带着上一次尝试 agentId 的成员；
   *   ② 已建好但还没 markReady 的尝试——首个请求尚未真正生效。
   *
   * 为什么不能按 "agentId 是否存在" 过滤：SwarmAbandonedEvent.agentId 在契约里是
   * **可选**的（types.ts:192，agentId?: string），所以未启动成员照样要发这条事件；
   * 按 agentId 过滤会让它们在宿主的 registry 里永久停在 pending，批次被 endBatch
   * 推导成 failed，与 XML 侧"全员 aborted"的结论互相矛盾。缺省语义 = 不带该字段，
   * 而不是补一个假 id（agentId 是宿主跳转/resume 的凭据，伪造比缺失更危险）。
   *
   * 已经 ready 的尝试不在这里处理：它们由 abort 路径在宿主侧各自落终态
   * （子代理 run.result 回执 / 超时），在这里重复通知会让宿主看到两次终态事件。
   */
  #abandonSuspended(): void {
    // 这里的 onAbandoned 同样走在同步路径上（#onBatchAbort → 本方法 → #finishWithAbort）：
    // 回调抛错若逃逸，#finishWithAbort 就被跳过，批次在中断时同样永不收尾。故一律收下。
    for (const state of this.#pending) {
      this.#callHostCallback(state, "onAbandoned", () => {
        this.#deps.onAbandoned?.({
          spec: state.spec,
          ...(state.agentId === undefined ? {} : { agentId: state.agentId }),
          outcome: "cancelled",
          error: ABORTED_BEFORE_START,
        });
      });
    }
    for (const attempt of this.#active) {
      if (attempt.ready) continue;
      const agentId = attempt.state.agentId;
      this.#callHostCallback(attempt.state, "onAbandoned", () => {
        this.#deps.onAbandoned?.({
          spec: attempt.state.spec,
          ...(agentId === undefined ? {} : { agentId }),
          outcome: "cancelled",
          error: ABORTED_BEFORE_START,
        });
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