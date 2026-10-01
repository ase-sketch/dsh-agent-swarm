# 限流能力状态：回写为「未交付」，不盲接 llm/retry

## Problem

规格（`docs/spec.md` 一期功能清单第 3 条）把"限流指数退避 3000ms×2ⁿ、容量收缩防抖 2000ms、
每 180s 恢复 +1、死锁防护、首个请求未发出的限流重罚"写成一期已交付能力。
2026-10-01 代码质量审查证实：生产装配的 `isRateLimitErrorPhaseOne` 恒返回 false，
而它是调度器"限流结局"的唯一产出点 → 退避、容量收缩/恢复、`retrying` 相位、面板退避 UI
**全部没有触发路径**；`src/index.ts` 处还有一句"容量收缩/恢复/退避仍然照常工作"的注释，与代码事实相反。
即：规格说交付了、代码永不触发、注释说还在工作——三者必须对齐其一。

## Decision

本期内**不改判定函数、不接入 `llm/retry` 事件**。改为：

1. `docs/spec.md` 的功能清单第 3 条标注交付态，并新增「交付状态」章节，写明未交付事实与**启用前置条件**；
2. 删除 `src/index.ts` 中那句错误注释，改为如实说明"整条限流分支当前完全不触发"；
3. 面板 `retrying` UI 与 `swarm-registry` 的相应相位**不动代码**（它们是不可达路径，不会渲染），只在文档中标注未启用；
4. 把该子系统已确认的三处内部缺口登记为"启用前必修"。

## Alternatives considered

- **立即接入子会话 `llm/retry` 事件（spec 原计划的 M3 待办）**：否决。① 无法在开发环境构造真实 429，
  接完也无法验证，等于新增一条"声明了但没验证过"的路径——正是本次审查反复出现的病灶；
  ② 该子系统内部有三处已确认缺口（容量恢复无上界、无限流模式退出路径、并发闸门与容量恢复互锁），
  现在它们是死代码不伤人，启用后立刻变成现网路径。
- **直接删除整条限流实现**：否决。它是上游行为的保真实现，且接入方式（注入点 + 事件名 + `failure.code`）
  已经调研清楚；删掉是把既有成果丢掉，未来还要重写一遍。
- **只改注释、不动 spec 功能清单**：否决。"规格说交付、交付里没有"正是本次审查归纳的头号问题类型，
  留着等于预订下一次同类发现。

## Consequences

- 收益：规格 / 注释 / 代码事实三者对齐；谁要启用手上有明确清单，不必重新做一遍调查。
- 代价：一期实际**不具备**限流自适应。遇到 provider 429 时成员会直接判 failed，而不是退避重试
  （与上游行为不同）。这一点现在被显式写进 spec，而不是藏在注释里。
- 影响面：仅文档与注释；运行时行为与修复前完全一致（因为该路径本就不可达）。

## Confirmation

- 即时校验：`docs/spec.md`「交付状态」与 `src/index.ts` 的注入点注释均描述了"恒假 → 整条分支不触发"。
- 启用时的验收条件（缺一不可）：① M3 实机确认 `llm/retry` 的 `failure.code` 取值；
  ② 修并发闸门与容量恢复的互锁；③ 宿主回调抛错时调度不得停摆；④ 补一条"限流后 pending 成员仍能被放量"的调度器用例。
  （原先写的"补容量上界"已按下方「复核订正」撤销。）

## 复核订正（同日，P2 批次开工前）

P2 批次开工前复核 A 组四条"启用前必修"，其中 **「容量恢复无上界」判定为不改**：

- 报告最初的担心是"限流模式下实际并发可远超宿主设定"（实测 active=9 / capacity=15）。但 `maxConcurrency`
  是**独立的第二道闸门**（scheduler 的 `#isAtConcurrencyLimit`）：宿主一旦配置它，容量恢复再高也越不过去；
  而本仓生产装配里 `maxConcurrency` 根本未接线，故"超过宿主设定"这一风险没有载体。
- 若按报告建议给容量加硬上限（例如"不超过进入限流时的水位"），在"早期就限流"的场景下会把容量**永久锁在 1** ——
  这恰恰是同一份报告里"队列退化为每 180s 只放 1 个"的成因，等于把一次性能抖动固化成长期行为，比无上界更糟。
- 结论：保留"每跨一个恢复窗口 +1、无上界"的原语义（其实质是**渐进回到正常水位**），只在
  `#recoverRateLimitCapacity` 处补注释记录该判定。

**因此启用前置条件由三条收敛为两条**：① M3 实机确认 `llm/retry` 的 `failure.code`；
② 修掉并发闸门与容量恢复的互锁、以及宿主回调抛错导致调度停摆这两个缺口（P2 批次的 WP-P2-1 处理）。

## 2026-10-01 死锁防护缺口实证：≥2 个成员同时持续限流 ⇒ 无限重排队、批次 Promise 永不 resolve

> 归属：本节并入本笔记（决策演进 → 更新归属笔记，不新建重复笔记）。
> 定位：**M3 启用限流能力时的门禁项**，不是现网 bug（整条限流分支当前仍是死代码，见上文「Problem」）。

### Problem

`src/scheduler.ts:574` 的判死条件是 `#isOnlyUnfinishedTask(state) && attempt.state.retryCount >= 1`，
其注释里那句「不会引入无限重排队——……而『只剩它一个』意味着后续每次限流都满足条件，最迟下一次就判死」
只在**单成员持续限流**时成立。判定式里 `retryCount >= 1` 只是个下限，`#requeueRateLimited`（同文件 636 行起）
不设重试次数上限，于是**每成员的重排队次数无界**。当同时有 ≥2 个成员在限流时：
对成员 A 而言成员 B 同样是「未完成」，`#isOnlyUnfinishedTask`（627 行）返回 false → 判死分支不成立 →
走 else 的 `#requeueRateLimited` 无限重来。没有任何成员会走到判死，批次的 `Promise` 永不 settle，
`onAbandoned` 永不触发，面板与宿主持久等待一个不会到来的结果。

fake-timer 实测（2026-10-01 代码审查）：

| 场景 | settled | 限流重试次数 | onAbandoned |
| --- | --- | --- | --- |
| 2 个成员持续限流，推进 1 小时虚拟时间 | false | 22 次 | 0 次 |
| 3 个成员持续限流 | false | 33 次 | 0 次 |

现有「死锁防护」测试分组（`tests/scheduler.test.ts:742`）为什么没拦住：
三条用例都先用 `h.complete(...)` 让其它成员跑完，制造出「只剩一个未完成」，
于是 `#isOnlyUnfinishedTask` 在限流发生时恒为 true；`it("还有别的未完成任务时限流只重排队，不判 failed")`
（809 行）看似覆盖多人场景，但它恰恰断言**此时不判死**，并靠 `drain(h, p)` 收尾——
被测路径与「多个成员同时卡在限流里」不同。**多人同时限流这条路径当前零覆盖。**

### Decision

判死条件改为**双重条件**（任一成立即判 failed + 触发 `onAbandoned`）：

1. 原单成员条件：`#isOnlyUnfinishedTask(state) && retryCount >= 1`（保留现有放宽语义与偏离说明）；
2. per-task 重试上限：`retryCount >= maxRateLimitRetries`。

并新增配置项 `SwarmSchedulerConfig.maxRateLimitRetries?: number`（`src/types.ts` 的 `SwarmSchedulerConfig`）：

- `undefined` = 保持旧的无上限行为，向后兼容；**不在 `DEFAULT_SWARM_SCHEDULER_CONFIG` 里填值**
  （与 `maxConcurrency` / `timeoutMs` 同一约定：默认表不放「改变行为」的值；判死门槛是行为，不是默认值）；
- 构造期校验：必须是 ≥ 1 的整数，非法值即抛错（沿用调度器既有配置校验的 fail-fast 口径）；
- 生产装配 `src/index.ts` **保持不接线**：该字段留空即旧行为，限流能力启用时再由宿主显式透传。

### Alternatives considered

- **全员都在限流就判死（把「唯一未完成」换成「全部未完成」）**：否决。
  限流是 provider 侧的**全局**信号（429 常整批返回），同批其它成员几乎必然随后一起限流；
  用全体状态当判死门槛，等于把「暂时都不健康」翻译成「全部判死」，
  会**连坐拖死整批健康成员**——一个可恢复的抖动被固化成整批终态失败，比卡死更难排查、影响面更大。
- **只改「唯一未完成」为「全部未完成」，不加 per-task 上限**：同上否决，理由相同；
  且它在「只有 1 个成员限流、其余健康」的常见场景下判死行为不变，实际只新增了「全体限流→全体判死」这一条更坏的路径。
- **保留现状，只在本文件登记该缺口**：否决。已由 fake-timer 实测证明可卡死（settled=false、重试 22/33 次、
  `onAbandoned` 0 次）。限流能力一旦在 M3 接线，这就是「批次永不返回」级别的事故；
  仅登记不设门禁，等于把已实证的卡死留在 M3 的路上。
- **给 `DEFAULT_SWARM_SCHEDULER_CONFIG` 填一个默认上限（如 3）**：否决。
  这会在**当前**就把判死行为从「无上限」改成「有上限」，等于在没有 M3 实机数据的情况下
  顺带改了调度语义；而分寸（几次算多）需要实机 `llm/retry` 的 429 分布才能定，现在定就是猜。保持 `undefined` 默认无上限，把取值留给启用时的实机校准。

### Consequences

- 收益：判死不再依赖「恰好只剩一个未完成」这一脆弱前提，per-task 重试上限独立封住无界重排队；
  两个条件是 OR 关系，**原单成员路径的现有行为与偏离说明完全不变**。
- 影响面：`SwarmSchedulerConfig` 新增一个可选字段 + `#handleAttemptOutcome` 的判死式加一个分支；
  默认路径（`maxRateLimitRetries` 未设）运行时行为与现在逐字节一致。
- 代价：`retryBaseMs × retryFactorⁿ` 的退避在没有上限时会指数增长，启用限流后单成员最长重排队时长不可预期；
  启用时必须由宿主给出上限，否则仍是旧行为。
- 与既有条目的关系：不改变上文「容量恢复无上界 → 判定为不改」的结论，也不改变「整条分支当前不触发」的事实；
  本节只是把启用前置条件从两条补到**三条**（第三条 = 修判死条件 + 上限配置）。

### Confirmation

- 即时校验：改完后 `maxRateLimitRetries` 未设时，全部既有调度器用例（含 `tests/scheduler.test.ts` 死锁防护分组）
  应原样通过——这是向后兼容的判定依据。
- 启用前必补的回归用例（当前**零覆盖**，须新增）：
  ① 2 个成员同时持续限流 + `maxRateLimitRetries: N` → 达到上限后两个成员都判 failed、`onAbandoned` 各触发一次、批次 settle；
  ② 同一场景 + `maxRateLimitRetries` 未设 → 断言维持旧行为（不静默改语义）；
  ③ 构造期校验：`maxRateLimitRetries` 传 0 / 负数 / 非整数 → 抛错。
- 启用时的验收条件（在上文两条之外新增第三条）：③ 实机校准 `maxRateLimitRetries` 取值并在 `src/index.ts` 接线。

## 2026-10-01 第三轮：接线就绪、默认关闭（演进记录，并入本笔记）

### Problem

前两轮把能力状态对齐成「未交付」，启用前置条件里的调度器缺口（互锁、回调停摆、多成员判死）已修完，
剩下的只有「接线」本身与实机验证。接线若继续拖到 M3 实机时才写，实机窗口里要同时排查代码与环境两类问题。

### Decision

现在写完接线，但**默认关闭**（`config.rateLimit.enabled = false`）：

1. 纯逻辑 `src/rate-limit-signal.ts`：按子会话 id 收集 `llm/retry`（data.failure.code）与 `turn/end`
   （失败收场时 data.reason = { kind: "error", error: failure }，已对照 dsh-agent-loop 构建产物核实）；
   以 error 收场且**最终**失败码属于限流码集合时判限流（拿不到最终码时退看最后一次重试的码）。
2. 读事件走 `ctx.on("session/event")`：DSH 已把 `Session.ownEvents/snapshotEvents/eventAt` 全部标为
   deprecated（"new calls are prohibited"），追加事件流是唯一受支持的读法。订阅只在开启时建立，disposer 解除。
3. 判为限流时抛 `SwarmRateLimitedFailure`（品牌错误），`isRateLimitError` 按品牌判定；
   该路径不在宿主侧落终态（markSettled 粘性，提前落 failed 会让 retrying 永远显示不出来），
   相位由调度器的 onSuspended / onAbandoned 推进。
4. `rateLimit.maxRetries`（默认 3）只在开启时透传为 `maxRateLimitRetries`——关闭时保持 undefined，
   与本笔记「不在默认表里放行为值」的约定一致。

### Alternatives considered

- **事后读子会话日志（ownEvents）**：实现最简单、无需全局监听；否决——API 已废弃且明文禁止新调用。
- **继续不接线、等 M3**：否决——见 Problem；接线代码本身可以离线测透（L 组 5 条 + 单测 9 条），
  实机窗口只该验证环境事实。
- **在途背压**（看到 RATE_LIMIT 重试事件就收缩容量、暂停放量，但不重排队）：本轮不做。
  它能覆盖 provider 配成 always 重试模式时「子代理永不失败、重排队永不触发」的情形，
  但需要给调度器新增入口，且收益依赖实机的 429 分布——登记为开启后的候选项。
- **重罚档位映射**（first-request-blocked）：本轮一律轻罚。DSH 的 start() 成功即意味着子代理已开始首轮，
  "首个请求还没发出就被限流"没有可观测对应物；精确映射需要上游机制文档对 ready 的定义。

### Consequences

- 关闭（默认）时运行时行为与接线前逐字节一致：全部既有用例原样通过，L 组守护用例断言不重试。
- 开启后的新风险面：插件级 session/event 监听收到的是进程内所有会话的事件，入口先按事件类型丢弃（O(1)）。

### Confirmation

- 离线：`tests/rate-limit-signal.test.ts`（9 条）+ `tests/plugin.test.ts` L 组（5 条）。
- 开启前的实机验收（缺一不可）：① 真实触发 429，确认 `turn/end` 的 `reason.error.code` 取值；
  ② 插件级 `session/event` 监听确实收到子会话事件（DSH 只文档化了 agent 作用域监听的过滤语义）；
  ③ 子会话 id 等于 `run.id`；④ 按 429 分布校准 `maxRetries`。

## 2026-10-01 第四轮：删除重罚档位（first-request-blocked）与 classify 依赖（决策演进，并入本笔记）

> 触发：外部评审指出「调度器的重罚机制在生产接线下永久不可达，但带着完整测试与节奏契约
> 被列为特性」——僵尸子系统。第三轮已在宿主侧一律轻罚，本轮把死掉的另一半从调度器里删掉。

### Decision

1. 删除 `types.ts` 的 `SwarmRateLimitClass` 类型与 `SwarmSchedulerDeps.classify` 依赖；
   `scheduler.ts` 的 `#requeueRateLimited` 简化为一律轻罚（只推 retryBaseMs），
   `#classifyRateLimit` 方法删除；`batch-run.ts` 的 `classifyRateLimit` 接线移除。
2. `markReady` 保留：它的剩余语义（`state` 的 started 判定、中断时对未 ready 成员的放弃路径、
   限流模式下重新锚定放量时刻）与限流档位无关，注释已改写。
3. 测试同步：删「classify 对照」「classify 抛错」两条用例；「ready 前限流翻倍 6000ms」改写为
   钉住删除后行为（一律 3000ms）；harness 的 `rateLimitClass` 旋钮拆除。
4. `spec.md` 一期清单第 3 条的重罚条目以删除线废弃，交付状态段回写。

### Alternatives considered

- **保留契约、只在文档标注「预留」**：否决。上一轮「保留整条限流实现」的理由是它是上游行为的
  保真实现且接入方式已调研清楚；重罚档不同——它不是保真，是**超出**上游可观测面的推测性设计，
  宿主侧永远给不出输入。留着等于继续让测试为永不可达的路径背书。
- **连同 `globalRetryIntervalMs` 字段一起删掉**：否决（本轮）。删除翻倍分支后该字段恒等于
  `retryBaseMs`，但它仍是放量间隔的具名载体（snapshot 契约、`#enterRateLimitMode`、
  markReady 重锚定都在用），拍平它是纯机械重构，与本次「删僵尸」的行为变更分开更安全。

### Consequences

- 收益：调度器不再存在「测试全绿但生产永不可达」的分支；337 条测试（-2 删 +1 客户端新增）
  每一条都对应可触达行为。
- 代价：未来若上游暴露了「首个请求未发出」的可观测信号，需要重新加回档位——
  恢复成本就是 revert 本轮变更，代价明确且低。
- 行为变化：仅理论可达性——生产接线下 classify 恒返回轻罚，删除前后运行时行为逐字节一致。

### Confirmation

- `pnpm typecheck` exit 0；`pnpm test` 337/337 绿（含改写后的「ready 前限流也只推 3000ms」
  与「markReady 重新锚定放量时刻」两条钉住删除后语义的用例）。
- 若未来重新引入档位，验收标准：宿主必须能给出「首个请求未发出」的真实信号来源，
  否则不得加回。
