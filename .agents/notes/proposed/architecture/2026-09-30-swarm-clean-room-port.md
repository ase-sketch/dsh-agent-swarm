# Kimi swarm clean-room 移植为 DSH 插件

## Problem
Kimi Code 的 swarm（AgentSwarm）批量子代理能力在 DSH 上不存在；希望以可公开分发的 DSH 插件形态获得同等能力。源资料为逆向产物，其中 v2 部分无许可证。

## Decision
以 clean-room 方式重写：实现仅依据 01-机制文档（行为描述）与 MIT 许可的 v1/协议层代码；02-v2源码 与 Kimi 提示词原文对实现者封存。插件 = host 半 `agent_swarm` 工具 + 依赖注入式纯函数调度器；子代理派发走官方 `ctx.subagents.start()`；UI 原拟复用官方智能体团队面板；spike（docs/spike-dsh-api.md Q10）证实该面板主动过滤 one-shot 子会话，不可达成 → 经用户确认改为**自研 client 面板**（M4，host/client 双半自有事件桥）。五项实现决策：D1 工具自动批准+子代理审批继承父档位；D2 spawn 一律 one-shot（避开 continuable 池 maxActiveSubagents=8 上限），resume 二期才用 continuable；D3 结果保留 XML 外形但 body/属性全转义、编号一致（规避 Kimi 已核实缺陷 D13/D14）；D4 工具描述文本全部重写；D5 调度参数全部进插件 config、默认值照 Kimi 实测（首波5/700ms/3000ms×2ⁿ/防抖2s/恢复180s/超时2h）。

## Alternatives considered
- 直接编译移植 v2 还原源码：依赖 Kimi 私有 DI 服务（ISessionSwarmService 等 7 个）在 DSH 不存在，且无许可证不可公开分发——否决。
- 完整复刻含 UI 卡片：工作量大 2-3 倍且官方团队面板已覆盖可视化需求——否决。
- 做成 skill/编排规则而非插件：调度器需要执行代码与定时器，自然语言表达不了——否决。
- 结果格式改 JSON：模型可读性与原文档生态不如 XML，且 XML 缺陷可通过转义修复——保留转义 XML。

## Consequences
收益：公开分发无法律障碍；纯函数核心可脱离 DSH 单测。代价：无法逐行对照 v2 实现细节，行为保真度依赖机制文档质量；DSH 0.2 API 漂移风险由版本兼容声明与 spike 文档对冲。

## Confirmation
M1/M2 测试三层（纯函数/契约/真实 Loader）；M3 真实会话验收（3 任务批量 + 团队面板可见性）。缺陷规避由 XML 转义往返测试与编号一致性测试持续守护。

## 决策演进（spike 后回写）

- 自动批准：spike Q8 证实 DSH 无 approvalRule 声明机制，不调 ctx.approval 即不弹窗——D1 落地方式从「声明白名单」简化为「零声明」。
- 限流判定：in-process 子代理结果不透传错误码（只给 stopReason），退避触发改走子会话 `llm/retry` 事件监听（failure.code === "RATE_LIMIT"），R1 待实机验证。
- 超时：start() 无 timeout 字段，插件自建 AbortSignal.any 级联；start()/dispose() 必须配对。
