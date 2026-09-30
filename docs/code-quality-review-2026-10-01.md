# dsh-agent-swarm 代码质量审查报告

- **审查对象**：`E:\kimi-code-swarm-analysis\dsh-agent-swarm`（v0.3.2，DSH host 插件 + 同包 client 半）
- **审查日期**：2026-10-01 ｜ **审查范围**：`src/**`（12 文件）、`tests/**`（7 文件）、`scripts/`、根配置与打包字段、`ARCHITECTURE.md`/`AGENTS.md`/`THIRD-PARTY-NOTICES.md`/`docs/**`、`.agents/notes/**`
- **产出性质**：**只读审查**。本次未修改、新增、删除项目内任何代码文件（本报告自身除外）。
- **方法**：6 路并行子代理分模块审查（调度器 / 宿主集成 / 纯函数层 / client+打包+文档 / clean-room 合规 / 静态卫生），父代理对**每一条 P1 及以上结论**逐条回读源码复核，并**降级/剔除**了 6 条经不起复核的告警（见第八节）。含实机核验（`dsh --profile web --dump-config`、profile 安装副本比对）。

---

## 一、结论速览

**水位：可用、分层清晰、可维护性中上；但有 3 处「声明与交付之间」的结构性裂缝，其中 1 处会让一整块已声明能力静默失效。**

- **无 P0**：核心流程（模型调 `agent_swarm` → 校验 → 并发派发 → XML 汇总）在交付态可用，137 条测试全绿、typecheck clean、三个 profile 的安装副本与工作区逐字节一致。
- **9 条 P1**，其中前 3 条最值钱：
  1. **P1-1 限流子系统整条在交付态不可达**（恒假判定），而注释声称它「照常工作」——波及调度器退避、registry 的 `retrying` 相位、面板退避徽标与倒计时。
  2. **P1-2 中断时未启动成员在面板侧永久卡 pending、批次被判 failed**，与 XML 的正确结论（aborted）**互相矛盾**。
  3. **P1-3 XML 属性值未做字符引用转义** → 任何合规解析器都会把 item 里的换行/制表符规范化成空格；而现有测试用的是**手写正则读取器**，结构上看不见这类缺陷。
- 另有 **4 组系统性发现**（跨模块才看得见）：测试与交付物之间的缝隙、文档-实现漂移链、clean-room 边界的实践漏洞、工程基建缺口。

---

## 二、交付态核验（父代理亲自实测）

| 核验项 | 命令/方法 | 结果 | 判定 |
|---|---|---|---|
| 测试基线 | `pnpm test` | 7 文件 137 条全绿，1.66s | ✅ 绿，但见 P1-6（绿的含义有限） |
| 类型基线 | `pnpm typecheck` | clean | ✅ 绿 |
| 类型严格度 | 读 `tsconfig.json` | `strict`+`noUncheckedIndexedAccess`+`verbatimModuleSyntax`，**无 `noUnusedLocals`** | ⚠️ 未使用项结构上抓不到 |
| 构建产物新鲜度 | src/dist 最新 mtime 对比 | dist(23:48) 新于 src(23:47)，26 个产物 | ✅ 不陈旧 |
| 部署一致性 | 三个 profile 安装副本 vs 工作区 dist 逐文件哈希 | desktop/headless/web 均 v0.3.2，**dist 逐字节一致** | ✅ 无漂移 |
| 挂载正确性 | `dsh --profile web --dump-config` | exit 0；`agent-swarm` 恰 1 行；无 bundle 被 skip | ✅ 与 spec 声称一致 |
| 版本控制 | `Test-Path .git`（项目与上级） | **均为 False**；无 `.gitignore`/`.npmignore` | ❌ 见 P1-9 |
| 仓库卫生 | 根目录清单 | 6 个历史 `.tgz`、77MB `node_modules` 裸放 | ⚠️ 见 P1-9 |

---

## 三、系统性发现（单模块审查看不见的，本报告的核心增量）

### S1 一个恒假判定，关掉了整条限流子系统

`src/scheduler.ts:403` 是「限流结局」的**唯一**产出点，门在 `deps.isRateLimitError(error)`；生产装配的 `isRateLimitErrorPhaseOne`（`src/index.ts:164-166`）**恒返回 false**。顺链下推即得：

- `#requeueRateLimited`（唯一调用点 `scheduler.ts:491`，仅在非 settled 结局触发）→ 不可达
- `#enterRateLimitMode`（唯一调用点 `scheduler.ts:540`）→ 不可达 → `#rateLimitMode` 永为 false
- ⇒ `#scheduleRateLimitLaunch`、容量收缩/180s 恢复、指数退避、`retryCount` 递增、`RATE_LIMIT_SUSPENDED_REASON`、`onSuspended` 全部为**死代码**
- ⇒ 连带：`registry.markSuspended` 在 src 内**唯一调用者**是 `index.ts:422`（同一死路径）→ `swarm-registry.ts:245` 的 `retrying` 相位、`:327` 的活跃相位判定、`SwarmHeaderAction.tsx:273` 的「限流退避」徽标、`:441-449` 的重试倒计时**同为死路径**

**最扎眼的一处**：`src/index.ts:156-158` 注释写「调度器的『时间与存活率』反压（容量收缩/恢复/退避）仍然照常工作，只是不由错误码触发」——**这句与代码事实相反**，这些机制的唯一入口正是那条被恒假封死的判定。

**公平地说**：`THIRD-PARTY-NOTICES.md` §6「已知未覆盖项」**已披露**该注入点恒返回 false（列为阻塞项）；未披露的是「注释声称仍工作」这半句，以及 `docs/spec.md` 功能清单第 3 条仍把限流退避写作一期已交付能力。所以定性是**未收敛且未回写**，不是隐瞒。

**连带影响（决定后续分级）**：所有限流类缺陷（含子代理报出的两条 P0）在交付态都**不可达**，因此按潜在缺陷处理。

### S2 测试与交付物之间的缝隙

三处互补的证据指向同一件事——**绿灯的覆盖面与实际交付物错位**：

1. `tests/client.test.ts:113` 读盘 `dist/client.js` 再 `eval`；而 `package.json` 的 `test` 是裸 `vitest run`（不前置 build）→ 干净检出（无 `dist/`）会 ENOENT 直接挂；改了 `src/client/**` 不重建则**测的是旧产物**。
2. `tests/plugin.test.ts:711` 加载的是 `../src/index.js`（源码），且 `:664-671` 的 import seam **手写**了一个只含 `name/inject/Config/apply` 的命名空间 → Loader 的 `unwrapExports` 被绕过，决策笔记 `2026-09-30-cordis-loader-testing.md` 声称的「能抓住 default export」在测试实现层面**不成立**。
3. 于是生产真正加载的入口 `dist/index.js`（`package.json: main`）**没有任何测试端到端验证过**。

### S3 文档-实现漂移链

`ARCHITECTURE.md:7-22` 的模块边界只列 5 个源文件与一条依赖链，而真实代码有 12 个源文件（含 `swarm-registry.ts`、`remote.ts`、`remote-descriptor.ts`、`client/**` 4 个）。这不是文字疏漏：项目自己的收口门禁第 2 条就是「对照 ARCHITECTURE.md 审查模块边界没被突破」——参照物失真，门禁即失效。同一漂移还出现在 `spec.md`（功能清单 vs 交付态）与两处文件头注释（见 P1-4/P1-8）。

### S4 clean-room 边界的实践漏洞

项目红线是「实现只依据 `01-机制文档` 的行为描述 + MIT 的 `03-v1源码`/`04-协议层`」。本次取证发现：**`01-机制文档` 内嵌了上游实现原文**（`02-并发调度与限流退避.md:314` = `this.rateLimitCapacity = Math.max(1, this.startedSuccessCount);`，与 `03-v1源码/v1-SubagentBatch-2.js:63` 一致；`:20` 直接给出 `RATE_LIMIT_SUSPENDED_REASON` 全文）。

结论有两层：
- **不构成越界证据**：与 v1 结构/文本的高度一致，可以完全由「照白名单文档实现」解释——所以子代理 E 提出的「照搬禁源、虚假陈述」**不成立**。
- **但边界在实践上不成立**：「只看行为描述」的前提是文档不含源码，而它含源码。这对未来的对外审计与取证是实质性弱点，也解释了为什么「重写」会与上游高度同构。

---

## 四、分级发现清单

分级口径：**P0** = 核心流程不可用必修；**P1** = 本期应修（含"声明与交付不符"这类结构性问题）；**P2** = 可后置的可维护性/健壮性。**本次无 P0。**

### P1-1 限流子系统在交付态不可达，且注释与代码矛盾 ｜ 波及 4 处模块

- 位置：`src/index.ts:164-166`、`src/index.ts:156-158`、`src/scheduler.ts:403/491/540`、`src/swarm-registry.ts:245/327`、`src/client/SwarmHeaderAction.tsx:273/441-449`
- 证据：见 S1（每条链均经父代理回读源码确认）
- 修复方向二选一：① 接入子会话 `llm/retry` 事件（`failure.code === "RATE_LIMIT"`）替换 `isRateLimitErrorPhaseOne`，让既有机制真正生效；② 若本期不接入，则把 `spec.md` 功能清单 3 回写为「未交付」、删掉 `index.ts:156-158` 的错误注释、并对面板 `retrying` UI 明确标注未启用
- 置信度：确认

### P1-2 中断时未启动成员在 registry 永久卡 pending，批次状态误判 failed（与 XML 结论矛盾）

- 位置：`src/scheduler.ts:589-609`（`#abandonSuspended` 对 `agentId === undefined` 直接 `continue`）、`src/index.ts:430-433`、`src/swarm-registry.ts:288-294`
- 证据：`endBatch` 的推导在「无人 completed、无人 aborted、无人 failed」时落进 `else → batch.status = "failed"`；而 `#finishWithAbort`（`scheduler.ts:619-622`）填的**调度器结果**是 aborted → XML 正确、面板错。子代理实测输出：`SCHEDULER_RESULTS: [{"outcome":"aborted"}...], BATCH_STATUS: failed, MEMBER_1_PHASE: pending`
- 影响：用户在批次早期中断（生产可达，Esc 即可），工具返回的 XML 是 aborted，但会话面板把该批次标成 failed、未启动成员永远转圈
- 修复方向：`#abandonSuspended` 不再跳过未启动成员（或 `endBatch` 对未终态成员按中断原因归位），并补一条「派发前中断」的 registry 相态测试
- 置信度：确认

### P1-3 XML 属性值未做字符引用转义 → 合规解析器规范化会吃掉换行/制表符

- 位置：`src/result-xml.ts:58-64`（只转 `& " < >`）
- 证据：XML 1.0 §3.3.3 规定属性值规范化：属性里**字面**的 `\r`/`\n`/`\t` 一律被替换为空格。构造 `item: "a\r\nb\tc"` 渲染为 `<subagent item="a\r\nb\tc" ...>`，经标准解析器读回的 item 是 `"a b c"`。项目自身测试的读取器（`tests/result-xml.test.ts:28-43`）是手写正则 `([a-z_]+)="([^"]*)"` + `unescapeXmlAttribute`，**不执行规范化** → 该缺陷在测试体系里结构性不可见
- 影响：任何用标准 XML 工具消费结果的人（审计、脚本、别的模型工具链）读到被静默改写的 item；多行 item 场景必现
- 修复方向：`escapeXmlAttribute` 补 `\r → &#xD;`、`\n → &#xA;`、`\t → &#x9;`（三行），并把往返测试改用真实 XML 解析器（Node 侧可用 `DOMParser`/`fast-xml-parser`）或至少断言规范化行为
- 置信度：确认

### P1-4 空白/空 item 被静默放行（违反白名单文档的 `min(1)` 契约）

- 位置：`src/validate.ts:63`（`items.map(item => item.trim())` 后不校验长度）
- 证据：白名单文档 `01-机制文档/03-工具入参与校验规则.md:37` 明确写着 `array(string().trim().min(1)).max(128)`；实测 `validateSwarmInput({items:["   ","b"], promptTemplate:"do {{item}}"})` 返回 `ok: true`，产出 `item: ""`、`prompt: "do "`，并真去派发一个空实体子代理；两个全空白 item 还会得到误导性的 `DUPLICATE_PROMPTS`
- 附带：`items: [123]` 这类非 string 元素会在 `:63` 直接抛 `TypeError`，破坏「统一返回结构化错误」的契约（上游 `require_coerce` 是有强转语义的）
- 修复方向：trim 后长度为 0 即返回专属失败（如 `ITEM_EMPTY`，带位置）；非 string 走同一条失败路径
- 置信度：确认

### P1-5 XML 结果丢弃 `agent_id`（格式偏离 + 堵死二期续跑）

- 位置：`src/result-xml.ts:150-158`（属性只有 `item`/`state`/`outcome`/`stop_reason`）
- 证据：白名单文档 `01-机制文档/00-总体架构.md:264-265` 的标准输出形如 `<subagent agent_id="xxx" item="…" state="…" outcome="…">`，同文件 `:263` 的 `<resume_hint>` 明确要求「用结果里的 agent_id 值调用 resume_agent_ids 续跑未完成工作」；`types.ts:43` 与调度器都已持有 `agentId`
- 影响：结果块与运行链路脱节；二期 `resume_agent_ids`（`docs/spec.md` 二期清单）**没有可用取值来源**。且该偏离**未**登记在 `THIRD-PARTY-NOTICES.md` §5「有意偏离」表中
- 修复方向：`renderSubagentElement` 补 `agent_id`（有则输出）；若决定不输出，就地登记为有意偏离
- 置信度：确认

### P1-6 测试与交付物之间的缝隙三连

- 位置：`tests/client.test.ts:113`、`package.json:14`、`tests/plugin.test.ts:664-671/711`
- 证据与影响：见 S2。要点：client 测试依赖未受控的磁盘产物；host 侧 Loader 测试绕过 `unwrapExports`，「红线有测试守护」名不副实；`dist/index.js` 无人验证
- 修复方向：`test` 脚本前置 `pnpm run build`（或测试内用 esbuild 内存构建）；Loader seam 指向真实 `dist/index.js` 的命名空间；把「无 default export」改成对源码 AST/导出表的直接断言
- 置信度：确认

### P1-7 `ARCHITECTURE.md` 模块边界已过期

- 位置：`ARCHITECTURE.md:7-22`
- 证据：文档列 5 个源文件；实际 12 个（缺 `swarm-registry.ts`、`remote.ts`、`remote-descriptor.ts`、`client/{index,model,service,SwarmHeaderAction}`），依赖方向行也未含 `index → remote → swarm-registry` 与 client 侧链路。M4a（2026-10-01）合入后未回写
- 修复方向：补齐模块树、依赖方向、client/host 双半数据流与 `build-client` 构建链
- 置信度：确认

### P1-8 第三方登记与文件头自述的合规缺口

- 位置：`THIRD-PARTY-NOTICES.md:8-16/20-26`、`src/validate.ts:5`、`src/types.ts:4-6`
- 证据（均为父代理亲验）：
  - `types.ts:4` 有来源标注，但 NOTICES §2 登记表**无 `types.ts` 条目**（`scheduler/validate/result-xml` 有）→ 双向核验不闭环
  - 分发物内含**上游逐字文本** 3 条：`validate.ts:89`、`:95`、`scheduler.ts:44`；它们同样逐字出现在白名单文档（`00-总体架构.md:234/236/308`、`03-工具入参与校验规则.md:254/300/301`、`02-…退避.md:20`）→ **溯源不可判定**，但 NOTICES「未复制任何第三方源代码」这一绝对化断言与「未打开 03-v1源码」的自证**无法被外部审计**，对「公开分发」这个硬约束是实质弱点
  - `validate.ts:5` 写「错误文案为本仓自拟」，而其中两条逐字来自白名单文档引述的上游原文 → 自述不准
- 修复方向（两条路线择一，见第九节）：**路线 A** 改写这 3 条文案 + 修正两处文件头措辞（改动 <10 行，改完 clean-room 声明即自洽）；**路线 B** 保留文案但在 NOTICES 补齐上游 MIT 版权行/许可全文/包名，并补登 `types.ts`
- 置信度：确认

### P1-9 工程基建缺口

- 位置：仓库根（无 `.git`、无 `.gitignore`）、`src/result-xml.ts:34`（`eslint-disable` 指令而全仓无 eslint 配置）
- 证据：`Test-Path .git` 在项目与上级目录均为 False；根目录 6 个历史 `.tgz`；无 lint 脚本/配置，却存在 `// eslint-disable-next-line no-control-regex`
- 影响：与用户全局纪律「动手前 `git status --short` 保护工作区」直接冲突——本仓任何改动都**没有回滚兜底**（本次审查全程只读，也正是这个原因）
- 修复方向：`git init` + `.gitignore`（`node_modules/`、`dist/`、`*.tgz`）→ 首提交；清理旧 tgz；要么补 eslint 配置，要么删掉失效指令
- 置信度：确认

### P2 清单（分组，可按需展开）

**A. 调度器潜在缺陷（4 条，全部因 S1 而不可达）**
- 并发闸门与容量恢复互锁：`maxConcurrency` 有值时，满并发会让唤醒时刻 `≤ now` 而**不装定时器**（`scheduler.ts:269-280` + `:290`）。**生产不可达**：`maxConcurrency` 既不在 `index.ts` 的 Config schema 里，也未在 `:448-459` 传入（grep 全仓仅 scheduler/types 出现）。子代理"推进 4,500,000ms 仍停摆"的复现有效，但前提是生产永远不会提供的配置
- 注入回调抛错 → 未处理 rejection + 不再装定时器：`scheduler.ts:367-374` 的 `.then(onOk, onErr)` 内 `#handleAttemptOutcome` 抛错会逃逸，且 `:493` 的 `#schedule()` 被跳过。**今日不可达**：`registry.markSuspended`/`markSettled` 对未知 batch/member 一律静默 return（`swarm-registry.ts:240-243/261-264`），`notify()` 又对 listener 有 try/catch（`:138-145`）。属健壮性缺口：宿主回调一旦会抛，整批静默挂起
- 容量恢复无上界、限流模式无退出路径（`scheduler.ts:346-351` 只 `+1`、无 ceiling、不校验 `lastRateLimitAt` 新鲜度；全文件无 `#rateLimitMode = false` 路径）。实测容量 1→15。属死代码内的设计缺口
- 构造期校验漏项：`maxConcurrency: 0` → `active(0) >= 0` 恒真 → 静默不返回（而非契约声称的「只有非法 config 会 reject」）；`run()` 可重复调用会覆盖 `#resolve`，让首个 Promise 永挂

**B. 一致性 / 可维护性**
- `128`/`2` 在 `index.ts:130/134/329` 写成字面量，绕过 `SWARM_MAX_SUBAGENTS`/`SWARM_MIN_ITEMS`；`maxItems` 调低时描述与校验冲突（B 的 P2，成立）
- `index.ts:74` `taskTimeoutMs` 默认 `7_200_000` 脱离 `DEFAULT_SWARM_SCHEDULER_CONFIG`（该结构 `types.ts:111-118` 无 `timeoutMs` 字段）
- `index.ts:290` 与 `:431` 两处独立的三态映射（registry 新增相位时会漏改一处）
- `remote.ts:35` `setRegistry` 为**死代码**（全仓无调用方）；21 个 export 跨文件零引用（`SwarmValidationSuccess` 等类型契约可保留）
- `scheduler.ts:31/37` 两个未使用类型导入（`--noUnusedLocals` 可抓，见基线）
- `index.ts:364-469` `execute` 106 行 / 嵌套 7 层；`SwarmHeaderAction.tsx:296-476` 181 行、`:11-253` 有 243 行内联 CSS
- `validate.ts:86` 的 `items.length > 0` 是死条件；`result-xml.ts:117` summary 分支未穷尽（非预期状态静默计入 aborted）；`validate.ts:113-115` 的 `DUPLICATE_PROMPTS` details 不含碰撞文本，不利于模型自纠
- `client/index.ts:17` `ctx: any`（宿主 API 变更时 typecheck 不会报）；`SwarmHeaderAction.tsx:5` 多余 `React` 默认导入（`jsx: react-jsx`）

**C. 客户端**
- 僵尸订阅：`client/service.ts:58-69` 静默吞掉流异常，且 `:87-94` 只在 `count<=0` 时删表项 → 只要还有一个订阅者，同会话**不会重开流**且无任何错误可见
- 重试倒计时静止（`SwarmHeaderAction.tsx:444-446` 用 `Date.now()` 渲染 + 全仓无 `setInterval`）——注意该 UI 本身属 S1 死路径
- `ensureCssInjected()` 在渲染函数体内调用（`:297`）；`client/index.ts:51` 匿名闭包使 `watchSwarm` 每次都是新引用，可能触发订阅抖动
- 无 ErrorBoundary；`package.json:65` 声明了代码未用的 `@deepseek-ai/dsh-client-ui-primitives`
- `framesFor` 对**已结束批次**永不发 `closed` 帧（`swarm-registry.ts:367` 初始化 `lastEndedAt` 使 `:410` 条件恒假）。今日客户端只消费 `roster`，故仅属协议缺口
- `remote-descriptor.ts:36` 的 `typeSymbol` 声明为 `SwarmRosterFrame`，而生成器实际产出 `SwarmFrame` 联合体（含 `opened`/`closed`）；当前 `passSchema` 兜底不崩，启用强类型 codec 即崩

**D. 测试**
- 调度器 harness 把 `classify` 钉死为 `"first-request-blocked"`（`tests/scheduler.test.ts:64`），`drain()`（`:136-146`）每轮无条件结算所有在跑任务 → 时序被拉平，依赖 settle 顺序的竞态无法暴露；且测试显式传 `maxConcurrency`（`:279/300`），**跑的是生产从不使用的配置路径**
- 测试标题与断言不符（`:556-577`「退避后重试仍可成功」实际只验证「首次限流不判死」）
- `tests/` 全目录**零断言 `error.message`**（文案漂移无人守护）；128 上限只断言末项 `specs[127]?.index === 128`
- 无 React 渲染测试（node 环境、无 jsdom/@testing-library），`SwarmHeaderAction` 476 行组件零覆盖；`tests/client.test.ts:47` `streamYield` 是死变量
- 全仓无 lint 配置却有 lint 抑制指令（见 P1-9）

---

## 五、模块质量水位

| 模块 | 水位 | 判定依据（摘要） |
|---|---|---|
| `scheduler.ts`（662 行） | 好（有结构性问题） | 时钟/定时器/执行函数**注入彻底**（`Date.now` 仅出现在注释）；abort 级联完整、4 条终止路径定时器清理干净（实测 leftovers=0）；24 个私有方法无一个 >60 行；但整条限流分支死代码（P1-1），且死代码内还有 4 条潜在缺陷 |
| `index.ts` + `swarm-registry.ts` + `remote*.ts` | 中上 | 工具注册/子代理句柄/批次记录/流监听**四类副作用均可逆**（句柄 `finally { run.dispose() }` 严格配对）；错误冒泡契约（不谎报 completed）遵守；但中断语义不闭合（P1-2）、`apply` 的注释少算了 `new SwarmRemote` 这一副作用 |
| `validate.ts` + `result-xml.ts` + `types.ts` | 中（有实质缺陷） | 五条硬校验前置、编号一致性断言、注入防御（item 含 `{{item}}`/`<subagent …>`/CDATA 终结符均经真实解析器验证无损）、1e5 字符线性无 ReDoS——这些做得扎实；但两条 P1（属性规范化、空 item）+ agent_id 缺失 |
| `src/client/**` | 中 | 引用计数订阅、按会话隔离、双语字典注册等基本结构清楚；但吞错、僵尸订阅、渲染期副作用、零渲染测试 |
| 打包/挂载 | 好 | `main→dist`、`exports`↔`build-client` 输出对齐、自指 bundle 一行、三 profile 安装一致、dump-config 正常 |
| 文档 | 差 | 三份关键文档与实现不符（ARCHITECTURE / spec 功能清单 / 两处文件头自述）+ 登记表不闭环 |

---

## 六、测试有效性总评

**基线绿是真实的，但绿的覆盖面被三件事结构性削弱：**

1. **测了不可达的子系统**：36 条调度用例中所有限流用例（退避、容量收缩/恢复、死锁防护、轻/重罚分支）都建立在 harness 伪造的 `rate_limited` 结局上，而生产装配**永不产生**该结局（P1-1）。测得很细，却与现网行为无关——这是最典型的假信心结构。
2. **看不见规范层缺陷**：往返测试用手写正则读取器（`tests/result-xml.test.ts:28-43`），不实现 XML 规范，因此 P1-3 那类"输出对、语义错"的缺陷**在测试里不可能变红**；同时 `toContain` 类子串断言无法发现属性被丢弃（P1-5）。
3. **交付物未被端到端验证**：client 侧测盘上的旧产物、host 侧测源码命名空间、`dist/index.js` 无人验（P1-6）。

**做得好、值得保留的部分**（我核过，不是客套）：注入式时钟与定时器让时序可确定性复现；`assertIndexAlignment` 把编号错位从"静默错位"改成"抛错"；body/属性全转义并保留文本可读性的取舍有明确论证；决策笔记里记录的三条契约（executor 失败必须 throw、dist 入口、Loader 真实性）都真的落在代码里。

---

## 七、未收敛项（`docs/spec.md` 验收对照）

| spec 条目 | 交付态 | 判定 |
|---|---|---|
| M1 纯函数核心 + 五校验 + 转义往返 | 已实现，测试绿 | ✅ |
| M2 契约测试 + 真实 Loader 测试 + dump-config 可见 | 已实现；但 Loader 测试绕过了 unwrapExports、未验 dist | ⚠️ 部分收敛（P1-6） |
| 一期功能 3「限流退避 3000ms×2ⁿ / 容量收缩 / 180s 恢复 / 死锁防护 / 首请求重罚」 | **无触发路径**（P1-1） | ❌ 未收敛，且未回写 spec |
| M3 实机验证（限流 `failure.code`、沙箱继承、审批行为） | 项目自述未做（NOTICES §6 阻塞项） | ⏸ 待实机 |
| M4a/M4b 面板与 bundle 形态 | 代码/打包/dump-config 均通过；面板目测依赖用户重启两端 | ⏸ 待用户目测 |
| 二期 `resume_agent_ids` | 未开始；且 XML 未输出 `agent_id`，**当前无取值来源** | ❌ 前置条件缺失（P1-5） |

---

## 八、复核记录：本次被降级/剔除的子代理告警

审查员给的是证据，不是结论。以下 6 条经我回读源码后**调整了定级或表述**，特此记录以保证报告可信度：

| 子代理原判 | 我的复核结论 | 依据 |
|---|---|---|
| A：P0 容量闸门互锁 → 批次永久停摆 | **降 P2**：机制成立但生产不可达 | `maxConcurrency` 不在 Config schema、`index.ts:448-459` 未传；grep 全仓仅 scheduler/types 自身出现 |
| A：P0 回调抛错 → 未处理 rejection + 死锁 | **降 P2**：真实缺口，今日不可达 | `swarm-registry.ts:240-243/261-264` 防御性 return；`notify()` 对 listener try/catch |
| A：P1 队列退化为 180s/成员 | **保留但改述**：属"容量收缩背压"的设计取舍，且整条不可达 | `#recoverRateLimitCapacity` 语义 + S1 |
| E：代码照搬 v1、NOTICES 虚假陈述 | **不成立**：三条字符串与状态机结构同样逐字出现在**白名单** `01-机制文档` 内，溯源不可判定；改判为 P1-8（分发物含上游逐字文本 + 自证不可审计）+ S4（边界实践漏洞） | `00-总体架构.md:234/236/308`、`03-…校验规则.md:254/300/301`、`02-…退避.md:20/314` |
| F：7 处吞错（含"浮空 Promise"） | **改述为 6 处静默 catch**：`swarm-registry.ts:142`、`client/index.ts:61/66`、`client/model.ts:41`、`client/service.ts:67/76`；另 3 处（`scheduler.ts:401`、`index.ts:262/295`）正常。IIFE 自带 try/catch，不构成未处理 rejection | 逐处读过 catch 体 |
| C：未配对代理项导致 XML 序列化崩溃（P1） | **降 P2**：函数声明范围即"控制符"，且失败依赖传输侧编码器行为 | `result-xml.ts:33-35` 注释与正则 |
| B：`closed` 帧缺失（P1）、`typeSymbol` 漂移（P1） | **均降 P2**：当前客户端只消费 `roster`；codec 由 `passSchema` 兜底 | `client/service.ts:59-66`、`remote-descriptor.ts:34-38` |

**一处我自己的越界与纠正**：取证 `agent_id` 时，我的检索最初命中了分析仓根 `README.md`（既不在白名单、也不在禁读名单）。已改用 `01-机制文档/00-总体架构.md:263-265` 内的等价证据，报告中不引用根 README。

---

## 九、建议处置顺序（仅建议，未动任何代码）

**第一批 · 低成本高收益（建议本次就做）**
1. P1-3 属性值补字符引用转义（3 行）+ 往返测试换真实解析器
2. P1-4 空/空白 item 与非法类型走结构化失败
3. P1-5 补 `agent_id` 属性（或就地登记为有意偏离）
4. P1-6 `test` 脚本前置 build；client 测试改为内存构建
5. P1-7 更新 `ARCHITECTURE.md`（模块树 / 依赖方向 / 双半数据流）
6. P1-9 `git init` + `.gitignore` + 首提交 + 清旧 tgz（**建议最先做**，否则后面所有修复都没有回滚兜底）

**第二批 · 需设计**
7. P1-2 统一中断语义（`#abandonSuspended` 覆盖未启动成员 + `endBatch` 状态推导），补「派发前中断」测试
8. P1-8 按下列路线择一执行

**第三批 · 需你拍板（我不替你决定）**

- **决策 1｜clean-room 路线**：
  - **路线 A（推荐）**：改写 `validate.ts:89/95`、`scheduler.ts:44` 三条上游逐字文案 + 修正 `validate.ts:5`/`types.ts` 措辞 + 补登 `types.ts`。改动 <10 行，改完"未复制第三方源码"的声明即自洽，不必补 MIT 全文。
  - **路线 B**：保留文案，在 NOTICES 补齐上游 MIT 版权行/许可全文/包名。合规姿态更保守，但等于承认衍生关系，且要把 §1「未复制任何源代码」整段重写。
- **决策 2｜限流能力**：本期内接入 `llm/retry` 事件让退避真正生效，还是把 spec 功能清单 3 回写为未交付、并让面板 `retrying` UI 下线/标注？现在的状态是"规格说交付了、代码永不触发、注释说还在工作"——三者必须对齐其一。

---

## 附录 A · 本次审查的边界与未做事项（诚实声明）

- **遵守项目红线**：全程**未打开** `extracted/kimi-code-swarm-analysis/02-v2源码/` 与 `05-UI与API层/`；对参考素材的检索用 `include: *.md / *.js` 把面收敛到白名单目录（`01-机制文档`、`03-v1源码`、`04-协议层`）。
- **未做破坏性验证**：没有重建 `dist/`、没有移动/删除任何文件。因此"干净检出下 `pnpm test` 会因缺 `dist/client.js` 失败"是**结构性推断**（代码读 `dist/client.js` + `test` 脚本不前置 build），未做实证复现。
- **未能验证**：真实 provider 429 下的限流行为（无法构造）；面板真机渲染（需你重启 DSH 目测）；`new SwarmRemote(ctx, registry)` 是否由 cordis fiber 隐式回收（宿主基类语义未在本仓可证范围内，标为待确认）。
- **测试临时文件**：子代理的一次性实验脚本写在 `$env:TEMP` 下，项目目录零改动（`pnpm test` 复核仍 137 绿）。

## 附录 B · 关键证据索引

- 限流死代码链：`src/index.ts:164-166` → `src/scheduler.ts:403` → `:491` → `:540`；`src/index.ts:156-158`
- 中断语义：`src/scheduler.ts:589-609`、`:619-622`、`src/swarm-registry.ts:288-294`、`src/index.ts:430-433`
- XML：`src/result-xml.ts:33-35/58-64/150-158/176-178`、`tests/result-xml.test.ts:28-43`
- 校验：`src/validate.ts:63/86/89/95/113-115`、白名单依据 `01-机制文档/03-工具入参与校验规则.md:37`
- 宿主：`src/index.ts:350-355/448-459/461-463/472`、`src/swarm-registry.ts:233-271/355-422`
- 客户端：`src/client/service.ts:40-94`、`src/client/index.ts:17/42-56`、`src/client/SwarmHeaderAction.tsx:5/297/441-449`
- 测试：`tests/client.test.ts:47/113`、`tests/plugin.test.ts:664-671/711`、`tests/scheduler.test.ts:64/136-146/279/556-577`
- 文档：`ARCHITECTURE.md:7-22`、`docs/spec.md`（功能清单 3 / 二期）、`THIRD-PARTY-NOTICES.md:8-16/20-26`、`src/validate.ts:5`、`src/types.ts:4-6`

---

## 十、修复进展（第一轮，2026-10-01 当日完成）

修复分两个波次落地。开始修复前先补建版本控制（`3e1ab2a`），因此每一笔都可逐笔回溯/回退。

| 条目 | 处置 | 落在哪 |
|---|---|---|
| P1-1 限流子系统不可达 + 注释矛盾 | 对齐文档、**不盲接**（理由见决策笔记） | `1edce1a` + `docs/spec.md`「交付状态」+ 决策笔记 |
| P1-2 中断后 registry 与 XML 结论相反 | 已修复（含残余竞态） | `cd7be49`：通知覆盖未启动成员 + `markSettled` 终态粘性守卫 |
| P1-3 属性值未做字符引用转义 | 已修复 | `1edce1a`（6 条规范性测试） |
| P1-4 空/空白 item 放行 | 已修复（新增第六道校验） | `1edce1a`（`ITEM_EMPTY`/`ITEM_NOT_STRING` + 8 条失败路径用例） |
| P1-5 结果块丢弃 `agent_id` | 已修复 | `1edce1a`（6 条用例） |
| P1-6 测试与交付物错位 | 已修复 | `1edce1a`（先构建 + 内存打包 + 真实 dist 加载 + 红线用例） |
| P1-7 `ARCHITECTURE.md` 过期 | 已修复 | `1edce1a`（12 源文件 + 依赖/数据流/构建链 + 维护规则） |
| P1-8 第三方登记与文案 | 已修复 | `1edce1a`（两条）+ `cd7be49`（第三条）+ NOTICES §1/§2/§3/§7 |
| P1-9 无版本控制 | 已处置 | `3e1ab2a`（`git init` + `.gitignore` + 基线提交）；旧 `.tgz` 保留未删（可逆优先） |

**关键证据（父代理亲自复跑，非子代理自证）**

- 全量：`pnpm test` **167/167 绿**（7 文件，基线 137）；`pnpm typecheck` exit 0。
- P1-2 红→绿：`expected 'failed' to be 'aborted'`、`expected [] to deeply equal [2..8]` → 全绿。
- P1-2 残余竞态双版本对照：基线（无守卫）`{成员 failed, 批次 failed}` → 有守卫 `{成员 aborted, 批次 aborted}`。
- P1-6 变异测试：向 `dist/index.js` 注入 `export default` / 改名 → 新红线用例如期变红。

**未修（登记为 backlog，理由见各条）**：全部 P2（调度器死代码内的 4 条潜在缺陷、可维护性、客户端僵尸订阅与倒计时、测试断言松弛）；其中"引入 jsdom/@testing-library 做 React 渲染测试"按"引入依赖先问"纪律未做。

**新增已知项（本轮发现、未改动）**：单成员 `stopReason=aborted` 时 registry 落 aborted 而 XML 落 failed —— 即既有的"取消与失败未分档"，已在 `THIRD-PARTY-NOTICES.md` §6 登记。

**未验证（诚实声明）**：

- 修复后的真实 provider 行为（429 退避仍不可达，属 P1-1 的既定处置）；
- 面板真机渲染（需重启 DSH 后目测）；
- **已验证（2026-10-01 交付）**：`dsh-agent-swarm-0.3.3.tgz`（67,308 B）已装入 web / desktop / headless 三个 profile。
  · **文件级**（三者都核过）：安装前后 `package.json` 差异**只有本包依赖行**（依赖数 12→12、bundles 14→14 未变），三个 profile 的 `dist/index.js` 与工作区**逐字节一致**，版本均 0.3.3。
  · **运行级**：`dsh --profile web|headless --dump-config` 均 exit 0、`agent-swarm` 恰 1 行；**desktop 无法用 CLI 验证**——`dsh` 明确拒绝（`error: profile "desktop" is managed exclusively by the Electron application`，设计如此，非本次改动所致），其运行时生效需用户重启 Electron 后确认。

### 十·补、独立验证与跟进（同日）

第一次独立验证（fresh subagent、未参与产出）结论为**有条件通过**：9 条 P1 的逐条对账全部属实、167 绿被独立复跑复现，但**证伪出两条**——

1. **残余竞态（真缺陷）**：中断时"已进入 running 的成员若以 Promise reject 收场"，宿主 `catch` 会把它落成 `failed`，而 XML 已是 `aborted`——与 P1-2 同类，只是走了另一条路径。
2. **文档笔误（我写的）**：`ARCHITECTURE.md` 把**数据流**写成了**依赖方向**（`scheduler.ts → validate.ts/result-xml.ts`）；实际 `scheduler.ts` 只依赖 `types.ts`。

两条处置于 `d0ffe68`：

- **判据统一为批次信号**：新增 `settleOutcomeAfter(batchSignal)`（`batchSignal.aborted ⇒ aborted`，否则 `failed`），`stopReason` 分支与 `catch` 共用；子代理自报原因仍进 `detail`。
  ⚠️ 修复过程**证伪了父代理最初的假设**（`attempt.signal.aborted`）：调度器自己的超时闸门 abort 的正是该信号，超时与中断在这一位上同形——用它会把超时误判成 aborted。该反例已固化为护栏用例。
- **文档订正**：依赖方向按真实 import 图重写并明示"数据流 ≠ 依赖"；`spec.md` 五条 → 六道硬校验。

**验证留痕后的验收基线**：`pnpm test` **172/172 绿**（7 文件，基线 137）；`pnpm typecheck` exit 0；`pnpm pack` → `dsh-agent-swarm-0.3.3.tgz`（67,309 B）。

**新增已知边界（未闭合，已在代码注释与决策笔记登记）**：终态判定与调度器落定结果之间隔着 `finally { await run.dispose() }`；中断恰好落进该窗口时 registry 可能停在 failed 而 XML 已判 aborted。闭合它需要改调度器/宿主分工，评估为收益与代价不匹配，留待后续。

**交付时新发现（本轮未处置）**：打包产物里**没有 `LICENSE` 文件**，而 `package.json` 声明 `"license": "MIT"`。对外分发惯例需带许可全文；因涉及版权署名归属，交用户拍板。

---

## 十一、P2 批次的处置与订正（第二轮）

### 已修（按 WP 分笔提交，各自文件集独立、可单独回退）

| 分组 | 条目 | 提交 |
|---|---|---|
| 调度器（限流启用前置） | 并发闸门与容量恢复互锁（保活不变量：有 pending 且未结束 ⇒ 必有未来唤醒）；宿主回调抛错不再让调度停摆（告警写进该成员结果，与 `bodyOf` 口径对齐）；构造期校验 `maxConcurrency`；`run()` 幂等 | `5acbd0d` |
| 宿主一致性 | 工具描述的数量改为常量插值；新增 `DEFAULT_TASK_TIMEOUT_MS` 并归位；三态映射收敛为 `toSettledPhase`；`execute` 拆分（嵌套 7→2，21 场景 XML 快照逐字节一致） | `4a9812f` |
| 客户端 | 流异常不再静默 + 允许重建 + 陈旧 unsub 不误停新流；倒计时由 `RetryTicker` 驱动；CSS 注入移出渲染体；`watchSwarm` 引用稳定；`ctx: any` → `ClientContext`；清掉未用的 client inject 声明 | `62cf084` |
| 测试保真度 | harness 加 `rateLimitClass` 旋钮与 `advanceClock`（不结算驱动，保留 drain）；重试用例加严；描述/相位/配置守卫用例 | 随上述三笔 |

### 决定**不修**的（附理由）

1. **容量恢复不设上界**（原 P2-A3）——**订正**：`maxConcurrency` 是独立第二道闸门，已兜住"超过宿主设定"这一唯一实际风险；给容量加硬上限反而会在"早期限流"后把容量永久锁在 1（即本报告里"每 180s 只放 1 个"的成因），比无上界更糟。判定与理由已写入 `#recoverRateLimitCapacity` 注释与归属决策笔记。
2. **`SwarmHeaderAction.tsx` 结构拆分 + 243 行内联 CSS 抽离**——该组件**没有任何渲染测试**（node 环境、无 DOM），在无覆盖的情况下叠加结构性重构，等于只能靠"重启后目测"验收。等渲染测试到位、或该组件因功能需要大改时再做。
3. **流终止后自动重连**——本轮做到"允许重开"（失效条目被摘除）。自动重连必须配退避与重试上限（否则退化成"失败即重试"死循环），且其正确性依赖 effect 行为，无 DOM 测试时无法验证。建议单开一条 WP。
4. **引入 jsdom + @testing-library/react 补渲染测试**——属"引入依赖先问"，未获批，本轮未做。

### 对本报告自身两处结论的订正（子代理证伪 + 已复验）

1. **原 P2-C5「缺少 React 错误边界，组件异常会击穿标题栏」不成立。** 宿主槽位 outlet 已对每个条目做 per-entry 隔离：`app.asar` 内存在 `SlotErrorBoundary`（4 处使用点）与 `data-slot-error` 标记，注释原文 "Per-entry isolation: one registrant crashing (component render or inject factory) must not take down siblings…"；复验方式＝用系统 node 直接在 asar 二进制检索字符串，命中偏移 22533399 等，与子代理报告一致。故不重复造边界。
2. **原 P2-D2「用例标题与断言不符」不成立。** 原用例确实断言了 `attemptsOf(1) === 2` 且该成员最终 completed，即"重试成功"已被验证；真实缺口是"缺少连续限流场景的覆盖"，已按"补真实验证"加严。同理 **P2-D1 的"classify 被 harness 钉死"表述不准**：`depsOver` 展开在默认值之后，本来就可覆盖，缺的是显式旋钮与对照用例（已补，且修复前后都绿，属覆盖补强而非行为变更）。

### 流程自省

- P2 第一波我把 **7 个子项打成一个 WP**（客户端），跨 6 文件、+834 行（主体是测试），**超过既定 500 行红线**。功能与证据没问题，但"可审阅单元"被撑大，属我的打包失误；第二波已改为"一个 WP 一个可说明的行为"，并继续按 WP 分笔提交。
- 至此对本报告的**外部订正累计 6 处**（4 条由独立验证者证伪、2 条由执行子代理证伪），均由父代理回读源码/二进制复验后才改动本文档。

### P2 第二波（同日，三笔提交；每笔文件集独立）

| 分组 | 条目 | 提交 |
|---|---|---|
| 协议面 | `framesFor` 对**已结束批次**补发 `closed` 帧（修复前 `lastEndedAt` 初值使判定恒假 → 以 closed 为结束信号的客户端会一直等）；`TYPERT_REMOTE.result.typeSymbol` 由 `SwarmRosterFrame` 改为 `SwarmFrame` 联合体，并写明强类型 codec 应按 `type` 判别式校验三分支 | `2b67fd5` |
| 纯函数 | `renderSwarmSummary` 改**穷尽匹配**：未知 outcome 不再静默计入 aborted，单列 `unknown: N`；`default` 分支以 `const unhandled: never` 做**编译期**守卫（实测给 `SwarmOutcome` 加值即 TS2322）；`DUPLICATE_PROMPTS` 的 details 补 `itemSnippet/promptSnippet/*Chars`（前缀 120 码元，details 总量 < 500 字符）；128 上限用例改全序列比对；5 条错误码补"关键要素"文案断言 | `da63470` |
| 模型面契约 | 新增 `effectiveMaxItems(config)` 作为**唯一**算上限处；工具描述与参数描述按**生效上限**生成（此前写死常量 128：宿主把 `maxItems` 调低时，模型会按 128 规划然后被第 11 条拒掉），并保留"协议硬上限 128 不可绕过、宿主只能调低"的说明段 | `59188c7` |

**本轮新增的有意偏离**：`<summary>` 多了一个 `unknown: N` 桶（正常路径不可达；作用是"不把未知 outcome 谎报成 aborted"）——已登记 `THIRD-PARTY-NOTICES.md` §5 第 9 条。

**本轮回归证据**：全量 `pnpm test` 由 172 → **217** 条（7 文件），`pnpm typecheck` exit 0；每笔都有红→绿（重构类用定向变异或 21 场景 XML 快照逐字节一致作证）。

