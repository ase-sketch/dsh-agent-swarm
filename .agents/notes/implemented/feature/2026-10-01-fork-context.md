# fork 上下文：agent_swarm 可选 context: "fork"（映射 DSH 原生 fork provider）

## Problem

二期 backlog 的 fork：成员默认从空白会话起步，只看得到自己的 prompt；当一批子任务需要"在这段对话的基础上"
继续（例如对刚讨论完的方案分头做 N 份审查），调用方只能把上下文手工塞进 prompt_template，既冗长又容易漏。

## Decision

新增可选参数 `context`：`"fresh"`（缺省，原行为）| `"fork"`。`fork` 时成员改由 `config.forkProvider`
（缺省 `"fork"`）派发——即 DSH 原生的 `@deepseek-ai/dsh-subagent-fork-in-process`：子代理以调用方会话
**已完成的轮次**为种子（当前进行中的轮次不含在内，所以成员看不到这次 agent_swarm 调用本身），其余行为与 spawn 一致
（依据其 README「What a fork delegation does」与 `lib/index.js` 的 `completedTurnPrefix`）。

整体拒绝（都在开批次之前、零派发）：
- `CONTEXT_MODE_INVALID`：取值不是 fresh / fork；
- `FORK_MODEL_CONFLICT`：fork 与 per-call `model` 同时出现。fork 的价值在于复用父会话的 KV cache 前缀，
  换路由会让继承的历史整段重算；DSH 官方 fork 工具同样不开放路由选择（其 README Known Limitations）。
  插件 config 里的固定路由（agentOptions）是部署方决定，fork 时照常生效；
- `FORK_UNAVAILABLE`：宿主没挂 fork provider（`ctx.subagents.getProvider` 查不到）；
- `TOO_MANY_SUBAGENTS`（details.context = "fork"）：fork 批次单独封顶 `maxForkItems`（缺省 16，且不超过通用生效上限），
  因为每个成员都复制一份父会话历史，成本 ≈ 成员数 × 历史长度。工具描述与参数描述写的是同一个生效值。

## Alternatives considered

- **布尔参数 `fork: true`**：否决。`context` 枚举给将来的其它起始上下文（例如只继承摘要）留了位置，
  且 "fresh" / "fork" 在描述里自解释。
- **自己拼父会话历史进 prompt**：否决。要读父会话事件（同步读 API 已废弃）、要处理平衡/截断，
  而 DSH 已有经过验证的 fork provider。
- **fork 时允许 per-call model**：否决，理由见 FORK_MODEL_CONFLICT。
- **不单独封顶、沿用 maxItems（128）**：否决。128 份完整会话历史的成本数量级失控；16 是保守缺省，部署方可调。

## Consequences

- 与上游 swarm 的 fork 语义是否等价**未核实**：本仓没有 01-机制文档 的行为描述可对照，这里交付的是 DSH 原生语义。
  若上游语义不同（例如继承范围或是否共享工具权限），应据行为描述调整，而不是声称已对齐。
- fork 子代理的深度限制、沙箱与审批继承与 spawn 一致（fork provider 声明了与 spawn 相同的能力集）。

## Confirmation

- 离线：`tests/plugin.test.ts` M 组 7 条、Config 1 条；`tests/validate.test.ts` 的 resolveSwarmContextMode 2 条。
- 待实机验证：用户 profile 是否挂载 fork provider 及其 providerName；并行 fork 成员的 KV cache 复用与成本实测。
