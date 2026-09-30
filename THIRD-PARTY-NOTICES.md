# 第三方代码与来源声明

本仓 `dsh-agent-swarm` 是对 Kimi Code 桌面版 `swarm`（AgentSwarm）功能的 **clean-room 适配**，
实现为 DeepSeek Harness 插件。本文件登记实现所依据的全部外部来源。

## 1. 是否包含第三方源码

**本仓未复制任何第三方源代码。** 所有 `src/**` 文件均为依据下述文档的**行为描述**重写。

- 未打开 `extracted/kimi-code-swarm-analysis/02-v2源码/`（对实现者封存）
- 未打开 `extracted/kimi-code-swarm-analysis/05-UI与API层/`
- 未打开 `extracted/kimi-code-swarm-analysis/03-v1源码/`（任务书允许，但本次实现未需要）
- 未复制 `05-提示词全文.md` 的任何提示词原文；面向模型的工具描述文本为**本仓自拟**
  （见 `src/index.ts` 的 `TOOL_DESCRIPTION`，英文、clean-room 重写，非任何上游原文）

因此本仓不产生"衍生作品"层面的署名义务。以下登记的是**依据来源**，用于溯源与审计。

## 2. 依据来源

| 来源 | 用途 | 许可 |
|---|---|---|
| `01-机制文档/02-并发调度与限流退避.md` | `src/scheduler.ts` 的节奏、退避、容量、死锁防护、取消语义 | 本仓自有分析文档 |
| `01-机制文档/03-工具入参与校验规则.md` | `src/validate.ts` 的五条硬校验、模板展开、编号语义 | 本仓自有分析文档 |
| `01-机制文档/04-结果渲染与resume机制.md` | `src/result-xml.ts` 的 summary/属性/body 规则、state 与 outcome 的正交语义 | 本仓自有分析文档 |
| `01-机制文档/13-已核实缺陷汇总.md` | D1（body 未转义）、D2（编号两套基）——本仓**刻意规避**的目标 | 本仓自有分析文档 |

上述文档自身引用并引述了上游源码片段。上游产品为 MIT 许可；
本仓未直接接触其源码文件，实现与上游代码不构成逐行对应关系。

## 3. 上游的 MIT 许可（供审计参考）

上游 Kimi Code 的 swarm 实现以 MIT 许可发布。若后续维护者决定**直接参考**
`03-v1源码/` 或 `04-协议层/v1-protocol-swarm-slices.mjs`，须：

1. 在被参考文件头部标注来源与许可；
2. 在本文件追加对应条目，附原始版权声明全文；
3. 重新评估 clean-room 边界是否仍然成立。

## 4. 刻意规避的上游缺陷

| 缺陷 | 上游表现 | 本仓做法 |
|---|---|---|
| **D1** body 未转义 | 子代理输出含 `<subagent` 字面量时，渲染器栈失配 → 该成员起**后续全部成员丢失**，与 summary 计数矛盾 | `result-xml.ts` 对**属性与 body 一并转义**（`escapeXmlText`），并补了 `body 含危险字面量仍能无损往返` 的测试 |
| **D2** 编号两套基 | 事件来源 1-based、快照来源 0-based，无补偿 → 成员 item 标签整体错位一位 | `renderSwarmResult` 渲染前断言 `spec.index === 位置 + 1`，不一致**抛错而非静默错位** |

## 5. 相对上游行为描述的有意偏离

均为**可测的收紧或补充**，不改变调度节奏本身：

1. **`onSuspended` 事件更完整**：额外携带 `retryCount` / `retryDelayMs` / `retryReadyAt`。
   上游只回传"已挂起"，宿主无从得知还要等多久。
2. **`state` 判定更严格**：`state` 由"是否真的启动过"（曾 markReady 或曾拿到 agentId）决定，
   而不是只看 agentId 是否存在。后者会把"建了对象但首个请求没发出去"误判为 `started`。
3. **时钟语义统一**：退避延迟、容量防抖、180s 容量恢复一律走注入的 `now()`。
   与注入时钟混用真实 `Date.now()` 会让时序无法确定性复现。
4. **`omitNotStarted` 渲染选项**：批次被中断时，队列里可能压着上百个从未启动的任务，
   可将其从结果块中剔除（`state === "not_started"`），但编号一致性断言仍在**过滤前**执行。
5. **无抖动的退避被保留**：上游显式 `randomize: false`（缺陷 D5，属设计取舍而非缺陷）。
   本仓照搬该确定性节奏，理由是它可测、可预测；跨会话 thundering herd 风险记入本仓已知风险，
   不在 M1 范围内解决。
6. **死锁防护放宽为「持续限流才放弃」**（M2 引入）：机制文档 §8.1 的条件只有 `isOnlyUnfinishedTask`，
   即上游在**首次**限流时就判 failed。本仓改为额外要求 `retryCount >= 1`
   （已退避重试过一次仍限流才放弃）。理由：限流高度瞬时，而子代理内部还会自行重试 5 次，
   首次即弃会把可恢复的抖动变成终态失败；死锁防护的本意（不无限等）依然成立。
7. **XML 完备性加固**（M2 引入）：文本节点额外转义 CDATA 终结符 `]]>`，
   并按 XML 1.0 §2.2 剥离非法控制字符（保留 `\t` `\n` `\r`）——控制符会让整份结果块无法被
   任何合规解析器读取，属于「整份文档报废」而非局部丢内容，故必须在写出前处理。
   属性区同样剥离控制符。代价：被剥离的字节不可还原（有损），换取文档仍可解析。

## 6. 交付现状与已知未覆盖项

### 已完成

- **M1 纯函数核心**：`types.ts` / `validate.ts` / `result-xml.ts` / `scheduler.ts`，零 DSH 依赖。
- **M2 插件集成层**：`index.ts`（具名导出 `name` / `inject` / `Config` / `apply`，无 `export default`）
  + `tests/plugin.test.ts`（mock Context 契约测试 + 真实 Loader 加载路径测试）。
  插件注册 `agent_swarm` 工具，执行链为 `validate → scheduler → renderSwarmResults → {xml}`。
  DSH 侧契约依据 `docs/spike-dsh-api.md`（对 `@deepseek-ai/*` 0.2.0-rc.2 的只读调研）。

### 已知未覆盖项

- **限流判定尚未实机验证**（阻塞项）。in-process（`spawn`）路径下子代理结果只有 `stopReason`，
  没有 `diagnostic` / `failure.code`（见 `spike-dsh-api.md` Q6），因此结果级无法区分 429 与普通错误。
  `index.ts` 中 `isRateLimitErrorPhaseOne` / `classifyRateLimitPhaseOne` 是**注入点**：
  当前恒返回 false（不猜、不误判），M3 实机确认 `llm/retry` 事件的 `failure.code` 后替换该实现即可，
  调度器无需改动。
- **`resume` 运行时分支**（二期 backlog，见 `docs/spec.md`）。
  `types.ts` 中以注释标出扩展点，`validate.ts` 的校验 1 一期无豁免路径。
- **成员可见性**：one-shot 子代理不进入官方智能体团队面板（`spike-dsh-api.md` Q10），
  一期以工具返回的 XML 作为成员状态的唯一来源；自研 client 面板属 M4。
- **子代理级路由**：`config.agentOptions` 已接线，但未开启 `modelSelectionSettings`，
  因此不会命中会话级模型白名单；实际生效路由需 M3 实机确认。
- **取消与失败未分档**：`SwarmOutcome` 只认 `completed` / `failed` / `aborted` 三档，
  单成员被取消时在 XML 中呈现为 `outcome="failed"` + `stop_reason="aborted"`。
