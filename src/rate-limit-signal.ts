/**
 * dsh-agent-swarm — 子代理限流信号（纯逻辑，零 DSH 运行时依赖）
 *
 * 为什么需要它（spike Q6）：in-process 子代理的结果只有 stopReason，没有失败码——
 * 429 在子代理内部的重试层被吃掉，重试耗尽后父层只看到 `stopReason: "error"`。
 * 失败码只存在于**子会话的事件**里：
 *   - `llm/retry`：每次计划内重试前追加，data.failure.code 是这次失败的码（dsh-llm-retry）；
 *   - `turn/end`：轮次结束时追加，失败收场时 data.reason = { kind: "error", error: failure }，
 *     error.code 就是**最终**导致失败的码（dsh-agent-loop）。
 * 本模块按子会话 id 收集这两类事件，并在子代理以 error 收场时判定"是不是限流把它拖死的"。
 *
 * 判定口径：stopReason === "error" 且最终失败码属于限流码集合（默认 ["RATE_LIMIT"]）；
 * 拿不到最终失败码时，退而看**收场那一轮**最后一次 llm/retry 的失败码（不跨轮沿用）。
 *
 * ⚠️ 待实机验证（M3 / spike R1）：失败码的实际取值、事件 data 形状、插件级 `session/event`
 * 监听能否收到子会话事件、子会话 id 是否等于 run.id。因此宿主侧默认**关闭**（config.rateLimit.enabled），
 * 关闭时本模块完全不被调用，运行时行为与引入前逐字节一致。
 *
 * 为什么是"实时观察"而不是事后读日志：DSH 已废弃全部同步读事件的 API
 * （Session.ownEvents / snapshotEvents / eventAt 均标注 "new calls are prohibited"），
 * 受支持的读法是 `session/event` 追加事件流。
 */

/** 子会话事件的最小形状（DSH SessionEvent 的 { type, data } 两个字段）。 */
export interface ChildSessionEventLike {
  type: string;
  data?: unknown;
}

export interface RateLimitSignalConfig {
  /** 判定为限流的失败码（待实机验证；DSH 的 DeepSeek 适配器把 429 映射为 "RATE_LIMIT"）。 */
  failureCodes: readonly string[];
}

/** 一次子代理运行收场时的限流判定。 */
export interface RateLimitAssessment {
  /** 是否判为"被限流拖死"（应重排队退避，而不是落终态 failed）。 */
  rateLimited: boolean;
  /** 观测到的限流类重试次数（子代理内部重试层的计数，仅供说明）。 */
  rateLimitRetries: number;
  /** 判定所依据的失败码（最终失败码优先，其次最后一次重试的失败码）。 */
  failureCode: string | undefined;
}

/** 本模块关心的事件类型；其余事件在路由入口处就被丢弃（监听器会收到进程内所有会话的所有事件）。 */
const WATCHED_EVENT_TYPES: ReadonlySet<string> = new Set(["llm/retry", "turn/end"]);

/** 从 unknown 里按路径取字符串字段（形状不符一律 undefined，绝不抛错）。 */
function stringAt(value: unknown, ...path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

/** 单个子代理运行的观察窗：只累计判定所需的量。 */
export class ChildRunWatch {
  private retryCount = 0;
  /** **当前轮**最后一次重试的失败码；每到 turn/end 清空，绝不跨轮沿用。 */
  private turnRetryCode: string | undefined;
  /** 最近一次轮末的失败码（该轮以 error 收场时）；轮末缺码时取该轮最后一次重试的码。 */
  private finalFailureCode: string | undefined;

  constructor(private readonly config: RateLimitSignalConfig) {}

  observe(event: ChildSessionEventLike): void {
    if (event.type === "llm/retry") {
      const code = stringAt(event.data, "failure", "code");
      this.turnRetryCode = code;
      if (code !== undefined && this.config.failureCodes.includes(code)) this.retryCount += 1;
      return;
    }
    if (event.type === "turn/end") {
      // 只看**收场那一轮**：前面某轮里已经恢复了的限流重试，不能把后面一轮无关的失败染成"限流"。
      this.finalFailureCode =
        stringAt(event.data, "reason", "kind") === "error"
          ? (stringAt(event.data, "reason", "error", "code") ?? this.turnRetryCode)
          : undefined;
      this.turnRetryCode = undefined;
    }
  }

  assess(stopReason: string): RateLimitAssessment {
    // 没有收到轮末事件（例如宿主没送达）时，退而看当前轮最后一次重试的码。
    const failureCode = this.finalFailureCode ?? this.turnRetryCode;
    return {
      rateLimited:
        stopReason === "error" && failureCode !== undefined && this.config.failureCodes.includes(failureCode),
      rateLimitRetries: this.retryCount,
      failureCode,
    };
  }
}

/**
 * 子会话 id → 观察窗 的路由器。宿主把 `session/event` 的每一条事件交给 dispatch；
 * 只有被 watch 的子会话、且属于关心的事件类型才会被记录，其余在入口丢弃（O(1)）。
 *
 * 不做"watch 之前的事件缓冲"：判定依据的 `turn/end` 必然发生在 start() 返回之后
 * （子代理至少要跑完一轮），watch 在 start() 返回的同一个 tick 内建立，不会漏掉它。
 */
export class RateLimitWatchRouter {
  private readonly watches = new Map<string, ChildRunWatch>();

  constructor(private readonly config: RateLimitSignalConfig) {}

  watch(childSessionId: string): ChildRunWatch {
    const watch = new ChildRunWatch(this.config);
    this.watches.set(childSessionId, watch);
    return watch;
  }

  release(childSessionId: string): void {
    this.watches.delete(childSessionId);
  }

  dispatch(sessionId: string, event: ChildSessionEventLike): void {
    if (!WATCHED_EVENT_TYPES.has(event.type)) return;
    this.watches.get(sessionId)?.observe(event);
  }

  /** 当前在观察的子会话数（测试与诊断用）。 */
  get size(): number {
    return this.watches.size;
  }
}
