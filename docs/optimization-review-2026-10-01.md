# dsh-agent-swarm 优化审查报告（第三轮：代码质量 + 二期演进）

- **对象**：`ase-sketch/dsh-agent-swarm` @ `1e35e27`（v0.3.6）
- **性质**：审查阶段只读。执行进展见文末「执行记录」。
- **基线**：`pnpm test` 250/250 绿（7 文件）；`pnpm typecheck` exit 0。
- **证据来源**：本仓源码与文档。DSH 官方包 `@deepseek-ai/*@0.2.0-rc.2`（MIT）的构建产物以只读方式查阅，其中：
  - 随依赖安装：`dsh-subagent`、`dsh-tools`、`dsh-typert-protocol`、`cordis`；
  - 用 `npm pack` 获取：`dsh-subagent-fork-in-process`、`dsh-subagent-in-process-driver`、`dsh-llm-retry`、`dsh-tool-subagent`、`dsh-api-job-controller`。
- **clean-room**：全程未接触任何 Kimi 上游资料。凡是需要上游**行为语义**才能下结论的事项（fork 的对齐、模式状态机），都标明「需要 01-机制文档 的行为描述」，不做推测。
- **不重复上报**：上一轮已判定「不修」的条目不在本报告范围内，包括：容量恢复无上界、`SwarmHeaderAction` 结构拆分与 CSS 抽离、流自动重连、两层校验的报错归属、NOTICES §5 中的各条有意偏离。

## 一、问题清单

严重度口径：**高** = 契约或安全边界实际失效；**中** = 可观测的行为缺陷、资源问题，或文档结论不成立；**低** = 可读性与一致性。

### 高

**H1 子代理递归深度没有任何上限；工具描述里的 "capped at 1" 在代码层并不成立**

- `src/index.ts:365-371` 调用 `start()` 时，请求里没有 `maxDepth`。
- DSH 只在请求**带了** `maxDepth` 时才校验深度：见 `dsh-subagent/lib/index.js:400-404`（`resolveChildDepth`）和 `:3118`。服务配置里的默认值 1 只能通过 `resolveMaxDepth()`（`:2864-2869`）由工具自己取出再透传。官方 `dsh-tool-subagent/lib/index.js:508-519` 正是这样做的。
- 因此以下三处描述的边界都没有生效：`src/index.ts:185` 的工具描述、`docs/spec.md`「非目标」第 2 条、`tests/plugin.test.ts:246`（这条测试只断言了文案）。
- 后果：如果成员会话能看到 `agent_swarm`（**待实机验证**），成员就能再开 swarm，最坏情况是 128×128 扇出。

**H2 结构化错误的 code 和 details 到不了模型**

- `src/index.ts:234-243` 把 `swarmErrorCode` / `swarmErrorDetails` 挂在一个普通 `Error` 上。
- DSH 的 `toolErrorResult`（`dsh-tools/lib/index.js:3616-3629`）只把 `Error: ${message}` 交给模型；`info` 字段也只在 `HarnessError` 的情况下带 `{name, code}`（`:2612-2620`）。
- 结果是：
  - MODEL_AMBIGUOUS 不列出候选；
  - MODEL_NOT_ALLOWED 不列出白名单；
  - DUPLICATE_PROMPTS 的重复片段模型看不到；
  - 错误码本身也不在 message 里。

### 中

| # | 问题 | 证据 |
|---|---|---|
| M1 | spec 所说「resume 前置条件已补齐」不成立 | XML 里的 `agent_id` 是 one-shot run 的 id（`src/index.ts:381`）；而 DSH 对非 continuable 子代理一律抛 `NOT_RESUMABLE`（`dsh-subagent/lib/index.js:1917`）。continuable 方式还受 `maxActiveSubagents = 8` 的限制，满了直接拒绝（spike Q3） |
| M2 | 面板推流跨会话放大，且帧体积无上界 | `src/swarm-registry.ts:389-391` 订阅的是全局变化，而官方骨架按会话过滤（`dsh-api-job-controller/lib/index.js:181`）。帧里带有全部成员的完整 item 与 detail。实测：只改会话 B，会话 A 收到 21 帧；128 个 10KB 的 item 让单帧达到 1,287,779 字节 |
| M3 | registry 的会话表只增不减 | `src/swarm-registry.ts:191-201`。实测：1000 个会话之后 `sessionBatches.size` 仍为 1000 |
| M4 | Config 接受调度器必然拒绝的值 | `src/index.ts:72`、`:78` 使用 `natural()`，允许 0；调度器在构造期会抛错（`src/scheduler.ts:181-189`）。失败发生在 `beginBatch` 之后（`:663`→`:667`），面板因此留下一个空批次。另外 `retryFactor` 不接受 1.5 这样的小数 |
| M5 | 面板 i18n 只接了一半 | 字典已注册（`src/client/index.ts:92-123`），但组件的文案全部写死成中文（`SwarmHeaderAction.tsx:584/603/616/627/726` 等） |
| M6 | 并发批次在面板上只显示最新一个 | 工具声明了 `isConcurrencySafe`（`src/index.ts:784`），而推流只取最新批次（`src/swarm-registry.ts:331-345`、`:394`、`:432-452`） |
| M7 | 存在两个时长相同的超时计时器，且注释与代码相反 | `src/index.ts:359-363` 自建了 `AbortSignal.timeout`；调度器在 `src/scheduler.ts:565-572` 也会以同样时长 abort 同一个 attempt 信号。`src/index.ts:714-717` 的注释与实际行为相反。属于冗余加误导，不是现网缺陷 |

### 低

| # | 问题 | 证据 |
|---|---|---|
| L1 | NOTICES 写「未复制任何第三方源代码」，而源码注释自述「照抄 DSH 官方实现」 | `src/swarm-registry.ts:79-120` 与 `dsh-api-job-controller` 的 `lib/index.js:10-58` 结构逐行对应（MIT） |
| L2 | 工具描述只列了 5 道校验，缺少第六道 | `src/index.ts:173-178` |
| L3 | `runOneTask` 有 10 个位置参数和 6 处判空 | `src/index.ts:337-412` |
| L4 | 重复代码与死代码 | `validate.ts:63/108`、`scheduler.ts:43,50`、`remote.ts:35` |
| L5 | 注释与代码漂移 | `index.ts:2,10,760-766`、`scheduler.ts:143-146` |
| L6 | label 不截断；sessionId 兜底值会让多个会话串到一起 | `index.ts:699`、`:633` |
| L7 | 测试 harness 不可扩展；组件没有渲染测试 | `tests/plugin.test.ts:59-148`、`:501-606` |

**观察项（本轮不动）**：dist 在运行时 import 了三个 `@deepseek-ai` 包，但它们只列在 devDependencies 里。如果补成 peerDependencies，npm 7+ 会自动安装 peer 依赖，可能装出第二份宿主包。这一点只能在实机安装时判断，因此只登记、不改。

## 二、提案（按价值/风险排序）

### 方向 ① 代码质量

| # | 提案 | 价值/风险 | 红线 |
|---|---|---|---|
| P1 | 接上深度上限：透传 `resolveMaxDepth()`，并在开批次前预检（`DELEGATION_DEPTH_EXCEEDED`） | 高/低 | 不触碰 |
| P2 | 让错误对模型可见：code 与精简后的 details 渲染进 message | 高/低 | 不触碰 |
| P3 | 超时只保留一个来源（attempt.signal） | 中/低 | 不触碰 |
| P4 | 收紧 Config 校验，并在 apply 期 fail-fast | 中/低 | 不触碰 |
| P5 | 推流按会话唤醒、视图截断、全局限容 | 中/中 | 纯逻辑层仍零依赖 |
| P6 | 成员派发改为参数对象（随 index.ts 按职责拆分一起做） | 中/低 | 不触碰 |
| P7 | 扩展测试 harness | 中/低 | 不触碰 |
| P8 | NOTICES 补登 DSH（MIT）来源 | 中/低 | 符合红线精神 |
| P9 | 小清理，并开启 `noUnusedLocals` / `noUnusedParameters` | 低/低 | 不触碰 |
| P10 | 面板 i18n 接线 | 中/中 | 不触碰 |
| P11 | 渲染测试基建（新增 devDependencies） | 中/低 | 不触碰 |
| P12 | 让并发批次在面板上可见 | 低/中 | 不触碰 |

### 方向 ② 功能演进

- **E1 限流退避接线准备**：默认关闭，开关打开前对现网零行为变化。判定依据是子会话的 `llm/retry` 事件。
- **E2 fork**：映射到 DSH 原生的 `fork` provider（`dsh-subagent-fork-in-process`）。
- **E3 resume_agent_ids**：本轮只做 spike 与决策笔记。阻塞点见 M1。
- **E4 模式状态机**：延后。已列出可用的 DSH 原语；具体语义需要 01-机制文档 的行为描述。

## 执行记录（2026-10-01，分支 `optimize/round3`，每个提案一笔提交）

| 提案 | 处置 | 提交 |
|---|---|---|
| 重构（含 P6） | `index.ts` 822 行按职责拆成 batch-plan / batch-run / config / tool-spec / swarm-error，`runOneTask` 改成参数对象，行为零变化（21 个场景的行为快照逐字节一致） | `4a5e9f7` |
| P9 小清理 | 合并重复的判型函数；删除未用导入和死方法；开启 `noUnusedLocals` / `noUnusedParameters`；label 截断；工具描述补上第六道校验；`validateSchedulerConfig` 抽出为导出函数并补上 NaN 漏网 | `7029313` |
| P7 测试 harness | 支持 runFactory 与 subagents 桩，三处手搭 ctx 的测试迁回 harness | `7d291e8` |
| P3 超时单一来源 | 删除重复的 `AbortSignal.timeout`；新增护栏测试，确认不再调用 `AbortSignal.timeout` / `AbortSignal.any` | `f8565a1` |
| P4 配置校验 | firstWave / retryFactor 在加载期就拒绝 < 1 的值；apply 在产生任何副作用之前 fail-fast | `6e15f25` |
| P2 错误对模型可见 | message 渲染为 `[CODE] … Details: {json}`；所有回显的模型文本都做截断 | `55d2def` |
| （附带）typecheck 不再依赖 dist | dist 改为运行期 URL 导入；干净检出（尚无 dist）时 typecheck 也能通过 | `708fcf4` |
| P1 深度上限 | 透传 `resolveMaxDepth()`，并在开批次前预检（`DELEGATION_DEPTH_EXCEEDED`）；进程外 provider 不受影响、不回归 | `86e353d` |
| P5 + P12 推流与并发批次 | 按会话唤醒、只发增量、截断视图、限制容量；并发批次同时可见（visibleSwarmIds），客户端可切换 | `0dad9c3` |
| P8 NOTICES | 补登 DSH（MIT）来源，修正原先过于绝对的表述 | `676a7fa` |
| E1 限流接线 | 默认关闭；监听 `session/event`，以 `turn/end` 的最终失败码判定是否限流；判定为限流时抛出品牌错误，交给调度器做退避 | `ba77db8` |
| E3 resume | 只做文档：修正「前置条件已补齐」的结论，三条路线记入 proposed 笔记 | `ba77db8` |
| P10 + P11 i18n 与渲染测试 | 组件改用框架注入的 `t`（与官方 jobs 面板同一机制）；新增 jsdom 与 Testing Library，补 7 条渲染测试 | `780ac87` |
| E2 fork | `context: "fork"` 走 DSH 原生 fork provider；与 `model` 互斥；单独设上限（默认 16） | `b1978e4` |
| E4 模式状态机 | 延后，DSH 可用原语记入 proposed 笔记 | `b1978e4` |
| 独立审查修复（registry） | 消费方持帧期间的变化会丢失（高，本轮引入的回归）；按会话唤醒的用例原先不起守护作用；description 截断；收尾之后再重算批次状态 | `793daae` |
| 独立审查修复（限流） | dispose 期间被中断的限流成员补落 aborted（中）；重试码只认收场那一轮；补三处护栏 | `16b4e40` |
| 版本 | 0.3.6 → 0.4.0 | 最后一笔 |

**验证**
- D: 盘是 exFAT，用 hoisted 布局运行：`pnpm test` 从 250 条增至 327 条（7 个文件增至 10 个），`pnpm typecheck` 结果为 0。
- 在 NTFS 上全新 clone 本分支，按 pnpm 默认隔离布局执行 frozen install：
  - 移走 dist 后 typecheck 结果为 0；
  - 测试全部通过（独立审查修复前为 319 条，修复后为 327 条）；
  - `npm pack --dry-run` 共 46 个文件，`dist/client.js` 里不含测试依赖，也不含 host registry 代码。

**未做与不做**
- E1b「在途背压」：需要给调度器新增入口，收益依赖实机 429 的分布。
- 重罚档位映射（first-request-blocked）：需要上游对 ready 的定义。
- E3 / E4 的运行时实现。
- peerDependencies 观察项：npm 7+ 会自动安装 peer 依赖，有装出第二份宿主包的风险，需实机评估。
- L6 的 sessionId 兜底值：复核后结论是没有可见影响（面板按真实会话 id 订阅，兜底桶永远不会被显示），不改。

**待实机验证（汇总）**
1. 成员会话是否能看到 `agent_swarm`；用户 profile 中 maxDepth 的取值（P1）。
2. 限流接线开启前需要确认四点（E1）：
   - 实际的失败码取值；
   - 插件级 `session/event` 能否收到子会话的事件；
   - 子会话 id 是否等于 `run.id`；
   - maxRetries 取多少合适。
3. 真实客户端是否注入 `t`，以及切换语言的效果；多批次标签的观感（P10 / P12）。
4. fork provider 是否已挂载及其 providerName；并行 fork 的成本（E2）。

**独立审查**（fresh subagent，只读、脚本复现；父代理逐条回读源码复核后才改动）：7 条发现全部处置。其中 1 条高是本轮引入的推流丢更新回归；
1 条（中断时 batch.status 早于成员落定）属既有问题，一并以「收尾后重算」修复。所有新增护栏用例均做过变异验证（撤回修复即变红）。

**行为快照对比（基线 → 最终）**：9 个执行场景的 XML 逐字节一致；12 个校验/路由错误场景的错误码全部不变、仅 message 增加 `[CODE]` 与 Details；
start 请求仅 label 变化：item 部分折叠空白并截断到 80 码元（`MEMBER_LABEL_ITEM_MAX_CHARS`，截断点不劈开代理对）——
快照场景的 item 都短于 80，所以快照里只体现为折叠空白（PR #1 评审第 2 条订正：原句只写了折叠空白，漏了截断）；
工具描述与参数为有意的文案变更（第六道校验、深度上限、fork、context 参数）。

**PR #1 第一轮评审（维护者）**：两条均已修复——
① [中] 多处 `.slice()` 截断可劈开 UTF-16 代理对、Details JSON 截断可切碎转义序列 → 新增纯函数 `src/text-clip.ts` 作为全仓唯一截断出口，
四处使用点（swarm-error / validate / batch-run label / swarm-registry 视图）全部改用，另补面板 agentId 一处（`edf3fb3`，测试 327 → 338）；
② [低] 本节上一段的口径订正（本笔）。
