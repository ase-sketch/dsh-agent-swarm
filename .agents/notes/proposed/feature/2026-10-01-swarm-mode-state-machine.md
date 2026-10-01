# 模式状态机（enter/exit 提示词注入 + 轮末自动退出）：延后，先补行为描述

## Problem

二期 backlog 的「模式状态机」：进入某种 swarm 模式时向模型注入额外指引，轮末自动退出。
本仓没有上游该机制的行为描述（01-机制文档 不随仓分发），进入条件、注入职责、退出时机都无从核对；
现在动手只能靠猜，且注入文本必须自拟（clean-room：不得参考上游提示词原文）。

## Decision

本轮**不实现**，只登记已核实可用的 DSH 原语与一条必须先定的取舍，等行为描述到位后做 spike：

- 注入：`ctx.systemPrompt.section({ name, order, text: (assembleContext) => ... })`（按 scope 动态求值，
  空文本不贡献内容）或 `ctx.systemPrompt.context(...)`（以 user 角色快照注入）；一次性指令可用
  `ToolRunContext.deferContext()` 跟在工具结果之后（`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-tools` 类型声明）。
- 退出：`session/event` 中的 `turn/end`（与限流接线同一条事件流）。
- **取舍**：在轮次之间切换 system section 会让整段会话的前缀 KV cache 失效；倾向用 `context` 或
  `deferContext` 注入，把变化放在前缀之后。

## Alternatives considered

- **按猜测的语义先实现**：否决——一旦语义与上游不符，就会在模型侧造成难以回收的行为差异。

## Consequences / Confirmation

需要的输入：01-机制文档 中该状态机的进入条件、注入的职责（不要原文）、退出时机。拿到后：
状态机本体写成纯逻辑模块（可离线单测），注入与退出接线放宿主层，注入文本自拟。
