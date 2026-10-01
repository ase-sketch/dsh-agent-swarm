/**
 * dsh-agent-swarm — Client 端插件入口
 *
 * 职责分两段，且**必须在两个 fiber 中完成**：
 *   ① 父 fiber（本插件被加载的那个）：`ctx.remote.$mount(TYPERT_REMOTE)` —— 提供 `remote.swarm` 命名空间；
 *   ② 子 fiber（`ctx.plugin` 内联插件）：注入标题栏槽位与字典 —— **消费** `remote.swarm`。
 *
 * 为什么要拆成两个 fiber（2026-10-01 修复；对应 0.3.4 面板报的
 * `cannot get property "remote.swarm" without inject`）：
 *
 *   cordis 对服务做**隔离**：`ctx.remote.<namespace>` 这类命名空间服务只对
 *   "**提供它的 fiber**"以及"**显式把它写进 inject 的后代 fiber**"可见。官方消费方正是这样声明的——
 *   `@deepseek-ai/dsh-api-job-controller/client` 的 `inject = ["remote", "remote.job"]`；
 *   session 侧插件的是 `inject = ["connection", "fileUpload", "typert", "remote", "remote.commands",
 *   "remote.session", "remote.subagents"]`。两个点号命名空间都逐字出现在 inject 里。
 *
 *   而本插件**既是提供者又是消费者**：若在同一个 fiber 的静态 inject 里写 `"remote.swarm"`，
 *   那个服务要等这个 fiber 的 apply 跑完才存在 —— 永远等不到（死锁）；不写，运行期访问就被隔离挡掉，
 *   抛 `without inject`。拆开之后，子 fiber 激活时命名空间已经就位：inject 立刻解析、隔离检查放行。
 *
 * 副作用可逆性：两个 fiber 各管自己的清理——子 fiber 卸载时注销槽位与字典，父 fiber 卸载时撤销 mount。
 */

import { TYPERT_REMOTE } from "../remote-descriptor.js";
import { ClientSwarmModel } from "./model.js";
import { ClientSwarmService } from "./service.js";
import type { RemoteClientFace } from "./service.js";
import { ensureCssInjected, SwarmHeaderAction } from "./SwarmHeaderAction.js";
import { SWARM_DICTIONARIES, SWARM_LOCALE_NAMESPACE } from "./locales.js";

/**
 * 父 fiber 的服务依赖。
 *
 * `slots` / `locale` 保留在这里（本插件确实要用它们，且它们是客户端核心服务），
 * 真正的槽位注册发生在子 fiber。`remote.swarm` **不能**写在这里——它是本 fiber 自己挂载出来的。
 */
export const inject = ["remote", "slots", "locale"] as const;

/** cordis 里命名空间就是点号服务名，inject 必须逐字声明这个键。 */
const SWARM_NAMESPACE_SERVICE = "remote.swarm";

/**
 * 插件父上下文（最小结构类型）：只描述本插件真正用到的成员。
 * 除它们之外的成员一律取不到，防止以后悄悄依赖未在 `inject` 里声明的服务。
 */
export interface ClientContext {
  /** Remote 客户端面：既提供 `$mount`，也是流服务的 carrier 来源。 */
  remote: RemoteClientFace & {
    $mount(descriptor: unknown): Promise<() => unknown>;
  };
  /** Cordis 可逆副作用登记。 */
  effect(callback: () => unknown, label?: string): void;
  /** 加载内联子插件（返回值即该 fiber 的句柄，可 dispose）。 */
  plugin(plugin: ClientPanelPlugin): { dispose(): void };
}

/** 面板子插件（提供者-消费者拆分后的消费侧）。 */
export interface ClientPanelPlugin {
  name: string;
  inject: readonly string[];
  apply(ctx: ClientPanelContext): (() => void) | void;
}

/** 面板子上下文：这里 `remote` 已注入命名空间，`remote.swarm` 才可访问。 */
export interface ClientPanelContext {
  remote: RemoteClientFace;
  slots: {
    inject(slotKey: string, factory: () => unknown): (() => void) | undefined;
    register(options: SwarmSlotOptions, component: unknown): () => void;
  };
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown;
  };
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
  // ① 父 fiber：动态挂载专属 Remote 命名空间（swarm）。本 fiber 是它的提供者，
  //    因此这里不（也不能）在 inject 里声明它。
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);

  // ② 一次性注入面板样式（此前它在渲染函数体里调用，每次 re-render 都要查一遍 DOM）。
  ensureCssInjected();

  // ③ 纯数据模型：宿主与面板共享，放在父层以便子 fiber 卸载重建时不丢状态。
  const model = new ClientSwarmModel();

  // ④ 子 fiber：声明 `remote.swarm` 之后才有权访问命名空间（详见文件头）。
  //    槽位注册与字典都在这里，随子 fiber 一起可逆卸载。
  const panel = ctx.plugin({
    name: "agent-swarm-panel",
    inject: ["remote", "slots", "locale", SWARM_NAMESPACE_SERVICE],
    apply: (panelCtx: ClientPanelContext) => {
      const service = new ClientSwarmService(panelCtx.remote, model);

      panelCtx.effect(
        () => panelCtx.locale.register(SWARM_LOCALE_NAMESPACE, SWARM_DICTIONARIES),
        "agent-swarm: dictionaries",
      );

      // 注入属性只构造一次：引用稳定，避免组件 useEffect 因依赖换引用而反复订阅/退订。
      const injectedProps: SwarmHeaderInjectedProps = {
        useSwarm: model.useSwarm,
        watchSwarm: service.watchSwarm,
      };

      const disposeSlot = panelCtx.slots.inject("conversation.session.header.actions", () =>
        panelCtx.slots.register(
          {
            name: "conversation.session.header.actions",
            id: "agent-swarm",
            order: 30,
            // 声明命名空间后，框架把绑定到它的 `t` 注入给 SwarmHeaderAction（与官方 jobs 面板同一机制）。
            locale: SWARM_LOCALE_NAMESPACE,
            inject: () => injectedProps,
          },
          SwarmHeaderAction,
        ),
      );

      return () => {
        try {
          disposeSlot?.();
        } catch {
          // ignore
        }
      };
    },
  });

  return async () => {
    try {
      panel.dispose();
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
