# 实机验证记录（v0.4.0，2026-10-01）

> 验证环境：DSH 0.2.0-rc.2，web profile，插件以合并后 master（5169769）打包安装。
> 验证会话：`session-cc37da5d-ac49-4865-a50a-d083354ff056`（4 轮，模型 MiniMax-M3.1-Flash-Preview）。
> 证据来源：会话 projcache 投影（`turnOutline` / `contextTimeline` 摘要）。
> 注意：本记录只区分「已实机验证」与「待验证」，不把推断写成结论。

## 已验证 ✅

| 项 | 预期 | 实机结果 |
|---|---|---|
| ① 基本盘：批次调度 + XML 汇总 | 3 成员完成、编号不错位 | `<summary>completed: 3</summary>`，编号对齐正常 |
| ② 错误可见性（高危修复 2） | 白名单外模型被拒且模型可见错误码与白名单 | `model: "openai/gpt-5"` → `[MODEL_NOT_ALLOWED]` + 完整白名单回显 |
| ③ fork 上下文 | `context: "fork"` 批次可跑通 | 通过（fork provider 已挂载且可用） |

会话最终结论原文：「验收结论：agent_swarm 三项验证全部通过（已验证，非推断）」。

## 待验证（未覆盖，后续补测）

按 PR #1「待实机验证」清单与规格 M3/M5 逐项核对，以下仍**未验证**：

1. **嵌套 swarm 深度拒绝**：swarm 成员会话内再调 `agent_swarm` 应返回 `DELEGATION_DEPTH_EXCEEDED`（高危修复 1 的实机面）。
2. **中断语义**：批次中途用户中断 → XML 成员标 `aborted`，且与 registry/面板口径一致。
3. **多批次并发**：同一条消息两次调用 `agent_swarm` → 面板可切换批次（`visibleSwarmIds`）、徽标聚合。
4. **面板 i18n**：切换宿主语言后组件文案是否走注入的 `t`。
5. **desktop（Electron）端**：插件管理页条目可见/可启停；标题栏面板渲染。
6. **限流接线三假设**（开启 `rateLimit.enabled` 之前必须逐条确认）：
   - 插件级 `session/event` 监听能否收到子会话事件；
   - 真实 429 下 `turn/end` 的 `reason.error.code` 取值；
   - 子会话 id 是否等于 `run.id`；`maxRetries` 按实际 429 分布校准。
7. **fork 细节**：fork 成员以已完成轮次为种子的实际观感与成本。

## 备注

- 面板在 ① 中已随批次出现（会话内有徽标与弹层交互），但「分组折叠/滚动/路由标签」的逐项目测未单独记录。
- 限流开关保持默认关闭；上述第 6 项确认前不得在配置中开启。
