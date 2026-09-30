# M4a 自研 client 面板（swarm 成员状态弹层）与 Remote stream 数据桥

## Problem

Kimi Code 官方智能体团队面板对 one-shot 子代理不可见（DSH 会话投影自动过滤带 subagent descriptor 的子代理会话）；用户在执行 `agent_swarm` 批量任务时，无法实时感知各个 swarm 成员的并发调度状态、限流退避倒计时及错误信息。

## Decision

以同包双半（参照 `@deepseek-ai/dsh-api-job-controller`）形态实现 M4a client 面板：

1. **挂点决策**：挂载在 `conversation.session.header.actions`（会话标题栏右侧动作槽位），常驻 Swarm 状态图标与活跃徽标，点击展开面板弹层（对标 jobs 面板机制）。
2. **数据桥架构**：
   - Host 侧：新增 `src/swarm-registry.ts`（纯逻辑状态机，维护 7 态生命周期：`pending` / `starting` / `running` / `retrying` / `completed` / `failed` / `aborted`，采用官方 `OutputWaiter` 唤醒模式，100ms 合帧全量 roster 广播三类帧：`opened` / `roster` / `closed`）+ `src/remote.ts`（继承 `TypertRemoteService`，以 `@Remote({ mode: "stream" })` 暴露 `swarm/roster`）。
   - Client 侧：新增 `src/remote-descriptor.ts`，通过 `ctx.remote.$mount(TYPERT_REMOTE)`（已核对官方 experimental voice-input 同款机制）动态挂载专属 `swarm` 命名空间，通过 `remote.$stream` 引用计数订阅会话流。
   - 界面：`src/client/SwarmHeaderAction.tsx`，使用 DSH `--dsw-*` 设计变量，支持成员列表、Phase 徽标、活跃/完成统计、重试倒计时、错误摘要折叠，全中文文案。
3. **预构建链**：
   - 编写 `scripts/build-client.mjs`（基于 `esbuild`），将 TSX 打包为符合 DSH 运行时组合机制的 `window.__ModuleLoader__.load({ id: "dsh-agent-swarm", factory: ... })` 形式，输出至 `dist/client.js`。
4. **包形态声明与发布**：
   - `package.json` 升级至 `0.3.0`，增加 `exports["./client"]` 与 `dsh.client` 声明；
   - 构建 `dsh-agent-swarm-0.3.0.tgz`，同步升级 web / desktop / headless 三个 profile。

## Alternatives considered

- **广播事件 `ctx.remote.$on`**：经 spike 调研，DSH 事件名为宿主级硬编码白名单（`dsh-api-remotes` 仅允许 27 条内置事件），第三方插件无法新增广播事件——否决。
- **会话投影（Session store）**：官方 agent-team 面板直接读取 Lead Session 投影，但底层逻辑强制过滤了 one-shot 子代理，无法复用——否决。
- **侧边栏独立面板 `sidebar.panellist`**：虽有图标注册入口，但主栏页面路由依赖未开放的 plugins 族内部槽位机制，通用注册未公开——按 spike 推荐，选择轻量已验证的 header actions 弹层。
- **分包（宿主包 + UI 包）**：分包需维护两个 npm 包与外部跨包引用，且本包宿主半已具备完整工具实现，同包双半更紧凑高效——否决。

## Consequences

- **收益**：补齐批量任务的可视化短板，用户在会话标题栏即可直观监控并发进展；完全 clean-room，无侵入式或不可逆副作用。
- **代价**：引入 client 打包脚本（esbuild），构建产物大小增加约 23KB。由于 DSH Web/Electron 客户端的模块加载机制在运行期间通过 combo 下发，真实渲染表现需在用户重启 DSH 后目测验收。

## Confirmation

- `pnpm test`：7 个测试文件、135 个测试全部通过（包含状态机、合帧等待器、Remote 描述符、客户端模型/服务引用计数、打包 IIFE 工厂合法性测试）。
- `pnpm typecheck`：0 错误。
- `pnpm run build`：顺利生成 `dist/index.js` 与 `dist/client.js`。
- `pnpm pack`：生成 `dsh-agent-swarm-0.3.0.tgz`（56,493 字节）。
- 三 profile（web, desktop, headless）均完成备份（`.bak-m4a`）并成功安装升级，`dsh --profile web --dump-config` 正常解析 exit 0。

## 0.3.1 终审回归修复（2026-10-01）

- **F1（strict codec create 工厂缺失）**：
  - 现象：`dsh-typert-registry` 的 `validateCodec` 对 `mode: "strict"` 强制校验 `create` 函数，返回类型需具备 `parse` 方法；先前缺省导致客户端 `$mount` 报错。
  - 修复：在 `src/remote-descriptor.ts:28-36` 为 `parameters[0].codec` 与 `result` 补齐 `create: () => passSchema`，其中 `passSchema = { parse: (val) => val }`。
  - 验证：在 `tests/remote.test.ts` 增加用真实 `TypertRegistry` 执行 `register` 与 `dispose` 的回归测试。
- **F2（apply 重入时 registry 与 SwarmRemote 脱钩）**：
  - 现象：`src/index.ts:351` 在重复调用 `apply` 时总是创建新的 `SwarmRegistry`，但 `ctx.get("swarmRemote")` 已存在不再重建，导致既有 Stream 订阅停留在旧 registry，无法接收新 batch 的帧。
  - 修复：`SwarmRemote` 新增 `getRegistry()` / `setRegistry()`；`apply` 重入时通过 `ctx.get("swarmRemote").getRegistry()` 复用既有 registry，保证流不断开且实时同步。
  - 验证：在 `tests/plugin.test.ts` 增加连续两次 `apply` 后旧 stream 仍能收到第二次 apply 触发的批次 frames 的回归测试。

## 0.3.6 面板收纳与路由标签演进（2026-10-01）

- **Problem**：成员一多（实测 9 个已嫌长，上限 128）弹层列表无限向下拉长；且行内看不出本批次走的是哪条模型路由。
- **Decision**：
  1. 成员按相位分四组（进行中 / 失败 / 已完成 / 已取消），**各自独立折叠**——进行中与失败默认展开（需要关注），已完成与已取消默认收起（收纳），换批次时重置为默认；
  2. 列表长度定死（max-height + 细滚轮），并修 flex 子项 `min-height: 0`（缺它滚动会被内容撑破、滚轮失效）；
  3. 批次路由标签 `routeLabel` 由 host 在 execute 期解析（生效覆盖路由；继承时读父 agent requestHeader/options，与 resolveChildAgentOptions 同口径），经 registry 三类帧透传，面板头部以 `模型: provider/model` 芯片展示；读不到则留空不猜。
- **Confirmation**：`tests/swarm-registry.test.ts` 新增 routeLabel 帧透传用例（给/不给两条路径）；分组与滚轮为呈现层行为，目测验收待用户重启 DSH。
