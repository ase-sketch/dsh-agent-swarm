/**
 * dsh-agent-swarm — 插件入口（宿主集成层）
 *
 * 只做装配：声明插件元信息（name / inject / Config），在 apply 里注册 `agent_swarm` 工具。
 * 一次工具调用的完整链路是三段，各自一个模块：
 *
 *   batch-plan.ts   规划：六道硬校验 + 宿主策略上限 + 模型路由 + 父 agent/会话 → 批次计划
 *                   （**所有整体拒绝都发生在这里**，在任何子代理启动、任何批次登记之前）
 *   batch-run.ts    执行：开批次 → 调度器（scheduler.ts）→ 逐成员 ctx.subagents.start → 收批次
 *   result-xml.ts   渲染：renderSwarmResultSafely → <agent_swarm_result>（成员状态的唯一权威）
 *
 * 关键契约（docs/spike-dsh-api.md + 0.2.0-rc.2 实装类型双向核对）：
 *   - 命名导出 name / inject / Config / apply，**不写 export default**
 *   - inject 只需要 ["tools", "subagents"]：注册工具 + 派发子代理
 *   - 不设任何审批字段（spike Q8：无 approvalRule 机制，不调 ctx.approval 即不弹窗）
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { toSchedulerConfig, type SwarmPluginConfig } from "./config.js";
import { validateSchedulerConfig } from "./scheduler.js";
import { planSwarmBatch, type SwarmExecuteArgs } from "./batch-plan.js";
import { runSwarmBatch } from "./batch-run.js";
import { renderSwarmResultSafely } from "./result-xml.js";
import {
  SWARM_TOOL_NAME,
  TOOL_OUTPUT,
  buildToolDescription,
  buildToolParameters,
  effectiveMaxItems,
} from "./tool-spec.js";
import { SwarmRegistry } from "./swarm-registry.js";
import { SwarmRemote } from "./remote.js";

export { Config } from "./config.js";
export type { SwarmPluginConfig } from "./config.js";

export const name = "agent-swarm";

/**
 * 只申请两个服务：tools（注册工具）与 subagents（派发子代理）。
 * 刻意不声明 systemPrompt / sessionProjections，避免多拔奇这两个服务。
 */
export const inject = ["tools", "subagents"] as const;

/**
 * 取得面板数据源 registry：同一 Context 树上已有 swarmRemote 服务就复用它的 registry，
 * 否则新建 registry 并挂上 SwarmRemote（host 半的 Remote 流服务）。
 *
 * 可逆性：SwarmRemote 是 cordis Service，构造即 `ctx.reflect.provide`，
 * 所属 fiber 卸载时由 cordis 自动注销（cordis Service 构造函数的契约），无需手动清理。
 */
function acquireRegistry(ctx: Context): SwarmRegistry {
  const existingRemote = ctx.get("swarmRemote") as SwarmRemote | undefined;
  if (existingRemote) return existingRemote.getRegistry();
  const registry = new SwarmRegistry();
  new SwarmRemote(ctx, registry);
  return registry;
}

/**
 * 插件入口。有副作用的事只有两件：挂 SwarmRemote 服务（见 acquireRegistry）、注册工具。
 * 两者都可逆：前者随 fiber 卸载由 cordis 注销；后者由返回的 disposer 注销
 * （Cordis 把 apply 返回的函数登记为该 fiber 的 effect，卸载时自动调用）。
 *
 * 调度器配置在**任何副作用之前**先校验一遍（fail-fast）：Config schema 已挡住大部分非法值，
 * 这里兜住绕过 schema 直接传入的配置——否则非法配置要等到每一次工具调用才在调度器构造期抛错，
 * 而那时批次已经登记，面板会留下一个从未跑过的空批次。
 */
export function apply(ctx: Context, config: SwarmPluginConfig): () => void {
  validateSchedulerConfig(toSchedulerConfig(config));
  const registry = acquireRegistry(ctx);

  // 描述在 apply 期按**生效上限**生成，不是模块级常量：宿主把 config.maxItems 调低后，
  // 模型收到的必须与 batch-plan 拒绝它时用的是同一个数。
  const effectiveMax = effectiveMaxItems(config.maxItems);

  const agentSwarm = defineTool({
    name: SWARM_TOOL_NAME,
    description: buildToolDescription(effectiveMax),
    parameters: buildToolParameters(effectiveMax),
    output: TOOL_OUTPUT,
    // 与官方 subagent 工具一致：允许模型在同一条消息里并发调用多个 agent_swarm。
    isConcurrencySafe: () => true,
    async execute(args: SwarmExecuteArgs, exec: ToolRunContext): Promise<{ xml: string }> {
      // ① 规划：全部整体拒绝都在这里，发生在任何子代理启动之前。
      const plan = planSwarmBatch(args, config, ctx, exec);
      // ② 执行：批次信号 = exec.signal（用户中断级联）。个别成员失败不拖垮整次调用。
      const results = await runSwarmBatch(ctx, config, plan, registry, exec.signal);
      // ③ 收齐全部结果后一次性渲染；失败与成功在 XML 里如实分列（spike Q7.4 末条）。
      return { xml: renderSwarmResultSafely(results) };
    },
  });

  return ctx.tools.register(agentSwarm);
}
