# dsh-agent-swarm 规格

> 将 Kimi Code 桌面版 `swarm`（AgentSwarm）功能 clean-room 适配为 DSH 插件。
> 来源资料：`../extracted/kimi-code-swarm-analysis/`（逆向分析仓，与本仓同级的上级目录）。

## 约束

- 【硬约束】**公开分发** → clean-room：实现只依据 `01-机制文档/`（行为描述）与 `03-v1源码/`、`04-协议层/v1-*`（MIT，可参考须带 THIRD-PARTY-NOTICES）。`02-v2源码/` 对实现者**封存**；提示词原文（05-提示词全文.md）同样不可照抄，工具描述须重写。
- 【硬约束】不复刻 Kimi UI。官方智能体团队面板**对 one-shot 子代理不可见**（spike Q10 证据：agent-team 过滤带 subagent/descriptor 的会话）→ 可视化走**自研 client 面板**（M4，host/client 双半，自有事件桥，不依赖 agentTeam 投影）。
- 【硬约束】DSH 0.2 developer preview，API 可能变；插件声明兼容版本范围。
- 【偏好】调度参数（首波并发 5、放量 700ms、退避 3000ms×2ⁿ、超时 2h）做成插件 config，默认值照 Kimi 实测。

## 功能清单（终态 = 完整功能除 UI，分期交付）

一期（本次）：
1. `agent_swarm` 工具：`description` + `prompt_template`（含 `{{item}}`）+ `items[]` 展开为 N 个子代理任务
2. 五条硬校验：items≥2、总数≤128、有 items 必有 template、template 必含占位符、展开后 prompt 互不相同
3. 并发调度器：首波 5 并发、之后每 700ms 放 1 个、限流指数退避（3000ms×2ⁿ）、容量收缩防抖 2000ms、每 180s 恢复 +1（下限 1）、最后任务持续限流判 failed（死锁防护）、首个请求未发出的限流重罚
   —— **交付态修正（2026-10-01）**：本条前半（首波/放量/超时/中断/结果落位）已交付；**限流相关的后半（退避、容量收缩恢复、死锁防护、重罚）在交付态无触发路径**，详见下「交付状态」。
4. 每任务超时（默认 2h 可配，**自建** `AbortSignal.any([父signal, AbortSignal.timeout])`——start() 无 timeout 字段）+ 用户中断级联取消；每个 `start()` 成功必须配对 `run.dispose()`
5. 结果汇总：`<agent_swarm_result>` XML，**body 转义**、编号一致（规避 Kimi 已核实缺陷 D13/D14）
6. 插件 config：并发/节奏/超时参数；**自动批准无需声明**（spike Q8：无 approvalRule 机制，不调 ctx.approval 即不弹窗）；子代理沙箱档位经 `parent: exec.agent` 自动继承
7. 测试三层：纯函数单测 + mock Context 契约测试 + 真实 Loader 加载测试

二期（本仓 backlog，另行 spike）：resume_agent_ids（continuable 续跑）、fork、模式状态机（enter/exit 提示词注入 + 轮末自动退出）、model/subagent_type 选择、团队面板整合（若自研面板后仍需要）。
其中 `resume_agent_ids` 的前置条件（结果块需回传 `agent_id`）已于 2026-10-01 修复落地。

## 交付状态（2026-10-01 审查后回写）

审查报告：`docs/code-quality-review-2026-10-01.md`。以下是与原规格不一致的交付事实，逐条回写：

- **一期限流退避未交付（未收敛）**：`src/index.ts` 的 `isRateLimitErrorPhaseOne` 恒返回 false，
  而它是调度器唯一的限流判定入口（`src/scheduler.ts` 中"限流结局"的唯一产出点）→ 退避、容量收缩/恢复、
  `retrying` 相位、面板退避 UI 全部不触发。**启用前置条件**（二者都满足才动手）：
  ① M3 实机确认子会话 `llm/retry` 事件的 `failure.code` 取值；
  ② 先修掉该子系统内的既有缺口（容量无上界、无退出限流模式的路径、并发闸门与容量恢复的互锁），
  这些缺口在死代码里不影响现网，但一旦启用即生效。
- **`resume_agent_ids`（二期）的取值来源已补齐**：结果块此前丢弃 `agent_id` 属性，已修复；二期续跑不再被这一条卡住。
- **测试链改为先构建**：`pnpm test` 现在前置 `pnpm run build`，client 侧测试在内存里打包，host 侧 Loader 测试加载 `dist/index.js`
  （此前各测各的：client 测盘上旧产物、host 测源码命名空间、`dist/index.js` 无人验证）。
- **clean-room 文案修正**：三条与上游逐字相同的文案/常量已改写为本仓自拟（见 `THIRD-PARTY-NOTICES.md`）。

## 非目标

- 任何 Kimi UI 复刻；不做独立渲染卡片
- swarm 成员嵌套 swarm（DSH maxDepth 默认 1，工具描述中明示禁止）
- 一期不做跨会话的 swarm 状态持久化

## 验收

- M1：`pnpm test` 全绿（五条校验分支、模板展开、XML 转义往返、调度节奏 fake-timers）
- M2：契约测试 + 真实 Loader 测试全绿；`dsh --profile web --dump-config` 可见插件
- M3：用户重启 DSH 后真实会话调 `agent_swarm` 跑 3 个小任务：批量执行、XML 结果汇总正确（成员状态以 XML 为准）
- M3 顺带实机验证 spike 风险项：R1 限流事件 `llm/retry` 的 failure.code 取值、R3 并发活跃度、R4 沙箱继承、R5 子代理审批行为
- M4a：自研 client 面板（swarm 成员列表 + 状态/进度），host 半发事件、client 半渲染，真实会话目测验收
- M4b：**打包形态升级为 bundle**（package.json 声明 dsh.bundle.patch + 自带 cordis.patch.yml 挂载 agent-swarm 行），目标 = 侧边栏「插件」管理页可见、可启停、可卸载（用户明确要求：只读 inventory 可见不够）。验收：web `dsh --profile web --dump-config` exit 0 且 agent-swarm 恰好一行（bundle 层下）；headless 探针返 ITEMS_TOO_FEW 证明工具活；管理页条目可见待用户重启两端后目测（Electron 独占，代理不代重启）

## 参考项目

- 机制依据：`extracted/kimi-code-swarm-analysis/01-机制文档/`（00/02/03/04 篇为主）
- 合法代码参考（MIT）：`extracted/kimi-code-swarm-analysis/03-v1源码/`、`04-协议层/v1-protocol-swarm-slices.mjs`
- DSH 侧契约：`@deepseek-ai/dsh-subagent`（ctx.subagents.start/startContinuable）、`@deepseek-ai/dsh-tool-subagent`（工具组合范例）、`@deepseek-ai/dsh-tools`（defineTool）