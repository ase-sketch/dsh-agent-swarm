# dsh-agent-swarm

> [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件：把「一批同形子任务」打包成一个模型可调用的 `agent_swarm` 工具，一次调用展开为 N 个并行子代理，自带渐进放量调度与结果汇总，并附会话标题栏实时状态面板。
>
> 本实现为 clean-room 重写：Kimi Code 桌面版的 swarm 功能**并未开源**，本仓依据逆向分析产出的机制文档（行为描述）重新实现，**未复制任何上游源码与提示词原文**，也不含 Kimi UI 复刻。功能原理与上游对齐，但不声称完整复刻——有意的行为偏离与溯源声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 功能一览

- **`agent_swarm` 工具**：`description` + `prompt_template`（含 `{{item}}` 占位符）+ `items[]`，展开为 2–128 个独立子代理并行执行，结果以 `<agent_swarm_result>` XML 汇总返回
- **八道硬校验**：items ≥ 2、总数 ≤ 128、有 items 必有 template、template 必含占位符、展开后 prompt 互不相同、item 必须是非空字符串；单成员 prompt ≤ 65,536 字符、全批合计 ≤ 1,048,576 字符——全部在启动任何子代理之前拒绝
- **有硬上限的渐进调度**：默认最多同时运行 8 个成员（`maxConcurrency` 可配），首波 5 个、之后每 700ms 放一个；每任务超时（默认 2h 可配）会立即落终态，晚到结果不能覆盖，用户中断级联取消
- **可选限流退避**：`rateLimit.enabled=true` 时启用指数退避、容量收缩防抖与定时恢复；**默认关闭**，真实 429 失败码与子会话事件关联仍待实机确认
- **有界结果汇总**：完整 XML 最多 262,144 字符；超大成员正文或 item 会保留逐项状态并以 `truncated="true"` 和 summary 计数明确标记
- **per-call 模型路由**：可选 `model` 参数按批次指定子代理模型（`provider/model` 或白名单内唯一裸 id），权威源与 DSH 设置页「子智能体 → Model selection」同一份白名单
- **fork 上下文**：可选 `context: "fork"` 让成员以当前会话已完成的轮次为起点（DSH 原生 fork provider），单独封顶（默认 16）且不与 `model` 同用
- **委派深度上限**：成员按宿主子代理深度限制（默认 1）派发，成员内再开 swarm 会在派发前被拒
- **标题栏状态面板**（host/client 双半）：成员按相位四组折叠（进行中/失败/已完成/已取消）、批次路由标签、100ms 合帧 roster 推送
- **可逆挂载**：以自指 bundle 形态安装后，在 DSH 插件管理页可见、可启停、可卸载

> 工具返回的 XML 是成员状态的唯一权威口径，面板只提供过程可见性。

## 安装

需要 DSH 0.2.1-rc.5 或更高版本（developer preview）。

```sh
# 从 git 仓库直接安装
dsh plugin add ase-sketch/dsh-agent-swarm

# 或本地构建后安装
pnpm install && pnpm run build
npm pack            # 产出 dsh-agent-swarm-x.y.z.tgz
dsh plugin add ./dsh-agent-swarm-x.y.z.tgz
```

Git 安装会通过 `prepare` 自动构建 `dist/`。如果安装环境禁用了依赖生命周期脚本，请改用上面的本地构建 tarball 路径。

安装后在 DSH 设置页「插件」中确认启用；桌面端（Electron）需重启应用后生效。

## 使用示例

在会话中让模型调用：

```
description: 批量审查文件
prompt_template: 请审查文件 {{item}}，给出问题清单与修改建议。
items: ["src/a.ts", "src/b.ts", "src/c.ts"]
model: deepseek/deepseek-chat    # 可选：本批次子代理统一走该路由
```

调度参数（`maxConcurrency`、首波数量、放量间隔、超时等）可在插件 config 中调整；限流退避需另行显式开启。

## 开发

```sh
pnpm install        # 装依赖
pnpm test           # 先构建再跑 vitest 全部测试
pnpm typecheck      # tsc --noEmit
pnpm run build      # 编译 host 半 + 预构建 client 半到 dist/
```

- 架构与模块边界：[ARCHITECTURE.md](ARCHITECTURE.md)
- 功能规格与交付状态：[docs/spec.md](docs/spec.md)
- 决策史：[`.agents/notes/`](.agents/notes/)（目录树即索引）

> 注：spec 与 spike 文档中提到的 `../extracted/kimi-code-swarm-analysis/` 为开发期的本地逆向分析资料，按 clean-room 约束不随本仓分发。

## License

[MIT](LICENSE) © ase-sketch。第三方代码与素材的许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

---

# dsh-agent-swarm (English)

> A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that turns a batch of same-shaped subtasks into a single model-callable `agent_swarm` tool: one call fans out into N parallel subagents with progressive scheduling, bounded XML result aggregation, and a live status panel in the session header.
>
> Clean-room reimplementation: Kimi Code's swarm feature is **not open source**; this repo was rebuilt from behavior documentation produced by reverse analysis, with **no upstream source code or prompt text copied** and no Kimi UI replica. Functionally aligned in principle, but not claimed to be a complete replica — intentional deviations and provenance are documented in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Features

- **`agent_swarm` tool**: `description` + `prompt_template` (with a `{{item}}` placeholder) + `items[]`, expanding into 2–128 independent subagents; results returned as an aggregated `<agent_swarm_result>` XML block
- **Eight hard validations**: item count bounds, template/placeholder presence, prompt uniqueness, non-empty string items, at most 65,536 characters per expanded prompt and 1,048,576 across the batch — all rejected before any subagent starts
- **Progressive scheduling with a hard cap**: at most 8 running members by default (`maxConcurrency` is configurable), first wave of 5, then one every 700 ms; per-task timeout (default 2 h) settles immediately and late results cannot overwrite it; user interrupts cascade cancellation
- **Opt-in rate-limit backoff**: exponential backoff and capacity shrink/recovery only when `rateLimit.enabled=true`; **disabled by default**, with real 429 failure-code and child-session event correlation still awaiting live verification
- **Bounded result aggregation**: at most 262,144 characters of XML; oversized member text keeps its per-member state and is explicitly marked with `truncated="true"` plus a summary count
- **Per-call model routing**: optional `model` parameter selects the subagent route per batch, validated against the same allowlist as DSH Settings → Subagents → Model selection
- **Fork context**: optional `context: "fork"` starts every member from the conversation's completed turns (DSH's native fork provider); capped separately (16 by default) and not combinable with `model`
- **Delegation depth limit**: members run under the host's subagent depth limit (1 by default); a nested swarm is rejected before anything starts
- **Header status panel** (host/client halves): members grouped by phase with independent folding, batch route label, 100 ms coalesced roster streaming
- **Reversible mounting**: installs as a self-referential bundle — visible, toggleable and uninstallable in the DSH plugin manager

## Install

Requires DSH 0.2.1-rc.5 or later (developer preview).

```sh
dsh plugin add ase-sketch/dsh-agent-swarm
# Git installs build dist/ via prepare; if dependency lifecycle scripts are disabled,
# build locally instead: pnpm install && pnpm run build && npm pack
# then: dsh plugin add ./dsh-agent-swarm-x.y.z.tgz
```

## Development

```sh
pnpm install && pnpm test   # build + full vitest suite
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for module boundaries and [docs/spec.md](docs/spec.md) for the full spec.

## License

[MIT](LICENSE) © ase-sketch. Third-party attributions: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
