# dsh-agent-swarm

> [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件：把「一批同形子任务」打包成一个模型可调用的 `agent_swarm` 工具，一次调用展开为 N 个并行子代理，自带自适应限流调度与结果汇总，并附会话标题栏实时状态面板。
>
> 本实现为 clean-room 重写：Kimi Code 桌面版的 swarm 功能**并未开源**，本仓依据逆向分析产出的机制文档（行为描述）重新实现，**未复制任何上游源码与提示词原文**，也不含 Kimi UI 复刻。功能原理与上游对齐，但不声称完整复刻——有意的行为偏离与溯源声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 功能一览

- **`agent_swarm` 工具**：`description` + `prompt_template`（含 `{{item}}` 占位符）+ `items[]`，展开为 2–128 个独立子代理并行执行，结果以 `<agent_swarm_result>` XML 汇总返回
- **六道硬校验**：items ≥ 2、总数 ≤ 128、有 items 必有 template、template 必含占位符、展开后 prompt 互不相同、item 必须是非空字符串——全部在启动任何子代理之前拒绝
- **自适应并发调度**：首波 5 并发、之后每 700ms 放一个、限流指数退避、容量收缩防抖与定时恢复、每任务超时（默认 2h 可配）、用户中断级联取消
- **per-call 模型路由**：可选 `model` 参数按批次指定子代理模型（`provider/model` 或白名单内唯一裸 id），权威源与 DSH 设置页「子智能体 → Model selection」同一份白名单
- **fork 上下文**：可选 `context: "fork"` 让成员以当前会话已完成的轮次为起点（DSH 原生 fork provider），单独封顶（默认 16）且不与 `model` 同用
- **委派深度上限**：成员按宿主子代理深度限制（默认 1）派发，成员内再开 swarm 会在派发前被拒
- **标题栏状态面板**（host/client 双半）：成员按相位四组折叠（进行中/失败/已完成/已取消）、批次路由标签、100ms 合帧 roster 推送
- **可逆挂载**：以自指 bundle 形态安装后，在 DSH 插件管理页可见、可启停、可卸载

> 工具返回的 XML 是成员状态的唯一权威口径，面板只提供过程可见性。

## 安装

需要 DSH 0.2（developer preview）。

```sh
# 从 git 仓库直接安装
dsh plugin add ase-sketch/dsh-agent-swarm

# 或本地构建后安装
pnpm install && pnpm run build
npm pack            # 产出 dsh-agent-swarm-x.y.z.tgz
dsh plugin add ./dsh-agent-swarm-x.y.z.tgz
```

安装后在 DSH 设置页「插件」中确认启用；桌面端（Electron）需重启应用后生效。

## 使用示例

在会话中让模型调用：

```
description: 批量审查文件
prompt_template: 请审查文件 {{item}}，给出问题清单与修改建议。
items: ["src/a.ts", "src/b.ts", "src/c.ts"]
model: deepseek/deepseek-chat    # 可选：本批次子代理统一走该路由
```

调度参数（首波并发、放量间隔、退避基数、超时等）可在插件 config 中调整，默认值见 `src/types.ts`。

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

> A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that turns a batch of same-shaped subtasks into a single model-callable `agent_swarm` tool: one call fans out into N parallel subagents with adaptive rate-limit scheduling, XML result aggregation, and a live status panel in the session header.
>
> Clean-room reimplementation: Kimi Code's swarm feature is **not open source**; this repo was rebuilt from behavior documentation produced by reverse analysis, with **no upstream source code or prompt text copied** and no Kimi UI replica. Functionally aligned in principle, but not claimed to be a complete replica — intentional deviations and provenance are documented in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Features

- **`agent_swarm` tool**: `description` + `prompt_template` (with a `{{item}}` placeholder) + `items[]`, expanding into 2–128 independent subagents; results returned as an aggregated `<agent_swarm_result>` XML block
- **Six hard validations** (item count bounds, template/placeholder presence, prompt uniqueness, non-empty string items) — all rejected before any subagent starts
- **Adaptive concurrency scheduling**: first wave of 5, then one every 700 ms, exponential backoff on rate limits, capacity shrink/recovery, per-task timeout (default 2 h, configurable), cascading cancellation on user interrupt
- **Per-call model routing**: optional `model` parameter selects the subagent route per batch, validated against the same allowlist as DSH Settings → Subagents → Model selection
- **Fork context**: optional `context: "fork"` starts every member from the conversation's completed turns (DSH's native fork provider); capped separately (16 by default) and not combinable with `model`
- **Delegation depth limit**: members run under the host's subagent depth limit (1 by default); a nested swarm is rejected before anything starts
- **Header status panel** (host/client halves): members grouped by phase with independent folding, batch route label, 100 ms coalesced roster streaming
- **Reversible mounting**: installs as a self-referential bundle — visible, toggleable and uninstallable in the DSH plugin manager

## Install

Requires DSH 0.2 (developer preview).

```sh
dsh plugin add ase-sketch/dsh-agent-swarm
# or build locally: pnpm install && pnpm run build && npm pack
```

## Development

```sh
pnpm install && pnpm test   # build + full vitest suite
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for module boundaries and [docs/spec.md](docs/spec.md) for the full spec.

## License

[MIT](LICENSE) © ase-sketch. Third-party attributions: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
