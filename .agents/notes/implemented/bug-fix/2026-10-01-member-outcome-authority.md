# 成员终态的唯一判据：批次信号（registry 与 XML 的对齐口径）

## Problem

同一成员在两个口径下被判成不同结局，是本仓反复出现的一类缺陷（2026-10-01 审查的 P1-2）：

- **XML**（权威口径，见 `ARCHITECTURE.md`「host/client 双半数据流」）由调度器的结果数组渲染：批次中断时
  `#finishWithAbort` 把所有尚未落定结果的成员统一填成 aborted；
- **registry**（面板数据源）由宿主 `src/index.ts` 的 `runOneTask` 落终态。

修复首轮之后，独立验证者又证伪出两条残余分叉：

1. 已 markReady 的**在跑**成员在中断后以 Promise **reject** 收场时，catch 把它固定落成 failed —— 而 XML 是 aborted；
2. **单任务超时**下子代理优雅 resolve(`stopReason="aborted"`) 时，原实现按"自报"落 aborted —— 而 XML 是 failed。

同时，"看起来更近"的判据 `attempt.signal.aborted` 是**错的**：调度器自己的超时闸门
（`scheduler.ts` 的 `#linkAttemptSignals`）在超时那一刻 abort 的正是 executor 拿到的
`attempt.controller.signal`，于是超时与批次中断在该位上完全同形（WP-C2 实测反例：换成该判据后超时用例立刻变红）。

## Decision

宿主侧成员终态的归属**只认批次信号**（`exec.signal`，即 `SwarmSchedulerDeps.signal`）：

```
batchSignal.aborted === true ⇒ "aborted"；否则 ⇒ "failed"
```

`runOneTask` 的两处终点（`stopReason` 分支与 `catch`）共用该判据（`settleOutcomeAfter`）；
子代理自报的原因仍写进 `detail` 与 XML 正文。`completed` 分支不受影响：真的跑完就保留 completed。

## Alternatives considered

- **用 `attempt.signal.aborted` 判定**（父代理最初的假设）：否决，已被实测证伪 —— 超时同样会 abort 它，
  会把超时成员错记成 aborted（护栏用例 `tests/plugin.test.ts` 的 ③a）。
- **信任子代理自报的 `stopReason`**（原实现）：否决 —— 自报 "aborted" 只说明该成员被取消，
  不说明**批次**被打断；超时路径正是反例（③b）。
- **只补 catch、不动 `stopReason` 分支**：否决 —— 会留下镜像矛盾（registry aborted / XML failed），
  且既有用例早已把该输入的 XML 定为 failed。
- **把落终态推迟到 `run.dispose()` 之后以闭合窄窗口**：本次否决（记为已知边界）——
  会延后 UI 终态并牵动调度器与宿主的分工，收益与代价不匹配。

## Consequences

- 收益：registry 与 XML 不再对同一成员给出相反结论；面板在中断后不再显示 failed。
- 代价：单成员被取消（非批次中断）时 UI 相位显示 failed，真实原因保留在 detail 与 XML 正文。
- **已知边界（未闭合）**：判定与调度器落定结果之间隔着 `finally { await run.dispose() }`；
  中断恰好落进这段窗口时，registry 可能停在 failed 而 XML 已改判 aborted。闭合它需要改调度器/宿主分工。

## Confirmation

- `tests/plugin.test.ts` 的「G. WP-C2」组共 5 例，全部断言**可观测结果**（XML 文本 / 成员相位 / 批次状态）：
  ① 中断后 reject → 双方 aborted；② 纯失败 → 双方 failed（防过度修复）；
  ③a 超时 reject → 双方 failed，并在用例内钉住"成员信号 aborted 且 reason 含 timed out"这条反例；
  ③b 超时下优雅自报 aborted → 双方 failed；④ 先失败后中断 → 各自如实（failed / aborted）。
- 回归：`pnpm test` 172/172（7 文件）；`pnpm typecheck` exit 0。
