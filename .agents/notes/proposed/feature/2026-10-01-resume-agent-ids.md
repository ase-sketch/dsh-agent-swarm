# resume_agent_ids：续跑未完成成员——先 spike，不写运行时代码

## Problem

二期 backlog 的 `resume_agent_ids`：模型拿上一批结果里的 `agent_id`，让未完成的成员接着跑，
而不是从头再派一个。spec「交付状态」曾写「取值来源已补齐（XML 回传 agent_id），二期续跑不再被卡住」。

第三轮核实（DSH `@deepseek-ai/*@0.2.0-rc.2` 构建产物）证明**该结论不成立**：

- 本插件每个成员都经 `ctx.subagents.start()` 派发，那是 **one-shot** 子代理；XML 回传的 `agent_id` 就是它的 run id。
- DSH 对子代理续跑只认 continuable：`@deepseek-ai/dsh-subagent` 续跑路径在
  `descriptor.mode !== "continuable"` 时抛 `NOT_RESUMABLE`（"has no supported continuation state and cannot be resumed"）；
  `interrupt` 的文档也写明 one-shot 目标是 no-op。
- one-shot run 的 `dispose()` 会移除子 agent 与其会话（dsh-subagent-in-process-driver README「What one run provides」）。

所以真正的阻塞点不是"拿不到 id"，而是"拿到的 id 在 DSH 里不可续跑"。

## Decision

本轮**只做调研与文档订正，不写运行时代码，也不向模型暴露任何新参数**（避免再出现"声明了但没交付"）。
下一步是一个 spike，在三条候选路线里选一条，选定后再把本笔记移到 implemented/：

| 路线 | 做法 | 主要代价 / 待核实 |
|---|---|---|
| A. 成员改 continuable | `startContinuable` 起成员、`sendMessage` 续跑 | continuable 受 `maxActiveSubagents`（默认 8）硬上限，满了**直接拒绝**（ACTIVATION_LIMIT_REACHED，不排队）——调度器的放量要被压到 8 以内；结果不经 `SubagentRun` 返回，要另接 settled 消息源；整个派发与收集模型都要改 |
| B. 自建 resume provider | 用 `@deepseek-ai/dsh-subagent-in-process-driver` 公开导出的 `startInProcessRun(request, { seed })`，以旧成员已持久化的会话作种子起一个新的 one-shot | 需核实：已 dispose 的子会话日志能否读到（同步读事件 API 已废弃）；`dsh-session` 的 `buildForkSeed` 能否用于子会话；provider 注册是插件副作用（须可逆） |
| C. 语义降级 | 不续跑会话，而是把旧成员的输出/失败原因拼进 prompt 重新派发 | 零 DSH 依赖、可离线测；但不是真正的续跑（丢失子代理的中间上下文），且要防止 prompt 膨胀 |

纯逻辑部分与路线无关、届时可直接做：`SwarmTaskKind` 增 `"resume"`、resume 型成员占前段编号、
校验 1 放宽为 `resumeCount > 0 || itemCount >= 2`（见 `src/types.ts` 注释）、XML 补 `mode` 属性；
`resume_agent_ids` 必须属于**本会话**之前的批次（registry 已按会话持有 agentId，可做归属校验）。

## Alternatives considered

- **现在就按路线 C 实现并暴露参数**：否决。C 的语义与"续跑"名不副实，先占用 `resume_agent_ids` 这个名字，
  以后切到 A/B 就是一次对模型的破坏性语义变更。
- **只实现纯逻辑部分、不接运行时**：否决。没有运行时的参数一旦出现在工具描述里，模型就会调用它，
  结果只能是报错——正是前两轮反复出现的"声明与交付不符"。

## Consequences

- spec「交付状态」与 NOTICES 的相关表述已订正；本项继续留在 backlog。
- 若上游行为语义（01-机制文档 的 04 篇）对"续跑"有更具体的约束（例如是否要求同一会话上下文），
  应在 spike 开始前补齐，再据此在 A/B/C 中取舍。

## Confirmation

spike 的验收：在真实 DSH 会话里，对一个**被中断**的成员按所选路线续跑一次，
确认（1）续跑后的成员能看到此前的工作上下文（A/B）或旧输出（C）；（2）XML 中该成员的 agent_id 与 mode 正确。
