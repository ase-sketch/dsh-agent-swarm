# 第三方代码与来源声明

本仓 `dsh-agent-swarm` 是对 Kimi Code 桌面版 `swarm`（AgentSwarm）功能的 **clean-room 适配**，
实现为 DeepSeek Harness 插件。本文件登记实现所依据的全部外部来源。

## 1. 是否包含第三方源码

**本仓未复制任何 Kimi 上游源代码。** 所有 `src/**` 文件中与 swarm 功能相关的实现，均依据下述文档的**行为描述**重写。

唯一的例外不来自 Kimi，而是宿主平台：`src/swarm-registry.ts` 中的 `OutputWaiter` / `sleepWithSignal`
与 DSH 官方包 `@deepseek-ai/dsh-api-job-controller`（MIT）的推流骨架结构逐行对应。来源与许可原文见 **§8**。
（2026-10-01 第三轮订正：此前本节写的是「未复制任何第三方源代码」，与该文件自述的"照抄 DSH 官方实现"相矛盾。）

- 未打开 `extracted/kimi-code-swarm-analysis/02-v2源码/`（对实现者封存）
- 未打开 `extracted/kimi-code-swarm-analysis/05-UI与API层/`
- 未打开 `extracted/kimi-code-swarm-analysis/03-v1源码/`（任务书允许，但本次实现未需要）
- 未复制 `05-提示词全文.md` 的任何提示词原文；面向模型的工具描述文本为**本仓自拟**
  （见 `src/tool-spec.ts` 的 `buildToolDescription` / `buildToolParameters`，英文、clean-room 重写，非任何上游原文）

**可复核的核对方法（2026-10-01 审查后补）**：上述"未复制"不该只靠自证，可按下列方法复核——

1. 工具描述：与白名单文档全文比对，无连续 6 词以上重合（`src/tool-spec.ts` 的 `buildToolDescription`）；
2. 错误文案与常量：2026-10-01 审查曾发现**三条与上游逐字相同**的文本
   （`src/validate.ts` 两条、`src/scheduler.ts` 一条），已于 v0.3.3 全部改写为本仓自拟，
   现全仓 grep 三条原文为 **0 命中**，与上游最长连续重合 2 词（`rate limit`）；
3. 边界提醒见 §3——白名单文档内嵌上游源码片段，"只依据行为描述"不等于零接触。

因此本仓不产生"衍生作品"层面的署名义务。以下登记的是**依据来源**，用于溯源与审计。

## 2. 依据来源

| 来源 | 用途 | 许可 |
|---|---|---|
| `01-机制文档/02-并发调度与限流退避.md` | `src/scheduler.ts` 的节奏、退避、容量、死锁防护、取消语义 | 本仓自有分析文档 |
| `01-机制文档/03-工具入参与校验规则.md` | `src/validate.ts` 的硬校验（机制文档五条 + 本仓新增元素级一条）、模板展开、编号语义 | 本仓自有分析文档 |
| `01-机制文档/02、03、04` | `src/types.ts` 的类型契约（任务规格、结果、调度器配置、错误码） | 本仓自有分析文档 |
| `01-机制文档/04-结果渲染与resume机制.md` | `src/result-xml.ts` 的 summary/属性/body 规则、state 与 outcome 的正交语义 | 本仓自有分析文档 |
| `01-机制文档/13-已核实缺陷汇总.md` | D1（body 未转义）、D2（编号两套基）——本仓**刻意规避**的目标 | 本仓自有分析文档 |

上述文档自身引用并引述了上游源码片段（边界说明见 §3 第 4 条）。上游各组成部分的许可状态并不均一，核查结论见 §3。

关于"是否构成衍生关系"，本文件只陈述**可复核的事实**，不做超出证据的断言：
本仓源码中未发现从 `03-v1源码/` 复制而来的源文件；但部分模块（例如调度器的限流状态机）
与上游实现**结构高度对应**——这是**预期之内**的：规格要求按机制文档的行为描述保真重写，
而该文档内嵌了上游实现片段。因此**溯源不可判定**：证据既不足以断言"从未接触"，
也不足以断言"照搬源码"。需要收紧对外姿态时，按 §3 的补归属流程处理。

## 3. 上游的许可状态（供审计参考）

上游许可状态并不均一（依据逆向分析资料 extracted/kimi-code-swarm-analysis/THIRD-PARTY-NOTICES.md 的核查结论）：

- 公开仓库 MoonshotAI/kimi-code 为 MIT 许可，但经核验存在于其中的仅为外围模块（packages/transcript、packages/kap-server 协议层等），**swarm 功能本体未见于该公开仓库**；
- npm 分发包 @moonshot-ai/agent-core / @moonshot-ai/protocol 的 package.json 自述 MIT，但两包均未在公开 registry 发布，**无法公开二次核验**；
- 桌面版打包产物（kimi-code-app 的 app.asar）**未附带任何许可**，默认保留全部权利。

此外，Kimi 服务条款含有禁止逆向工程的约定——MIT 是版权许可，不构成对服务条款的豁免；引用上游文本前请自行评估。

若后续维护者决定**直接参考**
`03-v1源码/` 或 `04-协议层/v1-protocol-swarm-slices.mjs`，须：

1. 在被参考文件头部标注来源与许可；
2. 在本文件追加对应条目，附原始版权声明全文；
3. 重新评估 clean-room 边界是否仍然成立；
4. **注意（2026-10-01 审查发现）**：白名单里的 `01-机制文档/` **内嵌上游实现片段**——例如
   `02-并发调度与限流退避.md` 直接给出 `enterRateLimitMode` / `shrinkRateLimitCapacity` 等方法体，
   `00-总体架构.md` 给出错误文案与 XML 样例原文。因此"只依据行为描述"在实践中**不等于零接触上游文本**。
   判断某段实现是否要按上述三条补归属时，标准是"是否与上游源码逐字/逐行对应"，而不是"读的是哪份文档"。

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
8. **新增元素级校验（第六道硬校验，2026-10-01 审查后补）**：上游用 schema（`array(string().trim().min(1))`）
   在入口拒绝空 item；本仓在 `validate` 内复刻该约束并返回结构化错误（`ITEM_EMPTY` / `ITEM_NOT_STRING`），
   这比让 `TypeError` 冒出去更可诊断，也能把"第几条错了"直接回给模型。
9. **`<summary>` 新增 `unknown: N` 桶**（2026-10-01 P2 批次引入）：上游把汇总写成
   `if completed / else if failed / else aborted`，于是任何非前两类的成员都被算成 aborted。
   本仓改为穷尽匹配——未知 outcome 单列 `unknown`，不再冒充 aborted（正常三值路径的汇总文本不变）；
   且 `renderSwarmSummary` 的 `default` 分支以 `const unhandled: never` 做**编译期**守卫，
   将来给 `SwarmOutcome` 扩值时编译会失败，逼作者显式决定该值归哪一桶。

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
  （2026-10-01 复核：单成员 `stopReason=aborted` 时 registry 侧落 aborted、XML 侧落 failed，
  两者的差异就是本条描述的"未分档"，本轮未改动。）

## 7. 2026-10-01 代码质量审查后的修正

审查报告 `docs/code-quality-review-2026-10-01.md`（含复核记录、被剔除的告警、未修项及理由）。与本文件相关的修正：

1. **三条上游逐字文本改写**（见 §1 方法 2）：`src/validate.ts` 两条错误文案、`src/scheduler.ts` 的 `RATE_LIMIT_SUSPENDED_REASON`；
2. **补登 `src/types.ts`**（§2 表）；
3. **结果块补回 `agent_id`**（`src/result-xml.ts`）：此前该属性被丢弃，而二期 `resume_agent_ids` 要靠它取值；
4. **属性值改用字符引用**（同文件）：`\r` / `\n` / `\t` 写成 `&#xD;` / `&#xA;` / `&#x9;`，
   否则任何合规解析器都会按 XML 1.0 §3.3.3 把它们规范化成空格（静默失真，比抛错更难发现）；
5. **测试链改为先构建**：`pnpm test` 前置 `pnpm run build`；Loader 测试改为加载真实 `dist/index.js`，
   并新增守护 AGENTS.md 红线「绝不写 export default」的用例（此前该红线实际无人守护）；
6. **中断语义一致**：批次中断后 registry 与 XML 同为 aborted（此前未启动成员会永久停在 pending、批次被推导成 failed）；
7. **限流能力状态回写**：`docs/spec.md` 新增「交付状态」，明确限流退避在交付态无触发路径及其启用前置条件。

## 8. DSH 宿主平台（MIT）来源

本节登记的是**宿主平台 DeepSeek Harness** 的开源代码，与 Kimi 上游无关，不涉及 clean-room 边界。
DSH 官方包以 MIT 许可在 npm 公开发布，引用版本均为 `0.2.0-rc.2`。

| 本仓位置 | 来源 | 关系 |
|---|---|---|
| `src/swarm-registry.ts` 的 `OutputWaiter`、`sleepWithSignal` | `@deepseek-ai/dsh-api-job-controller` `lib/index.js`（`OutputWaiter`、`sleep`） | 结构逐行对应：「有变化就 wake、合窗后重发」的推流骨架 |
| `src/swarm-registry.ts` 的按会话唤醒（`framesFor` 的 sessionId 过滤） | 同上，`streamJobRows` | 只对齐行为（只有本会话的变化才唤醒），代码为本仓自写 |
| `src/batch-plan.ts` 的 `delegationDepthOfParent` | `@deepseek-ai/dsh-subagent` 的 `delegationDepthOf` | 只对齐口径（会话头与运行期选项取较大者），代码为本仓自写，且刻意宽松 |
| `src/batch-plan.ts` 的 `resolveMemberMaxDepth` | `@deepseek-ai/dsh-tool-subagent` 的 `maxDepth` 透传方式 | 只对齐 API 用法（`resolveMaxDepth` 与 `"provider-managed"` 语义），代码为本仓自写 |

`@deepseek-ai/dsh-api-job-controller` 的许可原文：

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
