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

## 执行记录

（见下文，按提交逐条回写）
