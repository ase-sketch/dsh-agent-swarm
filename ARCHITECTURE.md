# dsh-agent-swarm 架构

DSH host 插件：把"批量子代理任务"包装成一个模型可调用的 `agent_swarm` 工具，自带限流自适应调度。

## 模块边界

```
src/
  types.ts        纯类型：任务规格、结果、调度器配置
  validate.ts     纯函数：五条硬校验 + 模板展开（{{item}}）+ prompt 去重
  result-xml.ts   纯函数：<agent_swarm_result> 渲染（body 转义、编号一致）
  scheduler.ts    纯逻辑调度器：首波/放量/退避/容量收缩恢复；执行函数、限流判定、时钟全部注入
  index.ts        插件入口 apply(ctx)：注册工具、接 ctx.subagents、装配调度器
tests/            vitest：纯函数单测 + mock Context 契约测试 + 真实 Loader 测试
cordis.patch.yml   bundle 层：insert 唯一的 agent-swarm 行（name 自指本包）
icon.svg          插件管理页图标
docs/             spec.md、spike 笔记
```

## 依赖方向

`index.ts`（DSH 依赖）→ `scheduler.ts` → `validate.ts`/`result-xml.ts` → `types.ts`。
纯函数层（validate/result-xml/scheduler/types）**零 DSH 依赖**，可脱离运行时单测。

## 数据流

模型调 `agent_swarm` → validate 展开任务 → scheduler 按节奏并发执行
→ 每个任务经 `ctx.subagents.start("spawn", …)` 派发 one-shot 子代理
→ 结果汇聚 → result-xml 渲染 → 工具结果返回模型。
中断：AbortSignal 级联取消在跑任务并清空队列。

## 挂载形态

本包是**自指 bundle**：`package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`，该文件 insert 一行
`name: dsh-agent-swarm` 指向本包自身。`dsh plugin add` 见到该声明才把包名 reconcile 进
`dsh.profile.bundles`，插件管理页随即可见可开关可卸载。

层序固定为：bundle 层 → profile 的 `cordis.patch.yml` → `--patch` 覆盖层。**用户层只能按 id
`agent-swarm` 改 config 或 disable，不得再 insert 同行**（会重复挂载）。

