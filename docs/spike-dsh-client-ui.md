# DSH client 半 + host→client 数据桥 Spike（只读调研）

> 目标：给 dsh-agent-swarm 的 **M4a（自研 client 面板）** 找到官方可抄的路径。
> 证据基底：本机 asar 内 `@deepseek-ai/*` **0.2.0-rc.2** 实装（未混淆、带 JSDoc）。
> 约定：所有证据写成 `包名/文件:行号`，行号指 asar 内 **lib/*.js 产物**（官方包发布的就是产物；TS 源码在
> `lib/*.js.map` 的 sourceMappingURL 里，本 spike 统一以产物行号为准，避免"源码行号"与"可安装行号"打架）。
> 缩写：**宿主半** = `main`/`.` 导出；**客户端半** = `exports["./client"]` + `dsh.client` 字段。

---

## 0. 一句话结论

- **双半同包是官方标准形态**，不是特例：`dsh-api-job-controller` 一个包里同时有宿主 Remote 服务（`lib/index.js`）
  和浏览器服务（`lib/client.js`），我们照抄即可。
- **数据桥有三条路，只有第一条我们能自己用**：
  1. **Remote stream（server push）**——`@Remote({mode:"stream"})` + async generator，可断线续传，**推荐**；
  2. Remote direct 调用（`Remote("kill")` 那样）——一次性请求-响应，适合"打开面板时拉一次快照"；
  3. **`ctx.remote.$on("事件名")` 广播事件——事件名是应用级白名单**（`dsh-api-remotes` 硬编码 27 条），
     插件**无法自行新增**，所以我们**不能**用广播事件推 swarm 状态。
- **面板挂点**：`sidebar.panellist`（侧栏全局面板图标 + 主栏页面）有现成最小范例
  （`dsh-client-ui-plugin-manager/lib/client.js:3769`），官方甚至内建了脚手架示例字符串
  （`dsh-cordis-client-runner/lib/client.js:5109`）。
- **client 半必须预构建**：产物缺失会直接抛 `MissingClientBundleError`（`dsh-client-modules/lib/index.js:130`），
  提示 "run `pnpm run build` before launch"。

---

## 1. client 半声明形态

### 1.1 package.json 字段

**必需三件套**（`dsh.client` + `exports["./client"]` + 入口文件）：

```jsonc
"exports": {
  ".":        { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },  // ← 客户端半入口
  "./src/*":  "./src/*",
  "./package.json": "./package.json"
},
"dsh": {
  "client": {
    "inject":   ["@deepseek-ai/dsh-client-locale", "…按需…"],  // 客户端要用的宿主服务
    "platform": "web"          // 必填，必须是字符串
  }
}
```

证据：

| 事实 | 证据 |
|---|---|
| `"./client"` 指向 `lib/client.js` | `dsh-client-ui-jobs/package.json:13-16` |
| `exports["./client"]` **必须**存在，否则报错 | `dsh-client-modules/lib/index.js:719`（"declares dsh.client but exports no ./client bundle"） |
| `dsh.client.platform` **必须是字符串**，否则报错 | `dsh-client-modules/lib/index.js:65` |
| `dsh.client.inject` / `.external` 是**可选**字符串数组 | `dsh-client-modules/lib/index.js:66-67`（`optionalStringArray`） |
| `dsh.client.immediately` 可选布尔（提前加载） | `dsh-client-modules/lib/index.js:68` |
| `"./client"` 也接受**纯字符串**或一层条件对象（有 `default` 字符串即可） | `dsh-client-modules/lib/index.js:171-180`（`clientExportOf`） |
| `exports["./client"]` 非法形态的报错文案 | `dsh-client-modules/lib/index.js:180` |
| `platform: "web"` 出现在每个 UI 包上 | `dsh-client-ui-jobs/package.json:60`、`dsh-client-ui-sidebar/package.json:39`、`dsh-experimental-client-ui-agent-team/package.json:38` |

### 1.2 宿主半入口 = 空 apply()

客户端专属包在宿主侧是个**占位空函数**，只为让包在 Loader 里有一行：

- `dsh-client-ui-jobs/lib/index.js:9`——`function apply() {}`（注释原文："Loader-visible no-op body; the browser half carries the feature"）
- `dsh-client-ui-sidebar/lib/index.js:4`——`function apply() {}`
- `dsh-experimental-client-ui-agent-team/lib/index.js:4`——`function apply() {}`

**我们不是空壳**：我们已有真正的宿主半（注册 `agent_swarm` 工具）。所以走 `dsh-api-job-controller`
那种"两侧都有肉"的形态（见 §5）。

### 1.3 客户端半入口的形状（bundler 产物）

客户端产物**不是普通 ESM**，是一个交给浏览器模块加载器的 IIFE 工厂：

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-jobs",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react_jsx_runtime = require("react/jsx-runtime");
    // …CSS 内联注入、组件定义、最后：
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

证据：
- 工厂壳：`dsh-client-ui-jobs/lib/client.js:1-6`
- 导出 `apply`/`inject`：`dsh-client-ui-jobs/lib/client.js:624-625`
- 双半同包版（同一形状，id 仍为包名）：`dsh-api-job-controller/lib/client.js:1-6, 361-362`
- CSS 是构建期内联字符串 + 运行时幂等 `<style>` 注入（`data-plugin-css` 去重）：`dsh-client-ui-jobs/lib/client.js:12-19`

**推论**：客户端半是**构建产物**，不能手写——要用 bundler 把 TSX 打成这个形状（见 §6）。

---

## 2. 面板挂点

DSH 的 client 半**没有命令式"加个页面"API**，唯一方式：**往 slot 注册一个组件**。
挂点清单共 73 个，内建在浏览器侧（`dsh-cordis-client-runner/lib/client.js`），下面摘相关的。

### 2.1 三种可选挂点（按推荐度）

| 挂点 | kind | 语义 | 我们适合度 |
|---|---|---|---|
| `sidebar.panellist` | list | **侧栏全局面板图标**，点了切换主栏页面 | ★★★ 独立页面，成员列表天然是"一页" |
| `conversation.session.header.actions` | list | 会话标题栏右侧动作（点开弹层） | ★★ 轻量入口，jobs 面板就这么做 |
| `sidebar.right.pane.tab` | keyed | 右侧栏某个 tab 的内容 | ★ 需申请新 tab 类型，成本高 |

证据：
- `sidebar.panellist` 契约：`dsh-cordis-client-runner/lib/client.js:5067-5110`（"Global panel icons. Each list id addresses the matching main panel"）
- `conversation.session.header.actions` 就地注册：`dsh-client-ui-jobs/lib/client.js:610-621`
- `sidebar.right.pane.tab` 契约：`dsh-cordis-client-runner/lib/client.js:5113-5123`
- 侧栏渲染 `sidebar.panellist` 的位置：`dsh-client-ui-sidebar/lib/client.js:190`（`renderSlot("sidebar.panellist", …)`）
- 同类可参考的会话内 View 页签槽：`conversation.view`（`dsh-cordis-client-runner/lib/client.js:3722`，占用者 chat/trajectory）

### 2.2 sidebar.panellist 的最小例子（官方现成）

**图标注册**——`dsh-client-ui-plugin-manager/lib/client.js:3769-3775`：

```js
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist",
  id: PANEL_ID,            // "plugins"（:3656）——与主栏页面 id 对应
  order: 0,
  label: () => t("panel"),  // thunk：locale 切换时自动重读
  locale: NS
}, PluginsPanelIcon));
```

**页面主体**另挂一组 slot（`ctx.slots.inject("plugins", …)` 铺开 `plugins.detail.*` 等），
同文件 `dsh-client-ui-plugin-manager/lib/client.js:3707-3754`，并用
`ctx.layout.panelInfo`（:3755）感知是否被选中、`ctx.layout.selectPanel(PANEL_ID)`（:3759）跳转。

> **风险提示**：主栏页面的**内容**挂在哪个 slot，取决于 `ctx.layout` 的主栏路由机制；
> 官方**没有一个通用的"注册任意主栏页面"单槽**——plugin-manager 是把 `plugins` 一族 slot 铺开、由布局壳消费的。
> 这一层若不可得，退路是改挂 `conversation.session.header.actions`（jobs 面板的弹层形态，机制简单、已实证）。

**官方内建的脚手架示例**（照抄起步）——`dsh-cordis-client-runner/lib/client.js:5109`：

```js
return {
  inject: ['slots'],
  apply(ctx) {
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
      { name: 'sidebar.panellist', id: 'my-entry', order: 100, label: 'My entry' },
      () => React.createElement('div', null, 'hello'),
    ))
  },
}
```

同形态另一处（挂在 `sidebar.footer.action` 上）：`dsh-cordis-client-runner/lib/client.js:5063`。

**id 语义**（官方原文，`dsh-cordis-client-runner/lib/client.js:5077`）：
> "Use an id of your own: a fresh id is added beside the shipped entries, while reusing a shipped id puts you in THAT cell and replaces it."

即：**用新 id = 在官方面板旁新增一个**（正是我们要的）；复用官方 id = 顶掉它（别做）。

**已有占用者**（避开这两个 id）：`client-ui-plugin-manager PluginsPanelIcon`、`client-ui-schedule TaskManagerIcon`
（`dsh-cordis-client-runner/lib/client.js:5107`）。

**侧栏如何感知新面板**：侧栏订阅 `sidebar.panellist` 并按 `order` 排序，label 走 `resolveSlotLabel`：
`dsh-client-ui-sidebar/lib/client.js:454-470`；点击时 `ctx.layout.selectPanel(id)`（:480）。

### 2.3 conversation.session.header.actions 完整范例（jobs 面板，最短路径）

`dsh-client-ui-jobs/lib/client.js:605-622`：

```js
const inject = ["jobs", "slots", "locale"];        // :596-600
function apply(ctx) {
  ctx.effect(() => ctx.locale.register("job", { zh, en }), "ui-jobs: dictionaries");   // :606-609
  ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
    name: "conversation.session.header.actions",
    id: "job-list",
    order: 20,
    locale: "job",
    inject: () => ({                              // ← 往 slot 组件注入数据/动作
      hooks: { jobs: ctx.jobs.state },
      watchRows: (sessionId) => ctx.jobs.watchRows(sessionId),
      observe:    (sessionId, id) => ctx.jobs.observe(sessionId, id),
      killJob:    async (s, j) => (await ctx.jobs.kill(s, j)).ok
    })
  }, JobListAction));
}
```

> 注意 `inject: () => ({ hooks: { jobs: ctx.jobs.state } })`——**hook 本身当数据源传下去**，
> slot 组件里 `useJobs((state) => state.rows[sessionId])` 订阅（:312-313）。这是官方传"活数据"的标准姿势。

---

## 3. 数据桥：宿主半 → 客户端半

### 3.1 三条路的判定

| 路径 | 机制 | 谁能用 | 证据 |
|---|---|---|---|
| **A. Remote stream（server push）** | `@Remote({mode:"stream"})` + async generator，浏览器 `ctx.remote.$stream()` 订阅 | ✅ 插件可用 | `dsh-api-job-controller/lib/index.js:264-265, 332-334`；客户端 `…/lib/client.js:352-358` |
| **B. Remote direct（请求-响应）** | `Remote("kill")` 普通方法，浏览器 `remote.job.kill({...})` | ✅ 插件可用 | `dsh-api-job-controller/lib/index.js:266, 362-373` |
| **C. 广播事件 `ctx.remote.$on("ns/evt")`** | 浏览器订阅转发后的 Cordis 事件 | ❌ **插件不可用** | 白名单硬编码 `dsh-api-remotes/lib/index.js:17-126` |
| D. 会话投影（Session store） | 面板直接读会话快照里已投影的字段 | ⚠️ 受限 | 见 §3.5 |

**C 为什么不行（关键结论）**：
`dsh-api-remotes/lib/index.js:6-17` 的注释写明这是 "The one home of this application's forwarded-Host-event
allowlist"；而 `dsh-api-remotes/lib/index.js:17-126` 是一张**硬编码的 27 条事件名清单**（含
`plugin-manager/changed` :103、`plugin-manager/install-log` :107、`plugin-manager/install-state` :111、
`schedule/changed` :119 等）。事件名是**应用级常量**，不是插件可注册的命名空间。
消费面示例：`dsh-client-ui-plugin-manager/lib/client.js:3688`（`ctx.remote.$on("plugin-manager/changed", refresh)`）。

> **所以 M4a 必须走 A 或 B，不能走"宿主 ctx.emit 事件 → 客户端订阅"。**

### 3.2 官方 jobs 面板是订阅流，不是轮询

原始问题"jobs 面板是轮询还是订阅事件"——**是订阅（server push over stream）**，全链路无数据轮询。

客户端侧 `dsh-api-job-controller/lib/types/client/service.js:89-101`：

```js
startRows(sessionId) {
  const name = "job rows " + String(sessionId);
  const stream = this.remote.$stream({
    name,
    open: signal => this.remote.job.list({ sessionId }, signal),   // ← 打开流
    ended: accepted => accepted
      ? new RemoteStreamCarrierError(name + " ended before release")
      : new Error(name + " ended before its first frame"),
  });
  …
}
```

消费循环（整帧替换）：`dsh-api-job-controller/lib/types/client/service.js:107-110`（`for await (const item of stream) { this.model.rowsReplaced(…) }`）。

组件侧只订阅本地快照，**没有任何定时器拉数据**：
- `useJobs((state) => state.rows[sessionId])`——`dsh-client-ui-jobs/lib/client.js:312`
- `react.useEffect(() => watchRows(sessionId), [sessionId, watchRows])`——`dsh-client-ui-jobs/lib/client.js:330`（挂载即开流）
- 唯一的 `setInterval` 是**秒表**（显示已运行时长），不拉数据——`dsh-client-ui-jobs/lib/client.js:334-336`

客户端模型层是 **React-free 的快照 store**（`getSnapshot`/`subscribe`），与 UI 解耦：
`dsh-api-job-controller/lib/client.js:21-49`（`ClientJobsModel.rowsBySession` / `snapshotCache` / `subscribe`）。

### 3.3 宿主半怎么发（server 端）

三步：继承 `TypertRemoteService` → 装饰器标 stream → 返回 async generator。

`dsh-api-job-controller/lib/index.js`：
- 依赖：`import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol"`（:2）
- 类定义：`class JobController extends TypertRemoteService`（:261）
- 装饰器：`_list_decorators = [Remote({ mode: "stream" })]`（:264）
- 命名空间：`super(ctx, "jobController", { namespace: "job" })`（:319）→ 浏览器侧即 `ctx.remote.job`
- 方法即生成器：`list(request, signal) { return streamJobRows(this.ctx.jobs, request, { flushMs: this.observeFlushMs }, signal); }`（:332-334）
- Service 依赖与配置：`static inject = ["jobs", "typert"]`（:307）、`Config`（:308-311）

生成器本体（**唤醒 + 合帧**模式，我们照抄这个骨架）——`dsh-api-job-controller/lib/index.js:175-200`：

```js
async function* streamJobRows(registry, request, options, signal) {
  signal.throwIfAborted();
  const waiter = new OutputWaiter();
  const unsubscribe = registry.events.subscribe({ owners: "all" }, (event) => {
    if (event.type === "output") return;
    const owner = event.job.owner;
    if (owner === void 0 || owner === request.sessionId) waiter.wake();
  });
  try {
    yield { type: "rows", jobs: registry.list(request.sessionId) };  // 开流先给全量
    while (true) {
      await waiter.wait(signal);
      await sleep(options.flushMs, signal);      // 合帧窗口，默认 100ms
      if (signal.aborted) return;
      yield { type: "rows", jobs: registry.list(request.sessionId) };  // 之后每次变化重发全量
    }
  } finally { unsubscribe(); }
}
```

合帧窗口与帧大小默认值：`dsh-api-job-controller/lib/index.js:251-253`（`DEFAULT_OBSERVE_FLUSH_MS = 100`、
`DEFAULT_OBSERVE_MAX_FRAME_BYTES = 64 * 1024`）；经 `Config` 暴露（:308-311）。
`OutputWaiter`（不丢唤醒的等待器）：`dsh-api-job-controller/lib/index.js:11-41`；可中止 sleep：:48-58。

**要点：官方不在每条事件上发一帧，而是"有变化就 wake，合窗后重发全量"**——这天然够 N≤128 的 swarm 成员表用。

### 3.4 客户端半怎么收

`dsh-api-job-controller/lib/client.js:346-359`：

```js
const inject = ["remote", "remote.job"];        // :347  ← 显式声明要用到的 Remote 命名空间
function apply(ctx) {
  const { remote } = ctx;
  const { job } = remote;
  new ClientJobs(ctx, { $stream: (options) => remote.$stream(options), job }, new ClientJobsModel());
}
```

注意 `:338-344` 的注释给了一条**重要纪律**：
> "The plugin resolves both Remote faces it drives **while its own context is current**, because stream
> (re)opens run on caller stacks … whose dynamic context has not declared remote.job."

即：**构造时就把 `remote`/`remote.job` 解出来存着**，不要在流回调里再 `ctx.get()`。

客户端服务类（`Service` 子类 + 引用计数 + 可逆拆卸）：
- `class ClientJobs extends Service` + `super(ctx, 'jobs')`——`…/lib/types/client/service.js:12, 24`
- 引用计数 acquire/releaser（多面板共享一条流）——`…/lib/types/client/service.js:44-49, 51-60, 67-88`
- 卸载时异步拆卸所有流（`Promise.allSettled`）——`…/lib/types/client/service.js:28-39`
- 每条观察流的帧分发（opened/output/status）——`dsh-api-job-controller/lib/client.js:310-332`

### 3.5 第三条参考路径：会话投影（为什么官方 agent-team 对我们不可见）

agent-team 面板**不发任何 RPC**，直接读共享 Session store：
`dsh-experimental-client-ui-agent-team/lib/client.js:466` 注释——"The panel reads the Lead Session's agentTeam
projection from the shared Session store; this registration performs no Team RPC."
反查 lead session：:475-477（`sessions.binding(sessionId)?.session.getSnapshot().subagent?.address?.parentSessionId`）。

**这条正是 spec.md 里"官方面板对 one-shot 子代理不可见"的根因**（会话投影按 subagent/descriptor 过滤，
我们的一端子代理不进那条投影）——所以 M4a 走 §3.2/§3.3 的自有 stream，**不复用**这条。
顺带：它证明"面板不发 RPC"是可行的省事路线，但只适用于已被投影的数据。

---

## 4. 我们工具侧可用的数据源与最小事件模型

### 4.1 现有可观测时机盘点（逐条带行号）

| 时机 | 现有钩子/落点 | 证据 |
|---|---|---|
| 批次开始 | `execute` 里 `runSwarm(...)` 调用点 | `src/index.ts:369` |
| 校验通过、拿到 specs | 校验成功后 | `src/index.ts:349` |
| 父 Agent（→ 会话身份） | `exec.agent`；`exec.agent.session` 即当前 Session | `src/index.ts:363`；`docs/spike-dsh-api.md:510-511` |
| **成员 start 成功（拿到 run）** | `run = await ctx.subagents.start(...)` 之后 | `src/index.ts:252-258` |
| **成员拿到 agentId** | `attempt.setAgentId(run.id)` | `src/index.ts:269` |
| **成员首个请求已发出** | `attempt.markReady()` | `src/index.ts:270` |
| **成员 settle（完成/失败/取消）** | `runOneTask` 的 return/throw + `finally run.dispose()` | `src/index.ts:273-283` |
| 限流挂起 | `onSuspended(spec, agentId?, reason, retryCount, retryDelayMs, retryReadyAt)` | `src/scheduler.ts:531-538`；类型 `src/types.ts:178-188` |
| 放弃（死锁防护/批次取消） | `onAbandoned(spec, agentId?, outcome, error)` | `src/scheduler.ts:484-489, 592-608`；类型 `src/types.ts:190-195` |
| 批次结束 | `runSwarm` 的 Promise resolve | `src/index.ts:369-397` |
| 调度器只读快照（并发/容量） | `SwarmSchedulerSnapshot`（activeCount/pendingCount/rateLimitCapacity…） | `src/scheduler.ts:52-62, 174-185` |
| 成员最终结果（终态三值） | `SwarmTaskResult.outcome` + `.state`（正交） | `src/types.ts:27-44` |

> **三处缺口**（M4a 需补）：
> ① `onSuspended`/`onAbandoned` 目前 `src/index.ts` **没有传**给 `runSwarm`（deps 只传了
> now/setTimeout/clearTimeout/signal/isRateLimitError/classify/executor，`src/index.ts:370-384`）；
> ② `SwarmSchedulerSnapshot` **没有对外出口**（`runSwarm` 只返回结果数组，`src/scheduler.ts:656-662`）——
> 想显示"并发 3/5、限流模式"需新增出口；
> ③ 目前**没有任何东西把 agentId 关联回"哪个 swarm 成员"**，面板侧也无 sessionId 概念，需在宿主半自建一张表。

### 4.2 建议的最小事件模型

**核心设计决策：只推"整份成员表快照"，不推增量事件。** 依据 = 官方 jobs 的 `rows` 帧
（`dsh-api-job-controller/lib/index.js:184-195`）与 agent-team 的 `memberStatus` 闭集
（`dsh-experimental-client-ui-agent-team/lib/client.js:445-448`）。理由：N≤128，整表重发成本可忽略，
且免去客户端做事件重排/丢帧恢复的复杂度。

**一个流 + 三种帧类型**（对应任务书的"swarm 开始 / 成员变化 / 批次结束"；成员完成落在 roster 帧内）：

```ts
type SwarmFrame =
  | { type: "roster";  swarmId: string; sessionId: string; total: number;
      members: SwarmMemberView[]; at: number }     // 开流先给全量，之后每次变化重发全量
  | { type: "opened";  swarmId: string; at: number }   // 批次开始
  | { type: "closed";  swarmId: string; at: number };  // 批次结束
```

`SwarmMemberView`（面板要显示的全部信息，一行一成员）：

```ts
interface SwarmMemberView {
  index: number;              // 1-based，直接用 SwarmTaskSpec.index（src/types.ts:19-20）
  item: string;               // 原始 item，用于列表主标题
  agentId?: string;           // 已 start 才有（src/index.ts:269）
  phase: "pending"            // 未启动：队列里
        | "starting"          // start() 在途
        | "running"           // markReady() 之后（src/index.ts:270）
        | "retrying"          // onSuspended 之后，等 retryReadyAt（src/scheduler.ts:531-538）
        | "completed" | "failed" | "aborted";   // 对齐 SwarmOutcome（src/types.ts:27）
  retryCount: number;         // onSuspended 携带（src/types.ts:183）
  retryReadyAt?: number;      // 同上（src/types.ts:187）——面板可显示"约 N 秒后重试"
  startedAt?: number;         // markReady 时刻（宿主半自己记）
  settledAt?: number;         // 终态时刻
  detail?: string;            // 失败/限流原因：onAbandoned.error（src/types.ts:194）/ stopReason
}
```

映射关系（一句话）：**`SwarmTaskResult.outcome` 直接就是 `phase` 的终态三值**（`src/types.ts:27`），
**`SwarmTaskResult.state` 是"有没有真启动过"**（`src/types.ts:30`），两者正交——
面板上"从未启动的成员"应显示为 `pending`（灰），而不是 `failed`。

**合帧**：宿主侧用 100ms 合窗（照抄 `dsh-api-job-controller/lib/index.js:251` 的 `DEFAULT_OBSERVE_FLUSH_MS`）。
swarm 成员状态是低频事件，合帧几乎无损，但能挡掉 128 个成员同刻完成时的帧风暴。

---

## 5. 双半同一包的完整形态

### 5.1 官方两种分包路线

| 路线 | 例 | 说明 |
|---|---|---|
| **同包双半** | `dsh-api-job-controller` | 宿主 Remote + 浏览器 service 同包 |
| **分包** | `dsh-plugin-manager`（宿主）＋ `dsh-client-ui-plugin-manager`（UI） | 大型功能拆两包，UI 包的 `dsh.client.inject` 里列宿主包 |
| 纯 UI 包 | `dsh-client-ui-jobs` | 自身宿主半是空 `apply()`，数据全靠 `inject` 进来的 `@deepseek-ai/dsh-api-job-controller`（`package.json:54-59`） |

证据：
- 同包：`dsh-api-job-controller/package.json:16-39`（`.` + `./types` + `./client` + `./typert` + `./remote`）；
  `lib/` 下同时有 `index.js`（宿主 Remote）与 `client.js`（浏览器 Service）
- 分包：`dsh-client-ui-plugin-manager/lib/client.js:3658-3667` 的 `inject` 里列
  `"remote"`、`"remote.pluginManager"`、`"remote.pluginInventory"`、`"remote.pluginRegistryProbe"`
- 类型走共享包：`dsh-api-job-controller/package.json:21-24`（`./types` → `lib/types/types.js`）

### 5.2 推荐：我们走同包双半

理由：
1. swarm 事件模型与 Remote 服务强耦合（同包共用 `./types` 共享类型，一处定义两半用）；
2. 我们的 `main` 已经有肉（工具注册），不需要分包的"空壳宿主"；
3. `dsh-api-job-controller` 就是这个形态的官方背书。

同包还需额外产出（官方同类包的清单）：
- `./typert`：宿主面元数据（`dsh-api-job-controller/lib/typert.host.js`，:48-75 是 TYPERT 结构）
- `./remote`：客户端面描述符（`…/lib/typert.remote-client.js`，:48-67 是 TYPERT_REMOTE 结构）
- `./types`：共享 zod schema（`…/lib/types/types.js`；schema 片段见 `typert.host.js:4-46`）

> **重要未知**：typert 两个文件由 `@deepseek-ai/dsh-typert-generator` **从 FaceModel 自动生成**
> （`dsh-api-job-controller/lib/typert.host.js:1` 原文："Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit"）。
> 我们要不要跑这套代码生成、还是手写等价文件，**本 spike 未找到插件侧的生成配置 → 标记为待验证**。
> 另注：`dsh-host-plugin-inventory/lib/typert.remote-client.js:69` 用了 `export default`——
> 与我们 AGENTS.md「绝不写 export default」红线冲突；该红线约束的是**我们自己的插件模块**，
> 生成物不适用，但若我们手写生成物需在决策笔记里说明例外。

---

## 6. 构建与 HMR

### 6.1 client 半必须预构建

- 产物缺失 → 抛 `MissingClientBundleError`：`dsh-client-modules/lib/index.js:130-142`，
  文案 "client bundle not found; run pnpm run build before launch"（:128, :135-137）
- 批量失败 → `ClientPackageCompositionError` 聚合报错（**一个包坏不影响别的包**）：:144-157
- 发现方式：宿主 Loader 扫 `dsh.client` 声明 → 解析 `exports["./client"]` → 组合 `window.__DSH_BOOT__` 入口图：
  `dsh-client-modules/lib/index.js:104-112`
- 缺产物诊断常量：:128（`CLIENT_BUNDLE_BUILD_INSTRUCTION`）

### 6.2 打包进 Web 产物的机制

| 环节 | 位置 |
|---|---|
| **增量扫描**（每个 `internal/plugin` 发射标脏，微任务 flush；**无全量重扫**） | `dsh-client-modules/lib/index.js:114-125`, :713-719 |
| **元数据按 Loader specifier + 拥有树 base URL 缓存到重启** | `dsh-client-modules/lib/index.js:119-123, 733-756` |
| **产物变更只有一条路进图**：`clientModules.rebuilt(id)` | `dsh-client-modules/lib/index.js:123-124`, :48-62 |
| **HTTP 路由** `/plugins` 前缀 + combo URL（`??a/client.js,b/client.js&rev=…`） | `dsh-client-modules/lib/index.js:201-209` |
| **版本号 = 文件元数据哈希**（mtime/ctime/size，12 位 sha1），不读内容 | `dsh-client-modules/lib/index.js:192-199` |
| **不可变缓存** `public, max-age=31536000, immutable` | `dsh-client-modules/lib/index.js:158-159` |
| **URL 长度上限 3KB**（约束组合包数量） | `dsh-client-modules/lib/index.js:160-161` |
| **懒加载 chunk 命名约束** `client.<hash>.js` | `dsh-client-modules/lib/index.js:168-169` |
| **注入 webserver 的 index 注入表 + 组合图** | `dsh-client-modules/lib/index.js:108-111, 494` |
| 浏览器端懒加载 CJS 模块表 = cordis Loader 的内部 seam | `dsh-client-modules/package.json:3`（description 原文） |

> 推论：客户端半产物**不是**打进一个大 webpack/rollup bundle，而是**运行时按需组合成 combo 脚本**分片下发。
> 我们只需保证 `pnpm run build` 产出 `lib/client.js`（或我们的 `dist/client.js`），剩下的 DSH 自己干。

### 6.3 开发期热更新（HMR）

**HMR 是轮询 stat + SSE，不是文件监听**（网络盘无 inotify 事件）：

- 端点 `/plugins/events`（SSE）：`dsh-client-hmr/lib/index.js:5`
- 轮询间隔默认 500ms：`dsh-client-hmr/lib/index.js:22`（`pollIntervalMs`）
- 比对 `mtimeMs`/`ctimeMs`/`size` 三元组：`dsh-client-hmr/lib/index.js:36-39`
- 变了就 `ctx.clientModules.rebuilt(id)`：`dsh-client-hmr/lib/index.js:48-50`
- 依赖 `inject = ["clientModules", "webServer"]`：`dsh-client-hmr/lib/index.js:21`
- 其客户端半声明 `immediately: true`（提前加载）：`dsh-client-hmr/package.json:32-40`
- 该 transport 只在 web 组合挂载时才在：`dsh-client-hmr/lib/index.js:15-16`（"The Web composition mounts this transport for live graph updates"）

**所以开发循环是**：改 TSX → `pnpm run build`（产出 client bundle）→ ≤1s 内浏览器收到 SSE → 页面 reload。
**没有"保存即生效"，必须每次 build。**

> 我们是外部插件包，不共享 DSH 自身的 `pnpm run dev:web` watcher，
> 因此**一律走"build + 刷新"**，不要对外承诺自动热更新。

---

## 7. M4a 接口建议

> 以下为**建议**（非既定结论），供 M4a 排期时取舍。

### 7.1 package.json 双半形态（建议）

```jsonc
{
  "name": "dsh-agent-swarm",
  "exports": {
    ".":        { "types": "./dist/types/index.d.ts", "default": "./dist/index.js" },
    "./client": { "types": "./dist/types/client/index.d.ts", "default": "./dist/client.js" },
    "./types":  { "types": "./dist/types/types.d.ts", "default": "./dist/types/types.js" },
    "./src/*":  "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["dist/index.js", "dist/client.js", "dist/types/**/*.js", "dist/types/**/*.d.ts"],
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",       // 字典（官方 jobs 面板也用它）
        "@deepseek-ai/dsh-client-ui-primitives" // StateDot 等基础组件
      ],
      "platform": "web"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.4",
    "@deepseek-ai/dsh-typert-protocol": "0.2.0-rc.2",
    "@deepseek-ai/dsh-client-ui-slots": "0.2.0-rc.2"
  }
}
```

要点：
- 宿主半入口**保持现状** `dist/index.js`（已有工具注册；AGENTS.md 红线要求 main 指向 dist）；
- 客户端半新产出 `dist/client.js`，**必须预构建**，形状 = `window.__ModuleLoader__.load({id, factory})`；
- 挂点选 `sidebar.panellist`（独立页面）还是 `conversation.session.header.actions`（弹层）**待定**：
  前者 UX 更好但主栏页面槽位归属未验证（§2.2 风险提示），后者机制已实证（jobs 面板同款）。
  **建议一期先走 header.actions（低风险可交付），后续再升级成独立面板。**

### 7.2 宿主侧改动点（对 src/index.ts 的具体建议）

**(1) 新增 `src/swarm-registry.ts`（纯逻辑，零 DSH 依赖，可单测）**
维护 `sessionId → swarmId → Map<index, SwarmMemberView>` 的表，暴露
`beginBatch()` / `markStarting()` / `markReady()` / `markSettled()` / `endBatch()` 与
`onAnyChange(listener)`（合帧 100ms 后回调一次）。这样 scheduler 层的纯函数测试不受影响。

**(2) `src/index.ts` 的逐点改动**

| 位置 | 现状 | 建议 |
|---|---|---|
| `src/index.ts:53` | `inject = ["tools","subagents"]` | 追加 Remote 侧依赖（如 `"typert"`），另建 `SwarmRemoteService` 以 stream 模式暴露 `swarm/roster` |
| `src/index.ts:252` 之后 | 取得 run 但未记账 | 调 `registry.markStarting(index)` |
| `src/index.ts:269` | `attempt.setAgentId(run.id)` | 之后记账 `agentId` |
| `src/index.ts:270` | `attempt.markReady()` | 之后记账 `markReady(index, now)` |
| `src/index.ts:263-266`（start 抛错分支） | 直接 throw | throw 前先 `registry.markSettled(index, "failed", …)`，避免面板永远停在 starting |
| `src/index.ts:273-283` | `await run.result` + finally dispose | resolve 记 `completed`；throw 时按 `result.stopReason === "aborted"` 区分 `aborted`/`failed`（spike Q5：aborted 是取消不是限流） |
| `src/index.ts:370-384`（`runSwarm` 的 deps） | 未传 `onSuspended`/`onAbandoned` | **补传**：把 `retryCount`/`retryReadyAt`/`error` 写进 registry，`phase → "retrying"` |
| `src/index.ts:397` 之后 | 无 | 批次结束：`registry.endBatch()` |

**(3) Remote 服务（新增 `src/remote.ts`）**——照抄 §3.3 骨架：

```ts
class SwarmRemote extends TypertRemoteService {   // @deepseek-ai/dsh-typert-protocol
  constructor(ctx) { super(ctx, "agentSwarm", { namespace: "swarm" }); }   // → ctx.remote.swarm
  roster(request, signal) {                        // request: { sessionId }
    const reg = this.ctx.swarmRegistry;
    return reg.framesFor(request.sessionId, signal);   // 内部：开流全量 + 100ms 合帧 + 取消
  }
}
// 装饰器：@Remote({ mode: "stream" })
```

### 7.3 客户端侧面板注册骨架

```ts
// src/client/index.ts —— 构建产物即 §1.3 的 window.__ModuleLoader__ 形状
import { registerSwarmUi } from "./mount.js";

const inject = ["locale", "slots"] as const;        // 对标 jobs:596-600（去掉它依赖的 jobs）

export function apply(ctx) {
  registerSwarmUi(ctx);
}

// src/client/mount.ts
const NS = "agentSwarm";

export function registerSwarmUi(ctx) {
  // ① 字典（双语）
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "agent-swarm: dictionaries");

  // ② 远程订阅：在当前 context 下解出来存住（纪律见 dsh-api-job-controller/lib/client.js:338-344）
  const remote = ctx.remote ?? ctx.get("remote");
  const open = (sessionId) => remote.$stream({
    name: "swarm roster " + sessionId,
    open: (signal) => remote.swarm.roster({ sessionId }, signal),
  });

  // ③ 挂点：会话标题栏动作（jobs 面板同款，最短路径）
  ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
    name: "conversation.session.header.actions",
    id: "agent-swarm",
    order: 30,                       // jobs=20、agent-team=-20，我们 30 排其后
    locale: NS,
    inject: () => ({ open, t: ctx.locale.bind(NS) }),   // 传能力，不传数据（同 :615-620）
  }, SwarmButton));
}

// ④（后续）升级成独立侧栏面板：
// ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
//   { name: "sidebar.panellist", id: "agent-swarm", order: 10, label: () => t("panel"), locale: NS },
//   SwarmPanelIcon));
```

---

## 8. 未找到 / 待验证（不许猜，逐条列出）

| # | 问题 | 状态 |
|---|---|---|
| 1 | 能否注册"主栏页面"（而非仅图标）——主栏路由的具体槽位/服务 | **未找到**公开机制。plugin-manager 走 `plugins` 一族 slot（`dsh-client-ui-plugin-manager/lib/client.js:3707-3754`）+ `ctx.layout.selectPanel`；通用注册入口**未找到** |
| 2 | typert 生成物能否由外部插件跑 `dsh-typert-generator` 生成 | **未找到**插件侧生成配置证据。生成物头部声明 "do not edit"（`dsh-api-job-controller/lib/typert.host.js:1`），能否手写等价文件**未验证** |
| 3 | 客户端半的构建工具链配置（官方用什么把 TSX 打成 `window.__ModuleLoader__.load`） | **未找到**官方构建配置；只有产物里的 tsdown 痕迹（`dsh-client-modules/lib/index.js:164` 的注释提到 tsdown 产出 sourceMappingURL trailer） |
| 4 | Remote 流对"一个客户端同时看多个 session"的 fan-out 上限 | **未找到**硬约束。已知的 3KB 上限（`dsh-client-modules/lib/index.js:161`）是资源 URL 限制，与流无关 |
| 5 | 客户端半能否在插件里直接 `import { Remote } from "@deepseek-ai/dsh-typert-protocol"` | **未验证**（该包 host/client 双面 import 边界未逐行核对） |
| 6 | 客户端半是否必须声明 bundle 才被客户端发现 | **未验证**，与 M4b（bundle 化）相关；本 spike 只覆盖双半形态 |
| 7 | 我们的插件包（非官方仓）产出的 client bundle 是否会被 HMR transport 拾取 | **未验证**；机制上 `dsh-client-hmr` 遍历 `ctx.clientModules.graph()` 的每行（:95-100），理论上覆盖，缺实测 |

---

## 附：本 spike 实读的包

`@deepseek-ai/` 下：`dsh-client-ui-jobs`、`dsh-client-ui-sidebar`、`dsh-client-ui-plugin-manager`、
`dsh-experimental-client-ui-agent-team`、`dsh-experimental-agent-team`、`dsh-client-modules`、
`dsh-client-hmr`、`dsh-api-job-controller`、`dsh-api-remotes`、`dsh-host-plugin-inventory`、
`dsh-jobs`、`dsh-plugin-manager`、`dsh-cordis-client-runner`、`dsh-tools`、`dsh-subagent`、
`dsh-typert-protocol`（仅包结构）。
