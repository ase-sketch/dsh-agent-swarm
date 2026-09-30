/**
 * dsh-agent-swarm — 纯类型层（零 DSH 依赖）
 *
 * 设计依据：extracted/kimi-code-swarm-analysis/01-机制文档/ 的行为描述
 * （02-并发调度与限流退避.md、03-工具入参与校验规则.md、04-结果渲染与resume机制.md）。
 * clean-room 重写：未复制上游源码，未引用 02-v2源码/ 与 05-UI与API层/。
 */

/** 任务来源种类。一期只实现 `spawn`；`resume` 属二期 backlog（见 docs/spec.md「二期」）。 */
export type SwarmTaskKind = "spawn";
// 二期占位：export type SwarmTaskKind = "spawn" | "resume";
// 届时 SwarmTaskSpec 需增加 `agentId: string`（resume 目标），resume 型 spec 占前段编号，
// 且校验 1（items>=2）需放宽为 `resumeCount > 0 || itemCount >= 2`。

/** 一个子代理任务规格。`index` 全链一致：1 起始、顺序即 spec 顺序。 */
export interface SwarmTaskSpec {
  kind: SwarmTaskKind;
  /** 1-based 编号。结果落位与渲染顺序都以它为准，全链不得出现 0-based 混用。 */
  index: number;
  /** 填入 `{{item}}` 的原始 item 值（已 trim）。 */
  item: string;
  /** 展开后的完整 prompt。 */
  prompt: string;
}

/** 任务最终结果。 */
export type SwarmOutcome = "completed" | "failed" | "aborted";

/** 子代理是否真的启动过（与 outcome 正交，见 04-结果渲染与resume机制.md §4）。 */
export type SwarmState = "started" | "not_started";

/** 单任务结果。渲染成 `<subagent>` 元素。 */
export interface SwarmTaskResult {
  spec: SwarmTaskSpec;
  outcome: SwarmOutcome;
  state?: SwarmState;
  /** provider 返回的截断原因（如 `max_tokens`）。 */
  stopReason?: string;
  /** outcome === "completed" 时的子代理最终文本。 */
  result?: string;
  /** outcome !== "completed" 时的错误文案。 */
  error?: string;
  agentId?: string;
}

// ───────────────────────── 校验 ─────────────────────────

export const SWARM_ERROR_CODES = {
  /** items 少于 2（一期无 resume 运行时分支，故没有豁免路径）。 */
  ITEMS_TOO_FEW: "ITEMS_TOO_FEW",
  /** 展开后成员总数超过 128。 */
  TOO_MANY_SUBAGENTS: "TOO_MANY_SUBAGENTS",
  /** 某个 item 元素 trim 后为空串：每条 item 必须含至少 1 个非空白字符。 */
  ITEM_EMPTY: "ITEM_EMPTY",
  /** 某个 item 元素不是字符串：不做隐式强转，避免 123/null 被静默当成 item 派发。 */
  ITEM_NOT_STRING: "ITEM_NOT_STRING",
  /** 提供了 items 却没有 prompt_template。 */
  PROMPT_TEMPLATE_REQUIRED: "PROMPT_TEMPLATE_REQUIRED",
  /** prompt_template 不含 `{{item}}` 占位符。 */
  PROMPT_TEMPLATE_PLACEHOLDER_MISSING: "PROMPT_TEMPLATE_PLACEHOLDER_MISSING",
  /** 两个 item 展开出完全相同的 prompt。 */
  DUPLICATE_PROMPTS: "DUPLICATE_PROMPTS",
} as const;

export type SwarmErrorCode = (typeof SWARM_ERROR_CODES)[keyof typeof SWARM_ERROR_CODES];

/** 结构化校验错误：错误码 + 人可读 message + 可选机器可读 details。 */
export interface SwarmValidationError {
  code: SwarmErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** 工具入参（一期子集）。 */
export interface SwarmRequestInput {
  /** 整个 swarm 的简短描述（模型提供）。 */
  description?: string;
  /** 含 `{{item}}` 的 prompt 模板。 */
  promptTemplate?: string;
  /** 每个元素展开一个子代理。 */
  items?: readonly string[];
}

// ───────────────────────── 常量 ─────────────────────────

/** 成员总数硬上限。 */
export const SWARM_MAX_SUBAGENTS = 128;
/** 一期最小 items 数。 */
export const SWARM_MIN_ITEMS = 2;
/** 模板占位符字面量。 */
export const SWARM_PROMPT_PLACEHOLDER = "{{item}}";

// ───────────────────────── 调度器 ─────────────────────────

/** 调度器可调参数。默认值取自上游实测（02-并发调度与限流退避.md §1）。 */
export interface SwarmSchedulerConfig {
  /** 正常模式无间隔连发个数（"首波"）。 */
  initialLaunchLimit: number;
  /** 首波之后每个任务的放量间隔。 */
  initialLaunchIntervalMs: number;
  /** 限流退避基数。 */
  retryBaseMs: number;
  /** 退避指数因子（无抖动）。 */
  retryFactor: number;
  /** 两次容量收缩之间的最小间隔（防抖）。 */
  capacityShrinkDebounceMs: number;
  /** 容量恢复的检查间隔。 */
  capacityRecoveryIntervalMs: number;
  /** 硬并发上限；undefined = 无上限（只受节奏与限流约束）。 */
  maxConcurrency?: number;
  /** 单任务超时；undefined 或 <=0 = 不超时。 */
  timeoutMs?: number;
}

export const DEFAULT_SWARM_SCHEDULER_CONFIG: SwarmSchedulerConfig = {
  initialLaunchLimit: 5,
  initialLaunchIntervalMs: 700,
  retryBaseMs: 3000,
  retryFactor: 2,
  capacityShrinkDebounceMs: 2000,
  capacityRecoveryIntervalMs: 180_000,
};

/** 限流惩罚档位建议。执行函数无法区分时返回 `in-flight-limited`（轻罚，安全默认）。 */
export type SwarmRateLimitClass = "first-request-blocked" | "in-flight-limited";

/** 单次尝试的成功返回。 */
export interface SwarmAttemptResult {
  /** 子代理最终文本。 */
  result?: string;
  /** provider 返回的截断原因。 */
  stopReason?: string;
}

/** 注入给执行函数的单次尝试上下文。 */
export interface SwarmAttemptContext {
  /** 第几次尝试（1-based）。 */
  readonly attempt: number;
  readonly signal: AbortSignal;
  /**
   * 执行函数在「子代理已向 provider 发出首个请求」时调用。
   * 这是区分「首个请求未发出就被限流」（重罚）与「运行中被限流」（轻罚）的唯一依据。
   */
  markReady(): void;
  /** 记录本次尝试拿到的 agentId（成功或失败都可调用）。 */
  setAgentId(agentId: string): void;
  /**
   * 上一次尝试拿到的 agentId（仅在本任务因限流被重排队后存在）。
   * 执行函数应优先复用它做"重试原 agent"，而不是重新 spawn 一个新成员。
   */
  readonly previousAgentId?: string;
}

/** 执行函数：跑一个 spec。限流通过 reject 抛出，由 isRateLimitError 判定。 */
export interface SwarmExecutor {
  run(spec: SwarmTaskSpec, context: SwarmAttemptContext): Promise<SwarmAttemptResult>;
}

/** 定时器句柄。真实实现为 NodeJS.Timeout，测试为 vitest fake timer 返回值。 */
export type SwarmTimerHandle = unknown;

/** 调度器全部外部依赖（时钟、定时器、执行、限流判定、批次信号）。 */
export interface SwarmSchedulerDeps {
  /** 单调时钟，毫秒。 */
  now(): number;
  setTimeout(handler: () => void, ms: number): SwarmTimerHandle;
  clearTimeout(handle: SwarmTimerHandle): void;
  /** 执行函数。 */
  executor: SwarmExecutor;
  /** 限流判定门：true 表示该错误应重排队而非判终态 failed。 */
  isRateLimitError(error: unknown): boolean;
  /** 限流惩罚档位建议（仅在 isRateLimitError 为 true 时有意义）。 */
  classify(error: unknown): SwarmRateLimitClass;
  /** 任务被限流挂起（重排队）时的回调。 */
  onSuspended?(event: SwarmSuspendedEvent): void;
  /** 任务被放弃（死锁防护 / 批次取消）时的回调。 */
  onAbandoned?(event: SwarmAbandonedEvent): void;
  /** 批次级中断信号。 */
  signal?: AbortSignal;
}

export interface SwarmSuspendedEvent {
  spec: SwarmTaskSpec;
  agentId?: string;
  reason: string;
  /** 该任务因限流被重排队的累计次数（1 = 第一次）。 */
  retryCount: number;
  /** 本次计算出的重试延迟（毫秒，无抖动）。 */
  retryDelayMs: number;
  /** 最早可重试的时刻（`deps.now()` 坐标系）。 */
  retryReadyAt: number;
}

export interface SwarmAbandonedEvent {
  spec: SwarmTaskSpec;
  agentId?: string;
  outcome: "failed" | "cancelled";
  error: string;
}