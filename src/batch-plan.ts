/**
 * dsh-agent-swarm — 批次规划（宿主集成层）
 *
 * 职责：把一次 agent_swarm 调用的入参 + 插件配置 + 宿主上下文，规划成一份**完整的批次计划**
 * （成员规格、父 agent、会话、provider、路由覆盖、面板标签）。
 *
 * 不变量：**所有拒绝都发生在这里，且发生在任何子代理启动、任何批次登记之前。**
 * 规划成功之后的执行阶段（batch-run.ts）只会以"成员失败"的形式报告问题，不再整体拒绝。
 * 失败一律以结构化错误抛出（swarm-error.ts），抛异常即工具失败（spike Q7.4）。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { SubagentStartRequest } from "@deepseek-ai/dsh-subagent";
import { SWARM_ERROR_CODES, type SwarmModelRoute, type SwarmTaskSpec } from "./types.js";
import { resolveSwarmModelRoute, validateSwarmInput } from "./validate.js";
import { toThrownSwarmError } from "./swarm-error.js";
import { effectiveMaxItems } from "./tool-spec.js";
import type { SwarmAgentOptions, SwarmPluginConfig } from "./config.js";

/**
 * 父 Agent 的最小结构类型。
 * 直接取自 SubagentStartRequest["parent"]，避免为一个类型注解引入整个 dsh-agent 依赖。
 */
export type SwarmParentAgent = SubagentStartRequest["parent"];

/** agent_swarm 的入参（与 tool-spec.ts 的 buildToolParameters 属性一一对应）。 */
export interface SwarmExecuteArgs {
  description: string;
  prompt_template: string;
  items: string[];
  model?: string;
}

/** 一批任务的完整计划：执行阶段只读它，不再回头读入参或配置做判定。 */
export interface SwarmBatchPlan {
  specs: SwarmTaskSpec[];
  parent: SwarmParentAgent;
  /** 会话标识（面板按会话隔离）。 */
  sessionId: string;
  description: string;
  /** 本批次使用的子代理 provider 名。 */
  provider: string;
  /** 本批次的生效路由覆盖：per-call model > config 固定路由 > 缺省继承（undefined）。 */
  agentOptions: SwarmAgentOptions | undefined;
  /** 面板展示的批次路由标签；读不到时为 undefined（面板留空不猜）。 */
  routeLabel: string | undefined;
  /** 透传给 start() 的委派深度上限；undefined = 不传（provider 自管深度，或宿主无此能力）。 */
  maxDepth: number | undefined;
}

/**
 * 规划一批任务。检查顺序即报错优先级：
 *   ① 六道硬校验 + 展开 + 宿主策略上限；② per-call 模型路由（白名单）；
 *   ③ 父 Agent 与会话；④ 委派深度上限（父 agent 的成员是否会超出宿主深度限制）。
 */
export function planSwarmBatch(
  args: SwarmExecuteArgs,
  config: SwarmPluginConfig,
  ctx: Context,
  exec: ToolRunContext,
): SwarmBatchPlan {
  const specs = resolveSwarmSpecs(args, config);
  const agentOptions = resolveBatchAgentOptions(args, config, ctx);
  const { parent, sessionId } = resolveSwarmContext(exec);
  const provider = config.provider;
  const maxDepth = resolveMemberMaxDepth(ctx, config, provider);
  assertDelegationDepth(parent, maxDepth);
  return {
    specs,
    parent,
    sessionId,
    description: args.description,
    provider,
    agentOptions,
    routeLabel: describeBatchRoute(agentOptions, parent),
    maxDepth,
  };
}

// ───────────────────────── ① 校验 + 展开 + 宿主策略上限 ─────────────────────────

/**
 * 六道硬校验与宿主策略上限一律在**启动任何子代理之前**完成；两者失败都抛结构化错误
 * （code + 人可读 message + 机器可读 details）。
 */
function resolveSwarmSpecs(args: SwarmExecuteArgs, config: SwarmPluginConfig): SwarmTaskSpec[] {
  const validation = validateSwarmInput({
    description: args.description,
    promptTemplate: args.prompt_template,
    items: args.items,
  });
  if (!validation.ok) {
    throw toThrownSwarmError(validation.error);
  }
  const specs = validation.specs;

  // 宿主策略上限：128 硬校验不可绕过，config.maxItems 只能把它调低。
  // 取值走 effectiveMaxItems：与工具描述同一口径，正是为了防"校验说 10、文案说 128"的分叉。
  const effectiveMax = effectiveMaxItems(config.maxItems);
  if (specs.length > effectiveMax) {
    throw toThrownSwarmError({
      code: SWARM_ERROR_CODES.TOO_MANY_SUBAGENTS,
      message: `This deployment accepts at most ${String(effectiveMax)} swarm members, got ${String(specs.length)}.`,
      details: { total: specs.length, max: effectiveMax },
    });
  }
  return specs;
}

// ───────────────────────── ② per-call 模型路由（白名单权威）─────────────────────────

/**
 * 宿主子代理模型选择服务的结构形状。
 * 真身是 @deepseek-ai/dsh-tool-subagent/model-selection-settings 注册的
 * `ctx.subagentModelSelection` 服务（设置页「子智能体 → Model selection」的数据源）。
 * 这里只声明消费面，不为一个类型注解新增依赖。
 */
interface SubagentModelSelectionReader {
  current(): { enabled: boolean; allowedModels: SwarmModelRoute[] };
}

/**
 * 读取宿主白名单服务；未挂载（或形状不符）返回 undefined。
 *
 * 用 ctx.get 而不是 inject 声明：这是**可选**能力——服务缺失时插件其余功能必须照常工作
 * （只有模型显式传了 model 的那次调用才报 MODEL_SELECTION_UNAVAILABLE），
 * inject 是硬依赖，会把"可选"变成"没它就起不来"。
 */
function readSubagentModelSelection(ctx: Context): SubagentModelSelectionReader | undefined {
  const candidate = ctx.get("subagentModelSelection") as unknown;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { current?: unknown }).current === "function"
  ) {
    return candidate as SubagentModelSelectionReader;
  }
  return undefined;
}

/**
 * 解析本批次的生效路由覆盖。优先级：per-call `model` > config.agentOptions 固定路由 >
 * 缺省（继承父 agent，由 start() 不传 agentOptions 实现）。
 *
 * per-call 路径的权威源是宿主白名单（一事一处：插件不自备第二份允许清单）；
 * 服务未挂载、未开启、或路由不在名单内，一律在任何子代理启动之前抛结构化错误。
 * 服务 current() 自身抛错（白名单配置非法：重复路由等）同样归并到
 * MODEL_SELECTION_UNAVAILABLE——那是"选择机制不可用"，不是"这条路由不被允许"。
 */
function resolveBatchAgentOptions(
  args: SwarmExecuteArgs,
  config: SwarmPluginConfig,
  ctx: Context,
): SwarmAgentOptions | undefined {
  if (args.model === undefined) return config.agentOptions;
  // 空白串视同未提供（与 validate.ts 的 normalizeOptionalString 同一口径）；
  // 非字符串等畸形值不放行、不静默忽略，交给匹配器报 MODEL_NOT_ALLOWED。
  if (typeof args.model === "string" && args.model.trim() === "") return config.agentOptions;

  const service = readSubagentModelSelection(ctx);
  if (service === undefined) {
    throw toThrownSwarmError({
      code: SWARM_ERROR_CODES.MODEL_SELECTION_UNAVAILABLE,
      message:
        "Per-batch model routing requires the host's subagent model selection, which is not available in this composition. Enable it in Settings → 子智能体 → Model selection, or omit the model parameter.",
    });
  }
  let selection: { enabled: boolean; allowedModels: SwarmModelRoute[] };
  try {
    selection = service.current();
  } catch (error) {
    throw toThrownSwarmError({
      code: SWARM_ERROR_CODES.MODEL_SELECTION_UNAVAILABLE,
      message: `The host's subagent model selection could not be read: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (!selection.enabled) {
    throw toThrownSwarmError({
      code: SWARM_ERROR_CODES.MODEL_SELECTION_UNAVAILABLE,
      message:
        "Per-batch model routing is disabled: the host's subagent model selection is off. Enable it in Settings → 子智能体 → Model selection (and maintain the allowlist there), or omit the model parameter.",
    });
  }
  const resolution = resolveSwarmModelRoute(args.model, selection.allowedModels);
  if (!resolution.ok) {
    throw toThrownSwarmError(resolution.error);
  }
  return { provider: resolution.route.provider, model: resolution.route.model };
}

/**
 * 批次路由的展示标签（面板用）。
 * 有覆盖就显示覆盖值；继承时尽力读父 agent 当前请求路由
 * （requestHeader 优先于创建期 options，与 DSH resolveChildAgentOptions 的继承口径一致）；
 * 都读不到返回 undefined，面板对应位置留空而不是猜。
 */
function describeBatchRoute(
  agentOptions: SwarmAgentOptions | undefined,
  parent: SwarmParentAgent,
): string | undefined {
  if (agentOptions?.provider !== undefined && agentOptions.model !== undefined) {
    return `${agentOptions.provider}/${agentOptions.model}`;
  }
  const header = (
    parent as { session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined } }
  ).session?.requestHeader?.()?.config;
  const options = (parent as { options?: { provider?: string; model?: string } }).options;
  const provider = header?.provider ?? options?.provider;
  const model = header?.model ?? options?.model;
  return provider !== undefined && model !== undefined ? `${provider}/${model}` : undefined;
}

// ───────────────────────── ④ 委派深度上限 ─────────────────────────

/** 本文件真正用到的子代理服务消费面（全部可选：旧宿主可能没有它们）。 */
interface SubagentDepthFace {
  resolveMaxDepth?(configured?: number | "provider-managed"): number | undefined;
  getProvider?(name: string): { capabilities?: { depthLimit?: boolean } } | undefined;
}

/**
 * 成员的委派深度上限（透传给 start 的 `maxDepth`）。
 *
 * 为什么必须由本插件透传：DSH 的 `start()` **只在请求带了 maxDepth 时**才校验深度；
 * 服务配置里的默认值（1）要靠工具自己经 `resolveMaxDepth()` 取出再传（官方 dsh-tool-subagent
 * 就是这么做的）。此前本插件不传，于是成员的委派深度**没有任何上限**——
 * 工具描述里"depth is capped at 1"只是一句没有代码支撑的文案。
 *
 * 不传（undefined）的三种情形：
 *   - 配置为 "provider-managed"；
 *   - 所选 provider 未声明 depthLimit 能力（进程外 provider）：对它传 maxDepth 会被 start 直接拒绝，
 *     而它的深度本就由 provider 自管——与官方工具的 'provider-managed' 语义一致，避免这类部署回归；
 *   - 宿主没有 resolveMaxDepth 且配置未给数值（旧宿主，保持旧行为）。
 */
function resolveMemberMaxDepth(
  ctx: Context,
  config: SwarmPluginConfig,
  providerName: string,
): number | undefined {
  if (config.maxDepth === "provider-managed") return undefined;
  const subagents = ctx.subagents as unknown as SubagentDepthFace;
  const provider = typeof subagents.getProvider === "function" ? subagents.getProvider(providerName) : undefined;
  if (provider !== undefined && provider.capabilities?.depthLimit !== true) return undefined;
  if (typeof subagents.resolveMaxDepth === "function") return subagents.resolveMaxDepth(config.maxDepth);
  return config.maxDepth;
}

/**
 * 读取父 agent 的委派深度（顶层 agent 为 0）。
 *
 * 口径与 DSH `delegationDepthOf` 一致（取持久化会话头与运行期选项的较大者），但刻意**宽松**：
 * 读不到或形状不符一律按 0 处理。这里只是"开批次之前提前整体拒绝"的快速路径——
 * 真正的权威检查仍在 DSH 的 start()（因为我们透传了 maxDepth），所以宽松读取最坏只是
 * 退化成"每个成员各自在 start 处被拒"，不会放过越界的委派。
 * 不 import DSH 的 delegationDepthOf，是为了不给运行时新增一条宿主包依赖。
 */
function delegationDepthOfParent(parent: SwarmParentAgent): number {
  const probe = parent as {
    session?: { header?: { delegationDepth?: unknown } };
    options?: { subagentDepth?: unknown };
  };
  const depthOf = (value: unknown): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return Math.max(depthOf(probe.session?.header?.delegationDepth), depthOf(probe.options?.subagentDepth));
}

/** 成员深度 = 父深度 + 1；超出上限即整体拒绝（零派发、不登记批次）。 */
function assertDelegationDepth(parent: SwarmParentAgent, maxDepth: number | undefined): void {
  if (maxDepth === undefined) return;
  const parentDepth = delegationDepthOfParent(parent);
  const memberDepth = parentDepth + 1;
  if (memberDepth <= maxDepth) return;
  throw toThrownSwarmError({
    code: SWARM_ERROR_CODES.DELEGATION_DEPTH_EXCEEDED,
    message: `agent_swarm was called at delegation depth ${String(parentDepth)}, so its members would run at depth ${String(memberDepth)}, beyond this host's subagent depth limit of ${String(maxDepth)}. Do the work directly in this turn instead of starting another swarm.`,
    details: { parentDepth, memberDepth, maxDepth },
  });
}

// ───────────────────────── ③ 父 Agent 与会话 ─────────────────────────

/** 父 Agent（必填项，缺失即抛——官方包同样写法）与会话标识（用于会话面板隔离）。 */
function resolveSwarmContext(exec: ToolRunContext): { parent: SwarmParentAgent; sessionId: string } {
  const parent = exec.agent;
  if (parent === undefined) {
    throw new Error("agent_swarm requires a calling agent (exec.agent was undefined)");
  }

  const sessionId =
    (parent as { session?: { id?: string } })?.session?.id ??
    (parent as { sessionId?: string })?.sessionId ??
    (exec as { session?: { id?: string } })?.session?.id ??
    "session-default";

  return { parent, sessionId };
}
