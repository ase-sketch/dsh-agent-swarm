# Client 侧命名空间访问：提供与消费必须分属两个 fiber

- **日期**：2026-10-01
- **类别**：bug-fix
- **状态**：implemented
- **相关文件**：`src/client/index.ts`、`tests/client.test.ts`

## Problem

0.3.4 装到 web/desktop 后，用户重启 DSH 实测：标题栏面板显示

`流连接中断：cannot get property "remote.swarm" without inject`

面板从未收到过任何 roster 帧——此前流异常被静默吞掉（本轮 P2 才让错误可见），
所以这个缺陷一直存在、只是不可见。它意味着"会话级并发调度监控"这一档功能实际不可用。

## Decision

客户端入口拆成两个 fiber：

1. **父 fiber**（插件被加载的那个）只做一件事——`ctx.remote.$mount(TYPERT_REMOTE)`，即**提供** `remote.swarm` 命名空间。它的 `inject` 保持 `["remote","slots","locale"]`。
2. **子 fiber**（`ctx.plugin({ name, inject, apply })` 内联插件）**消费**命名空间：`inject: ["remote","slots","locale","remote.swarm"]`，在其中构造服务、注册槽位与字典。

依据（读 DSH 客户端 bundle 得到的机制，可复验）：

- `installNamespace` 的实现是 `this.ownerCtx.plugin({ name: remoteServiceKey(name), apply: (ctx) => new RemoteNamespaceService(ctx, name, ...) })`，
  且 `remoteServiceKey(namespace) === "remote." + namespace`。也就是说命名空间服务名叫
  `remote.<namespace>`，由**挂载方的子 fiber**提供。
- 该实现的注释写明设计意图："so a plugin **parked on** the namespace service never observes it
  without the methods the same contribution carries" —— 消费方就是"park 在这个服务上"。
- 官方消费方的声明形式（bundle 内实测）：`@deepseek-ai/dsh-api-job-controller/client` 的
  `export const inject = ["remote", "remote.job"]`；session 侧插件是
  `inject = ["connection","fileUpload","typert","remote","remote.commands","remote.session","remote.subagents"]`。
- cordis 的服务解析（`@deepseek-ai/cordis` `src/reflect.ts` 的 `ReflectService.handler.get`）
  在 fiber 链上找 `fiber.store[prop]`，并用 `isolate` 键做隔离；未 inject 的访问直接抛
  `cannot get property "..." without inject`。

为什么不能"在同一个 fiber 里声明"：静态 `inject` 在 `apply` 之前解析，而该服务要等这个
fiber 的 `apply` 跑完才存在——声明了就永远等不到（死锁）；不声明则运行期被隔离挡掉。官方架构里
提供方是别的插件（api-remotes 统一挂载各业务包的生成产物），所以消费方可以安全地静态声明；
本插件自提供自消费，必须靠"父提供 / 子消费"来同时满足两侧。

## Alternatives considered

1. **在父 fiber 的 inject 里加 `"remote.swarm"`**：死锁（服务要等自己的 apply），排除。
2. **不声明、直接访问，靠 `try/catch` 兜底**：隔离检查发生在 cordis 层，访问必抛；
   兜底只能把错误显示出来（这就是 0.3.4 的现状），功能仍不可用，排除。
3. **放弃命名空间，改用工具结果 XML 做数据源**：XML 只在工具调用结束时有，面板需要的是
   实时快照与失败可见性；且宿主对第三方插件只转发白名单事件（27 条，不含本插件），
   自定义命名空间是唯一可用通道，排除。
4. **把服务做成全局单例、绕开 ctx 访问**：等于绕过 cordis 的作用域与生命周期管理，
   与宿主的服务模型对抗，收益（省一个 fiber）远小于风险，排除。

## Consequences

- 收益：面板恢复可用；且因为 inject 有"park 等待"语义，子 fiber 会在命名空间就绪后才激活，
  时序上不需要额外同步。
- 影响：插件外壳的 `inject` 语义不变（仍是 `["remote","slots","locale"]`），
  加载契约没变；槽位与字典的注册/卸载现在归属子 fiber，随 fiber 卸载自动清理。
- 权衡：多一层 fiber 嵌套；子 fiber 未激活时槽位不会注册（宿主表现为"面板不存在"而不是报错），
  这正是 `inject` 的既定语义。
- 未覆盖：真实浏览器/Electron 下的渲染与流连通仍需用户重启后目测（本轮只有单元级证据）。

## Confirmation

- `tests/client.test.ts` 新增用例「命名空间服务只对声明它的 fiber 可见」：
  ① 断言子插件 `inject` 含 `remote.swarm`；② 断言父 `inject` **不含**它（防死锁回退）；
  ③ 断言 `$mount` 的调用顺序早于 `ctx.plugin`。
  该用例在修复前必然失败（0.3.4 的入口根本没有子 fiber）。
- 其余 217 条用例与 `pnpm typecheck` 作为回归护栏。
- 用户重启 web/desktop 后目测面板能否正常显示会话任务与错误条——这是本决策唯一能覆盖
  "真实宿主装配"的验收手段。
