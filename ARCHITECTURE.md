# dsh-agent-swarm 架构

DSH host 插件：把"批量子代理任务"包装成一个模型可调用的 `agent_swarm` 工具，自带限流自适应调度。
同一份包还含一个 client 半（会话标题栏状态面板），由预构建脚本单独产出并随包分发。

## 模块边界

```
src/
  types.ts               纯类型：任务规格、结果、调度器配置、错误码、默认调度参数
  validate.ts            纯函数：六道硬校验 + 模板展开（{{item}}）+ prompt 去重 + per-call 模型路由匹配（白名单）
  result-xml.ts          纯函数：<agent_swarm_result> 渲染（属性/body 转义、编号一致）
  scheduler.ts           纯逻辑调度器：首波/放量/退避/容量收缩恢复；执行函数、限流判定、时钟全部注入
  swarm-registry.ts      纯逻辑状态机：成员七态生命周期 + 100ms 合帧 roster 广播（面板的数据源）
  remote.ts              host 半 Remote 服务：TypertRemoteService 以 stream 暴露 swarm/roster
  remote-descriptor.ts   纯数据：客户端 $mount 用的 TYPERT_REMOTE 描述符（零宿主依赖）
  index.ts               插件入口 apply(ctx)：注册工具、接 ctx.subagents、装配调度器与 registry、
                         按需读 ctx.subagentModelSelection 白名单（可选服务，per-call model 的唯一权威源）
  client/                同包 client 半（由 scripts/build-client.mjs 单独打包，不进 tsc 产物）
    index.ts               client 入口 apply(ctx)：**父 fiber** 只做 $mount Remote（提供 remote.swarm 命名空间），
                       随后用 ctx.plugin 载入**子 fiber**（inject 声明 remote.swarm）注册槽位与字典
                       —— 提供与消费必须分属两个 fiber，理由见决策笔记 2026-10-01-client-namespace-inject-isolation.md
    model.ts               会话/成员视图的内存模型（useSwarm 的订阅源）
    service.ts             按会话引用计数订阅 swarm/roster 流
    SwarmHeaderAction.tsx  标题栏动作与弹层组件（含内联样式；成员按相位四组独立折叠、批次路由标签）
scripts/build-client.mjs   esbuild 预构建：src/client/index.ts → dist/client.js（__ModuleLoader__ 包）
tests/                     vitest：纯函数单测 + mock Context 契约测试 + 真实 Loader 测试 + client 模型/服务
cordis.patch.yml           bundle 层：insert 唯一的 agent-swarm 行（name 自指本包）
icon.svg                   插件管理页图标
docs/                      spec.md、code-quality-review 报告、spike 笔记
```

## 依赖方向

host 半：`index.ts` 是唯一装配点，向下引用 `scheduler.ts`、`validate.ts`、`result-xml.ts`、`swarm-registry.ts`、`remote.ts`；
`remote.ts` → `swarm-registry.ts`；`scheduler.ts`、`validate.ts`、`result-xml.ts` → `types.ts`（三者**互不依赖**）。

**方向别读错**：`scheduler.ts` 不依赖 `validate.ts` / `result-xml.ts`——它们在 `index.ts` 的执行链里先后被调用（那是**数据流**，见下节），不是模块依赖。

client 半：`client/index.ts` → `client/model.ts`、`client/service.ts`、`SwarmHeaderAction.tsx`、`../remote-descriptor.ts`（其中 `remote-descriptor` 是值引用）。
client 半的模块之间**只有类型引用**（`import type`）：模型实例经槽位 `inject` 注入到组件与服务，不存在运行时模块耦合。

纯逻辑层（types / validate / result-xml / scheduler / swarm-registry / remote-descriptor）**零 DSH 运行时依赖**，
可脱离宿主单测；`remote.ts` 依赖 `@deepseek-ai/dsh-typert-protocol`，是 host 半里唯一的协议层依赖。

## 数据流

模型调 `agent_swarm` → validate 展开任务 → per-call model 经宿主白名单解析为批次路由（缺省继承父 agent）
→ scheduler 按节奏并发执行 → 每个任务经 `ctx.subagents.start("spawn", …)` 派发 one-shot 子代理
→ 结果汇聚 → result-xml 渲染 → 工具结果返回模型。
中断：AbortSignal 级联取消在跑任务并清空队列。

## host/client 双半数据流（面板）

调度器相位变化 → 写入 `swarm-registry`（成员七态 + 批次路由标签）→ registry 100ms 合帧广播三类帧（opened / roster / closed）
→ `remote.ts` 以 stream 下发 → client 的 `service.ts` 按会话引用计数订阅并写入 `model.ts`
→ `SwarmHeaderAction.tsx` 渲染标题栏徽标与弹层。

**权威口径：工具返回的 XML 是成员状态的唯一权威，面板只是过程可见性。** 两者不一致时以 XML 为准
（2026-10-01 审查发现中断路径上 registry 与 XML 结论相反，已修复，见 `.agents/notes/implemented/bug-fix/`）。

## 构建与交付链

`pnpm build` = `tsc -p tsconfig.build.json`（→ `dist/*.js` + `.d.ts`）+ `node scripts/build-client.mjs`（→ `dist/client.js`）。

- `package.json` 的 `main` 必须指向 `dist/index.js`：Node 拒绝对 node_modules 下的 .ts 做类型剥离（实测报错）；
- `exports["./client"]` ↔ `dist/client.js`，`files` 白名单收 `dist`；
- 测试链：`pnpm test` **先构建再跑 vitest**；client 侧测试在内存里用 esbuild 打包，host 侧 Loader 测试加载 `dist/index.js`。

## 挂载形态

本包是**自指 bundle**：`package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`，该文件 insert 一行
`name: dsh-agent-swarm` 指向本包自身。`dsh plugin add` 见到该声明才把包名 reconcile 进
`dsh.profile.bundles`，插件管理页随即可见可开关可卸载。

层序固定为：bundle 层 → profile 的 `cordis.patch.yml` → `--patch` 覆盖层。**用户层只能按 id
`agent-swarm` 改 config 或 disable，不得再 insert 同行**（会重复挂载）。

## 维护规则（本文件的自我约束）

模块边界、依赖方向、双半数据流、构建链任意一项发生变化时，**必须同轮回写本文件**。
本仓里程碑收口门禁第 2 条是"对照 ARCHITECTURE.md 审查模块边界没被突破"——本文件一旦滞后，
该门禁就失去参照物。2026-10-01 审查发现 M4a 引入的 8 个源文件（swarm-registry/remote/remote-descriptor/client×4/build-client）
从未回写本文件，即是该失效的实例。
