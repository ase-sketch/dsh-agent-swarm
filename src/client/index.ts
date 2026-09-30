/**
 * dsh-agent-swarm — Client 端插件入口
 *
 * 职责：
 * 1. 挂载 TYPERT_REMOTE 客户端描述符到 ctx.remote
 * 2. 注入 conversation.session.header.actions 槽位组件
 * 3. 注册本地化字典
 */

import { TYPERT_REMOTE } from "../remote-descriptor.js";
import { ClientSwarmModel } from "./model.js";
import { ClientSwarmService } from "./service.js";
import { SwarmHeaderAction } from "./SwarmHeaderAction.js";

export const inject = ["remote", "slots", "locale"] as const;

export async function apply(ctx: any): Promise<() => Promise<void>> {
  // ① 动态挂载专属 Remote 命名空间 (swarm)
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);

  // ② 初始化纯数据模型与服务
  const model = new ClientSwarmModel();
  const service = new ClientSwarmService(ctx.remote, model);

  // ③ 注册双语字典
  ctx.effect(
    () =>
      ctx.locale.register("agentSwarm", {
        zh: {
          title: "Swarm 智能体队列",
          empty: "当前会话暂无 Swarm 任务",
        },
        en: {
          title: "Swarm Agent Queue",
          empty: "No Swarm tasks in current session",
        },
      }),
    "agent-swarm: dictionaries",
  );

  // ④ 注入会话标题栏右侧动作槽位
  const disposeSlot = ctx.slots.inject("conversation.session.header.actions", () =>
    ctx.slots.register(
      {
        name: "conversation.session.header.actions",
        id: "agent-swarm",
        order: 30,
        locale: "agentSwarm",
        inject: () => ({
          useSwarm: model.useSwarm,
          watchSwarm: (sessionId: string) => service.watchSwarm(sessionId),
        }),
      },
      SwarmHeaderAction,
    ),
  );

  return async () => {
    try {
      disposeSlot?.();
    } catch {
      // ignore
    }
    try {
      await disposeRemote?.();
    } catch {
      // ignore
    }
  };
}
