# 调度器 executor 的失败必须用 throw 表达

## Problem
调度器 runSwarm 对 executor 的 resolve 一律记 outcome:"completed"，只有 reject 才落 failed/aborted。M2 集成时若让派发函数"返回失败对象"，所有失败成员会在 XML 里被谎报成 completed——结果汇总失去可信度。

## Decision
src/index.ts 的 runOneTask 对一切非 completed 结局（含 start 抛错、stopReason≠completed）一律 throw SwarmTaskFailure；契约注释写进 index.ts 与 scheduler 交接处。

## Alternatives considered
- 改调度器让它识别"失败结果对象"：扩大 M1 公开 API 的判别面，executor 契约从二值（resolve/reject）变三态，更易错——否决。
- 在 XML 渲染层二次修正：错误在数据层已发生，渲染层无从分辨真假 completed——否决。

## Consequences
executor 契约简化为"resolve=成功，throw=失败"；取消（aborted）经同一 throw 路径进调度器，由调度器按 signal 状态归 aborted。

## Confirmation
tests/plugin.test.ts 含"失败成员不谎报 completed"与"个别失败不拖垮整批"的断言，持续守护。
