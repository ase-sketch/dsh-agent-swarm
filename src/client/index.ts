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
import type { RemoteClientFace } from "./service.js";
import { ensureCssInjected, SwarmHeaderAction } from "./SwarmHeaderAction.js";

export const inject = ["remote", "slots", "locale"] as const;

/**
 * 插件的客户端上下文（最小结构类型）。
 *
 * 只描述本插件真正用到的成员：remote / slots / locale 三个服务键，加上登记可逆副作用的
 * effect。除它们之外的成员一律取不到，防止以后悄悄依赖未在 `inject` 里声明的服务。
 */
export interface ClientContext {
  /** Remote 客户端面：既提供 `$mount`，也是流服务的 carrier 来源。 */
  remote: RemoteClientFace & {
    $mount(descriptor: unknown): Promise<() => unknown>;
  };
  /** 槽位注入与注册。 */
  slots: {
    inject(slotKey: string, factory: () => unknown): (() => void) | undefined;
    register(options: SwarmSlotOptions, component: unknown): () => void;
  };
  /** 本地化字典注册。 */
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown;
  };
  /** Cordis 可逆副作用登记。 */
  effect(callback: () => unknown, label?: string): void;
}

/** 槽位注册选项（只列本插件用到的字段）。 */
export interface SwarmSlotOptions {
  name: string;
  id: string;
  order: number;
  locale: string;
  inject: () => SwarmHeaderInjectedProps;
}

/** 注入给槽位组件的属性。 */
export interface SwarmHeaderInjectedProps {
  useSwarm: ClientSwarmModel["useSwarm"];
  watchSwarm: (sessionId: string) => () => void;
}

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  // ① 动态挂载专属 Remote 命名空间 (swarm)
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);

  // ② 一次性注入面板样式
  // 此前它在渲染函数体里调用，每次 re-render 都要查一遍 DOM；apply 期只做一次。
  ensureCssInjected();

  // ③ 初始化纯数据模型与服务
  const model = new ClientSwarmModel();
  const service = new ClientSwarmService(ctx.remote, model);

  // ④ 注册双语字典
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

  // ⑤ 注入属性只构造一次：引用稳定，避免组件 useEffect 因依赖换引用而反复订阅/退订
  const injectedProps: SwarmHeaderInjectedProps = {
    useSwarm: model.useSwarm,
    watchSwarm: service.watchSwarm,
  };

  // ⑥ 注入会话标题栏右侧动作槽位
  const disposeSlot = ctx.slots.inject("conversation.session.header.actions", () =>
    ctx.slots.register(
      {
        name: "conversation.session.header.actions",
        id: "agent-swarm",
        order: 30,
        locale: "agentSwarm",
        inject: () => injectedProps,
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
