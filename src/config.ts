/**
 * dsh-agent-swarm — 插件配置（宿主集成层：依赖 @deepseek-ai/schemastery）
 *
 * 职责：Config schema（Cordis 加载期据此补默认值并校验）、解析后的配置形状、
 * 以及"插件配置 → 调度器配置"的唯一映射点。
 */

import Schema from "@deepseek-ai/schemastery";
// `import type` 只取类型；SubagentStartRequest 来自 DSH 的子代理服务定义。
import type { SubagentStartRequest } from "@deepseek-ai/dsh-subagent";
import {
  DEFAULT_SWARM_SCHEDULER_CONFIG,
  DEFAULT_TASK_TIMEOUT_MS,
  SWARM_MAX_SUBAGENTS,
  type SwarmSchedulerConfig,
} from "./types.js";

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
  /**
   * 单任务超时，默认 {@link DEFAULT_TASK_TIMEOUT_MS}（2h）；<=0 = 不超时。
   * start() 无 timeout 字段，超时信号由 AbortSignal.timeout 自建。
   */
  taskTimeoutMs: Schema.natural().default(DEFAULT_TASK_TIMEOUT_MS),
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
 * 子代理路由覆盖。取自 SubagentStartRequest["agentOptions"] 的元素类型，
 * 保证 config 里存的字符串在 start() 处能被 DSH 的品牌类型接受。
 */
export type SwarmAgentOptions = NonNullable<SubagentStartRequest["agentOptions"]>;

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
  /** 宿主策略上限；生效值 = min(maxItems, SWARM_MAX_SUBAGENTS)，见 tool-spec.ts 的 effectiveMaxItems。 */
  maxItems: number;
  /** 见上方 SwarmAgentOptions：品牌化的路由覆盖，缺省则继承父 agent。 */
  agentOptions?: SwarmAgentOptions;
}

/**
 * 插件配置 → 调度器配置的**唯一**映射点（字段改名都在这里对齐，不在调用处散落）。
 *
 * timeoutMs：调度器自己的超时闸门。命中后该成员落 "Subagent timed out." 文案（failed）。
 */
export function toSchedulerConfig(config: SwarmPluginConfig): Partial<SwarmSchedulerConfig> {
  return {
    initialLaunchLimit: config.firstWave,
    initialLaunchIntervalMs: config.releaseIntervalMs,
    retryBaseMs: config.backoffInitialMs,
    retryFactor: config.retryFactor,
    capacityShrinkDebounceMs: config.shrinkDebounceMs,
    capacityRecoveryIntervalMs: config.recoverIntervalMs,
    timeoutMs: config.taskTimeoutMs,
  };
}
