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
2. 六道硬校验：items≥2、总数≤128、有 items 必有 template、template 必含占位符、展开后 prompt 互不相同；item 元素必须是非空字符串（第六道，2026-10-01 审查后补）
3. 并发调度器：首波 5 并发、之后每 700ms 放 1 个、限流指数退避（3000ms×2ⁿ）、容量收缩防抖 2000ms、每 180s 恢复 +1（下限 1）、最后任务持续限流判 failed（死锁防护）；~~首个请求未发出的限流重罚~~（2026-10-01 废弃删除：宿主无法观测「首个请求未发出」，该档位在生产接线下永不可达，见限流能力状态笔记）
   —— **交付态修正（2026-10-01）**：本条前半（首波/放量/超时/中断/结果落位）已交付；**限流相关的后半（退避、容量收缩恢复、死锁防护）在交付态默认关闭**（接线已就绪，开启前置条件见下「交付状态」）。
4. 每任务超时（默认 2h 可配；start() 无 timeout 字段，由**调度器的超时闸门**到点 abort 成员信号——该信号同时级联用户中断，取消与超时文案单一来源；2026-10-01 第三轮去掉了重复的 `AbortSignal.timeout`）+ 用户中断级联取消；每个 `start()` 成功必须配对 `run.dispose()`
5. 结果汇总：`<agent_swarm_result>` XML，**body 转义**、编号一致（规避 Kimi 已核实缺陷 D13/D14）
6. 插件 config：并发/节奏/超时参数；**自动批准无需声明**（spike Q8：无 approvalRule 机制，不调 ctx.approval 即不弹窗）；子代理沙箱档位经 `parent: exec.agent` 自动继承
7. 测试三层：纯函数单测 + mock Context 契约测试 + 真实 Loader 加载测试

二期（本仓 backlog，另行 spike）：resume_agent_ids（continuable 续跑）、fork、模式状态机（enter/exit 提示词注入 + 轮末自动退出）、subagent_type 选择、团队面板整合（若自研面板后仍需要）。
其中 `resume_agent_ids` 的前置条件（结果块需回传 `agent_id`）已于 2026-10-01 修复落地；
`model`（按批次选模型）已于 2026-10-01 交付（见下「1.5 期」），`subagent_type` 因 DSH 无 agent profile 对应物仍留 backlog。
**2026-10-01 第三轮**：`fork` 以 DSH 原生 fork provider 交付为可选参数 `context: "fork"`（见 `.agents/notes/implemented/feature/2026-10-01-fork-context.md`；
与上游语义是否等价**未核实**，需 01-机制文档 的行为描述）；`resume_agent_ids` 订正为「阻塞于 one-shot 不可续跑」，
改为先 spike（`.agents/notes/proposed/feature/2026-10-01-resume-agent-ids.md`）；模式状态机延后（`.agents/notes/proposed/feature/2026-10-01-swarm-mode-state-machine.md`）。

## 1.5 期（2026-10-01 交付）：per-call 模型路由 + 面板收纳

1. `agent_swarm` 新增可选 `model` 参数：`"provider/model"` 精确式或白名单内唯一裸 model id；权威源 = 宿主 `subagentModelSelection` 服务（设置页「子智能体 → Model selection」同一份白名单），插件不自备第二份清单
2. 三个新结构化错误码：`MODEL_SELECTION_UNAVAILABLE`（服务未挂载/未开启）、`MODEL_NOT_ALLOWED`（不在白名单，details 附允许清单截断 20 条）、`MODEL_AMBIGUOUS`（裸 id 多 provider 命中）；全部在任何子代理启动之前拒绝
3. 优先级：per-call `model` > config `agentOptions` 固定路由 > 继承父 agent；不带 reasoningEffort（换路由自动取新模型默认档位）
4. 面板收纳：成员按相位分四组（进行中/失败/已完成/已取消）各自独立折叠（前两者默认展开、后两者默认收起，换批次重置）；列表 max-height 定死 + 细滚轮（修 flex `min-height:0`）；头部展示批次路由标签 `模型: provider/model`（继承时读父 agent 当前路由，读不到留空不猜）

## 交付状态（2026-10-01 审查后回写）

审查报告：`docs/code-quality-review-2026-10-01.md`。以下是与原规格不一致的交付事实，逐条回写：

- **一期限流退避：接线已就绪、默认关闭（2026-10-01 第三轮）**。`config.rateLimit.enabled`（默认 false）开启后：
  插件订阅 `session/event`，按子会话 id 收集 `llm/retry` 与 `turn/end`（`src/rate-limit-signal.ts`，纯逻辑）；
  子代理以 `error` 收场且 `turn/end` 记录的最终失败码属于 `rateLimit.failureCodes`（默认 `["RATE_LIMIT"]`）时，
  抛出带品牌的 `SwarmRateLimitedFailure` 交给调度器既有的退避重排队，`rateLimit.maxRetries`（默认 3）透传为
  `maxRateLimitRetries`。关闭时不订阅任何事件，行为与接线前逐字节一致（全部既有用例原样通过 + L 组守护用例）。
  **开启前仍须实机确认**：① 失败码实际取值；② 插件级 `session/event` 监听能否收到子会话事件；
  ③ 子会话 id 是否等于 `run.id`；④ `maxRetries` 取值。未做的「在途背压」见归属决策笔记；「重罚档位映射」已废弃——该档位（`first-request-blocked`，全局间隔翻倍）连同调度器 `classify` 依赖于 2026-10-01 删除，理由是宿主无法观测「首个请求未发出」，永不可达的档位带着全套测试属于僵尸代码。
  以下为接线前的历史记录：原 `isRateLimitErrorPhaseOne` 恒返回 false，
  而它是调度器唯一的限流判定入口（`src/scheduler.ts` 中"限流结局"的唯一产出点）→ 退避、容量收缩/恢复、
  `retrying` 相位、面板退避 UI 全部不触发。**启用前置条件**（三条都满足才动手）：
  ① M3 实机确认子会话 `llm/retry` 事件的 `failure.code` 取值；
  ② 先修掉该子系统内的两个缺口：并发闸门与容量恢复的互锁、宿主回调抛错导致调度停摆（**P2 批次 WP-P2-1 已处理**）；
  ③ 修掉**死锁防护判死条件只覆盖单成员**的缺口：≥2 个成员同时持续限流时原判死式恒不成立，
     而重排队不设上限 → 无限重排队、批次 Promise 永不 resolve（实测 2/3 成员推进 1 小时虚拟时间 settled 恒 false）。
     **已于 2026-10-01 修复**（新增 `SwarmSchedulerConfig.maxRateLimitRetries?` per-task 重试上限 + 双重判死条件），
     但**生产未接线**、取值待 M3 实机校准——见 `.agents/notes/implemented/process/2026-10-01-rate-limit-capability-status.md`。
  原先列的"容量恢复无上界"经复核**判定不修**：`maxConcurrency` 是独立第二道闸门，已兜住"超过宿主设定"这一唯一实际风险；
  给容量加硬上限反而会在"早期限流"后把容量永久锁在 1，比无上界更糟（理由见归属决策笔记的「复核订正」）。
- **`resume_agent_ids`（二期）**：结果块此前丢弃 `agent_id` 属性，已修复。**但 2026-10-01 第三轮订正**：
  "二期续跑不再被卡住"的结论不成立——XML 里的 `agent_id` 是 **one-shot** run 的 id，而 DSH 对非 continuable
  子代理一律抛 `NOT_RESUMABLE`（`@deepseek-ai/dsh-subagent` 续跑路径的 `descriptor.mode !== "continuable"` 判定）。
  真正的前置条件与三条候选路线见 `.agents/notes/proposed/feature/2026-10-01-resume-agent-ids.md`。
- **测试链改为先构建**：`pnpm test` 现在前置 `pnpm run build`，client 侧测试在内存里打包，host 侧 Loader 测试加载 `dist/index.js`
  （此前各测各的：client 测盘上旧产物、host 测源码命名空间、`dist/index.js` 无人验证）。
- **clean-room 文案修正**：三条与上游逐字相同的文案/常量已改写为本仓自拟（见 `THIRD-PARTY-NOTICES.md`）。

## 非目标

- 任何 Kimi UI 复刻；不做独立渲染卡片
- swarm 成员嵌套 swarm（DSH maxDepth 默认 1）。**2026-10-01 第三轮订正**：此前插件不向 start() 透传 `maxDepth`，而 DSH 只在请求带了它时才校验深度——"禁止嵌套"实际只是一句文案。现由 `batch-plan.ts` 经 `ctx.subagents.resolveMaxDepth()` 取宿主上限透传给每个成员，并在开批次前预检（`DELEGATION_DEPTH_EXCEEDED`，零派发）；Config 新增 `maxDepth`（缺省跟随宿主设置 / 自然数 / `"provider-managed"`）
- 一期不做跨会话的 swarm 状态持久化

## 验收

- M1：`pnpm test` 全绿（六道校验分支、模板展开、XML 转义往返、调度节奏 fake-timers）
- M2：契约测试 + 真实 Loader 测试全绿；`dsh --profile web --dump-config` 可见插件
- M3：用户重启 DSH 后真实会话调 `agent_swarm` 跑 3 个小任务：批量执行、XML 结果汇总正确（成员状态以 XML 为准）
- M3 顺带实机验证 spike 风险项：R1 限流事件 `llm/retry` 的 failure.code 取值、R3 并发活跃度、R4 沙箱继承、R5 子代理审批行为
- M4a：自研 client 面板（swarm 成员列表 + 状态/进度），host 半发事件、client 半渲染，真实会话目测验收
- M4b：**打包形态升级为 bundle**（package.json 声明 dsh.bundle.patch + 自带 cordis.patch.yml 挂载 agent-swarm 行），目标 = 侧边栏「插件」管理页可见、可启停、可卸载（用户明确要求：只读 inventory 可见不够）。验收：web `dsh --profile web --dump-config` exit 0 且 agent-swarm 恰好一行（bundle 层下）；headless 探针返 ITEMS_TOO_FEW 证明工具活；管理页条目可见待用户重启两端后目测（Electron 独占，代理不代重启）

## 参考项目
- M5（1.5 期）：`pnpm test` 全绿（validate 路由匹配 7 条 + plugin J 组 9 条 + registry routeLabel）；**实测待用户重启 DSH**：① 真实会话 `agent_swarm` 传 `model` 验证白名单服务在 host bundle 层可达、成员按所选路由派发（不可达时行为 = MODEL_SELECTION_UNAVAILABLE 明确报错，不误派）；② 面板分组折叠/滚轮/模型标签目测

- 机制依据：`extracted/kimi-code-swarm-analysis/01-机制文档/`（00/02/03/04 篇为主）
- 合法代码参考（MIT）：`extracted/kimi-code-swarm-analysis/03-v1源码/`、`04-协议层/v1-protocol-swarm-slices.mjs`
- DSH 侧契约：`@deepseek-ai/dsh-subagent`（ctx.subagents.start/startContinuable）、`@deepseek-ai/dsh-tool-subagent`（工具组合范例）、`@deepseek-ai/dsh-tools`（defineTool）