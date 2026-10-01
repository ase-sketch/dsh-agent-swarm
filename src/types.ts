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
  /**
   * 入参本身不是对象（undefined / null / 数组 / 原始值 / 函数）。
   *
   * 为什么单列一条而不是复用 ITEMS_TOO_FEW：那条码描述的是"数量不够"，
   * 它的 message 与 details 都会把调用方引去数条数；而入参压根不是对象时
   * 调用方要改的是**入参本身**，报"至少需要 2 条"是误导。
   * 放在表首——它是所有其它校验的前置条件（见 validate.ts 的入口防护）。
   */
  INVALID_INPUT: "INVALID_INPUT",
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
  /**
   * 给了 per-call `model`，但宿主的子代理模型选择不可用：
   * 设置服务未挂载、或已挂载但 enabled=false。
   * 权威源是宿主 `subagentModelSelection` 服务（设置页「子智能体 → Model selection」），
   * 插件不自备第二份白名单（一事一处）。
   */
  MODEL_SELECTION_UNAVAILABLE: "MODEL_SELECTION_UNAVAILABLE",
  /** per-call `model` 解析出的路由不在宿主白名单内。 */
  MODEL_NOT_ALLOWED: "MODEL_NOT_ALLOWED",
  /** 裸 model id 命中多个 provider 的路由，必须改写成 `provider/model` 精确式。 */
  MODEL_AMBIGUOUS: "MODEL_AMBIGUOUS",
  /**
   * 调用方 agent 已处在委派深度上限：它的成员会超出宿主的子代理深度限制（默认 1）。
   * 典型场景是 swarm 成员自己又调 agent_swarm（嵌套 swarm）。在开批次之前整体拒绝，
   * 而不是让每个成员各自在 start() 处撞上 DSH 的深度检查。
   */
  DELEGATION_DEPTH_EXCEEDED: "DELEGATION_DEPTH_EXCEEDED",
  /** `context` 参数不是受支持的取值（"fresh" | "fork"）。 */
  CONTEXT_MODE_INVALID: "CONTEXT_MODE_INVALID",
  /** 要求 fork 上下文，但宿主没有挂载 fork 子代理 provider。 */
  FORK_UNAVAILABLE: "FORK_UNAVAILABLE",
  /**
   * fork 与 per-call `model` 同时出现。fork 的价值在于子代理复用父会话的 KV cache 前缀，
   * 换路由会让继承的历史在新模型上整段重算；DSH 官方 fork 工具同样不开放路由选择。
   */
  FORK_MODEL_CONFLICT: "FORK_MODEL_CONFLICT",
} as const;

export type SwarmErrorCode = (typeof SWARM_ERROR_CODES)[keyof typeof SWARM_ERROR_CODES];

/** 结构化校验错误：错误码 + 人可读 message + 可选机器可读 details。 */
export interface SwarmValidationError {
  code: SwarmErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** 工具入参。 */
export interface SwarmRequestInput {
  /** 整个 swarm 的简短描述（模型提供）。 */
  description?: string;
  /** 含 `{{item}}` 的 prompt 模板。 */
  promptTemplate?: string;
  /** 每个元素展开一个子代理。 */
  items?: readonly string[];
  /**
   * 可选的整批 LLM 路由：`"provider/model"` 精确式，或白名单内唯一的裸 model id。
   * 缺省 = 沿用插件 config 的固定路由，再缺省 = 继承父 agent 路由。
   */
  model?: string;
  /** 成员的起始上下文（缺省 "fresh"），见 {@link SwarmContextMode}。 */
  context?: string;
}

/**
 * 成员的起始上下文：
 *   - "fresh"：全新子代理，只看到自己的 prompt（默认；DSH spawn provider）；
 *   - "fork"：以调用方会话**已完成的轮次**为种子（DSH fork provider；当前进行中的轮次不含在内）。
 */
export type SwarmContextMode = "fresh" | "fork";

/** 一条精确的 provider/model 路由（宿主白名单的元素形状）。 */
export interface SwarmModelRoute {
  provider: string;
  model: string;
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
  /**
   * 单成员限流重试上限：**与"是否唯一未完成"无关**的兜底判死阈值。
   *
   * 为什么需要它（2026-10-01 审查实证）：原判死条件只认"只剩它一个未完成且 retryCount>=1"，
   * 于是 ≥2 个成员**同时**持续限流时该条件恒不成立，而退避分支没有上限——
   * 批次被无限重排队，批次 Promise 永不 resolve。给上限后这条路必然落定，
   * 且它是 per-task 的，不会因为某个成员限流就连坐拖死整批健康成员。
   *
   * undefined = **无上限**（保持该字段引入前的行为，向后兼容）。给定则必须是 >= 1 的整数。
   *
   * 为什么默认表 {@link DEFAULT_SWARM_SCHEDULER_CONFIG} 里**没有**它：
   * 填默认值等于静默改变现网行为（现网限流分支恒不触发，见
   * .agents/notes/implemented/process/2026-10-01-rate-limit-capability-status.md），
   * 保持 undefined 才能让"宿主尚未接线"与"显式选择无限"这两种状态可区分。
   */
  maxRateLimitRetries?: number;
}

export const DEFAULT_SWARM_SCHEDULER_CONFIG: SwarmSchedulerConfig = {
  initialLaunchLimit: 5,
  initialLaunchIntervalMs: 700,
  retryBaseMs: 3000,
  retryFactor: 2,
  capacityShrinkDebounceMs: 2000,
  capacityRecoveryIntervalMs: 180_000,
};

/**
 * 宿主插件（src/index.ts 的 `Config.taskTimeoutMs`）单任务超时的默认值：2 小时。
 *
 * 为什么是独立常量、不进 {@link DEFAULT_SWARM_SCHEDULER_CONFIG}：
 * 调度器对超时的默认语义是 **undefined（或 <=0）= 不超时**（见 {@link SwarmSchedulerConfig.timeoutMs}）。
 * 把 2h 塞进上面那张默认表，等于把调度器自身的默认从"不超时"改成"2h"——那是行为变更，
 * 不是文案/常量归位。因此这里只给宿主侧默认值一个具名常量，由宿主显式透传给调度器。
 */
export const DEFAULT_TASK_TIMEOUT_MS = 7_200_000;

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
   * 语义用途：结果里的 `state`（started/not_started）判定，以及批次中断时对未 ready 成员的
   * 放弃路径。（2026-10-01 前还参与限流重罚/轻罚分档；重罚档位已因宿主无法观测
   * 「首个请求未发出」而删除，见 .agents/notes 限流能力状态笔记。）
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