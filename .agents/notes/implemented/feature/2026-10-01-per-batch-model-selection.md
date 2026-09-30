# per-call 模型路由：agent_swarm 按批次选模型（白名单权威）

## Problem

swarm 成员是同构苦力，合理的成本结构是「主代理用强模型编排、成员用便宜模型执行」；但一期实现里成员只能继承父 agent 路由或走 config 写死的固定路由——拿 SOTA 模型跑 128 个成员过于奢侈，按批次换模型（这批审查派 Gemini、那批实现派 MiniMax）做不到。这是 Kimi 原版 `model` 参数的对应能力，属 spec 二期 backlog 中最影响使用场景的一项。

## Decision

`agent_swarm` 工具新增可选 `model` 参数，支持两种写法：`"provider/model"` 精确式（按第一个 "/" 切分，model id 自身可含 "/"），或白名单内唯一的裸 model id。路由的**唯一权威源是宿主 `ctx.subagentModelSelection` 服务**（`@deepseek-ai/dsh-tool-subagent/model-selection-settings`，即设置页「子智能体 → Model selection」那份白名单），调用时经 `ctx.get` 现取，插件不自备第二份允许清单。

- 服务未挂载 / `enabled=false` → `MODEL_SELECTION_UNAVAILABLE`；无匹配 → `MODEL_NOT_ALLOWED`（details 附允许清单，截断 20 条）；裸 id 多 provider 命中 → `MODEL_AMBIGUOUS`（details 附候选）。全部在任何子代理启动之前以结构化错误拒绝。
- 优先级：per-call `model` > config `agentOptions` 固定路由 > 缺省继承父 agent。不带 reasoningEffort——`resolveChildAgentOptions` 在路由变更时自动清除父 effort、让新模型解析自己的默认档位。
- 匹配逻辑是纯函数 `validate.ts: resolveSwarmModelRoute`（零 DSH 依赖，可单测）；宿主服务读取与 enabled 判定在 `index.ts`，匹配器永不抛异常（与 validateSwarmInput 同一立意）。
- provider 的 `capabilities.agentOptions` 门槛不做单独预检（服务层无干净 API）：不支持的 provider 会在 start() 被拒，按成员启动失败如实呈现，首批立即可见。
- 批次生效路由同时解析为 `routeLabel` 透传给面板（继承时读父 agent requestHeader/options，读不到留空不猜）。

## Alternatives considered

- **插件自备白名单 config**：与宿主设置页两份权威必然漂移，用户要在两处维护同一份清单——否决（一事一处）。
- **不开白名单、直接透传 provider/model**：正是 spike Q4.3 警示的「模型随意改写路由」，且与宿主「subagent-model-selection 是唯一权威来源」的部署纪律冲突——spike 一期建议（完全不开模型选择）防的是**不做校验的透传**，不是这条「经同一白名单校验」的路径；本决策是对该一期建议的演进而非推翻。
- **开启官方 modelSelectionSettings 让宿主工具层代校验**：那是 tool-subagent 自家工具的装配选项，swarm 插件的工具不在其管线内，够不着——不可行。
- **reasoning_effort 参数一并开放**：换路由后自动取新模型默认档位已是最优默认；开放 effort 只是锦上添花，留给后续真有需求时再加——本期不做。
- **subagent_type 参数**：DSH 没有 Kimi 的 agent profile 对应物，无合法映射目标——留在 backlog 不做。

## Consequences

- **收益**：按批次选模型落地，成员可用便宜模型跑批量；白名单单一权威，部署方在设置页一处维护即同时约束官方 subagent 工具与本插件。
- **代价/边界**：`ctx.subagentModelSelection` 在 host bundle 层的实际可达性依赖宿主组合（dsh-base 是否把该设置服务挂在共享 scope）——不可达时行为是明确的 MODEL_SELECTION_UNAVAILABLE 报错而非误派，但「可达」本身需用户重启 DSH 后实测确认；白名单未开启的部署上 `model` 参数不可用（报错文案已指引开启路径）。
- 面板因此获得批次路由标签（顺带解决「成员看不出用了哪些模型」）。

## Confirmation

- `pnpm test`：250/250 全绿。新增用例：validate.test.ts 的 resolveSwarmModelRoute 七条（精确式/含斜杠 id/裸 id 唯一/歧义/不在名单/畸形入参/清单截断）；plugin.test.ts 的 J 组九条（白名单命中两条、服务未挂载/未开启/不在名单/歧义各一条且零派发、per-call 覆盖 config 固定路由、两条缺省回归）；swarm-registry.test.ts 的 routeLabel 帧透传。
- `pnpm typecheck`：0 错误。
- 实测待办（用户重启 DSH 后）：① 真实会话 `agent_swarm` 传 `model` 验证白名单服务可达与成员实际路由；② 面板头部模型标签与分组折叠目测。
