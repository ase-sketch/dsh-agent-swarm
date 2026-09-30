# DSH 插件集成契约 Spike（只读调研）

> 目标地基：`@deepseek-ai/*` **0.2.0-rc.2**（本机 asar 实例）。
> 证据根目录：`<dsh 安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/`
> 所有行号均为该根目录下相对行号，可直接复核。本文档为纯 DSH 契约调研，不含任何 Kimi 逆向源码内容。
>
> 注：本文刻意不记录任何本机绝对路径（用户名 / 安装位置），以便随仓库分发与复核。
> 需要复现时，在本机 DSH 安装目录下定位 `resources/app.asar/dsh/node_modules/@deepseek-ai/`
> 即可得到同一根目录，行号可直接对照。npm 上同版本 `@deepseek-ai/*` 包的行号可能不同，请以本地实例为准。

---

## 结论先行（10 问逐条）

| # | 问题 | 结论 | 等级 |
|---|---|---|---|
| 1 | inject 服务 key | 确定：只需 `["tools","subagents"]` | ✅ |
| 2 | `start()` 契约 | 确定：request 字段齐；返回 run 对象需显式 dispose | ✅ |
| 3 | one-shot 并发上限 | **不受 maxActiveSubagents=8 限制**（仅限 continuable） | ✅ |
| 4 | agentOptions 覆盖 | 确定：4 字段，需 provider capability | ✅ |
| 5 | signal 取消 | 确定：落 `stopReason:"aborted"` | ✅ |
| 6 | 429/限流透传 | ⚠️ **重灾区：in-process 路径不暴露 diagnostic/错误码** | ⚠️ |
| 7 | defineTool 形态 | 确定：`required` 仅布尔；render 两参 | ✅ |
| 8 | 自动批准 | 确定：**无 approvalRule 字段，不调 ctx.approval 即不弹审批** | ✅ |
| 9 | 会话/父代理上下文 | 确定：`exec.agent` 为完整 Agent；沙箱档位自动继承 | ✅ |
| 10 | 团队面板可见性 | ❌ **否定：one-shot 不进 agent-team 面板** | ✅（与 spec 冲突）|

**一句话总结：** 集成骨架可行，但两条前提假设必须改或验证——**（1）限流判定写不了**（见 Q6），**（2）"成员在智能体团队面板可见"这个 M3 验收项当前不成立**（见 Q10）。

---

## Q1 · 插件 inject 哪些服务 key

**结论：** 从 `dsh-tool-subagent` 直接抄录。

```js
const name = "tool-subagent";                                    // :245
const inject = [
`	"tools",`                                                     // :247
`	"subagents",`                                                 // :248
`	"systemPrompt",`                                              // :249
`	"sessionProjections"`                                         // :250
];
```
证据：`@deepseek-ai/dsh-tool-subagent/lib/index.js:245-251`

本插件实际只需前两个（注册工具 + 派发子代理）：

```ts
export const inject = ["tools", "subagents"] as const;
```

补充：该包的 scoped 二次 inject（模型选择路径）只申请三个 → `@deepseek-ai/dsh-tool-subagent/lib/index.js:626-632`

**注意：** 官方包没有在缺失任一者时降级的代码路径，二者均视为必需。

---

## Q2 · ctx.subagents.start(provider, request) 契约

### 2.1 调用形态

```js
const run = await ctx.subagents.start(config.provider, {
`	...request,
`	signal: exec.signal
});
```
证据：`@deepseek-ai/dsh-tool-subagent/lib/index.js:557-560`

**关键：返回的是 run 对象而非结果——它带一个 result Promise 属性，且必须显式 dispose。**
语义见 `@deepseek-ai/dsh-subagent/README.md:83`："Fulfillment is publication. A provider's start() fulfills only after a real child exists."

### 2.2 request 完整字段

官方包构造 request 的完整代码：

```js
const request = {
`	label: args.description,`                         // :510
`	prompt: [{ type: "text", text: args.prompt }],`  // :511-514
`	parent,`                                           // :515  必填
`	...requestedChildAgentOptions !== void 0 ? { agentOptions: requestedChildAgentOptions } : {},
`	...config.persona   !== void 0 ? { persona: config.persona } : {},
`	...config.toolFilter !== void 0 ? { toolFilter: config.toolFilter } : {},
`	...maxDepth !== void 0 ? { maxDepth } : {}`         // :516-519
};
// 调用时再补： signal: exec.signal                       // :559
```
证据：`@deepseek-ai/dsh-tool-subagent/lib/index.js:509-520, 557-560`

| 字段 | 必填 | 说明 | 证据 |
|---|---|---|---|
| `parent` | 是 | 父 Agent，从 `exec.agent` 取；缺则抛错 | tool-subagent:491-492, 515 |
| `prompt` | 是 | 内容块数组，官方用 `[{type:"text",text}]` | tool-subagent:511-514 |
| `signal` | 是 | AbortSignal，driver 直接读 `request.signal.aborted` | driver:163, 187 |
| `label` | 否 | 显示用标签，进 catalog | tool-subagent:510 |
| `agentOptions` | 否 | 覆盖子代理 LLM 路由 | tool-subagent:516 |
| `persona` | 否 | 子代理人设 | tool-subagent:517 |
| `toolFilter` | 否 | 子代理工具 allow/deny | tool-subagent:518 |
| `maxDepth` | 否 | 递归深度预算 | tool-subagent:519 |
| `outputSchema` | 否 | 结构化输出（需 provider 能力） | driver:177 |

> **本插件一期不用的字段：** 无 `timeout` 参数。start 请求**不含 timeout 字段**，超时必须自行用 `AbortSignal.timeout(ms)` 实现（见 Q5）。

### 2.3 返回值：run 对象

证据：`@deepseek-ai/dsh-subagent-in-process-driver/lib/index.js:218-228`

```js
return {
`	id: childId,`          // :219  run.id
`	localAgent: child,`    // :220  子代理 Agent 本体
`	result,`               // :221  Promise<SubagentResult>
`	async dispose() { ... }`  // :222-227  必须调用
};
```

### 2.4 settle 形态：官方统一转段函数

```js
function runOutcome(result) {
`	switch (result.stopReason) {
`		case "completed":  return { status: "completed", result: finalText(result.output) };
`		case "aborted":    return result.diagnostic === undefined
`		                   ? { status: "killed" }
`		                   : { status: "failed", detail: failureDetail(result) };
`		case "error":
`		case "max-tokens":
`		case "refusal":    return { status: "failed", detail: failureDetail(result) };
`		default:           return { status: "failed", detail: failureDetail(result) };
`	}
}
export async function settleRun(run) { ... }   // :53
```
证据：`@deepseek-ai/dsh-subagent/lib/types/run-settlement.js:30-46, 53-69`

失败详情拼接格式：`${stopReason}; diagnostic: ${diagnostic}`（无 diagnostic 时为纯 stopReason）
证据：`run-settlement.js:16-21`

**官方前台另一套等价转段**（搭配上游代码直接用）：
```js
function stopReasonError(result) {          // tool-subagent:287-296
`	case "aborted":    return "subagent run was cancelled";
`	case "error":      return "subagent run failed";
`	case "max-tokens": return "subagent run hit its token limit before finishing";
`	case "refusal":    return "subagent declined the task";
`	default:           return `subagent run ended abnormally (...)`;
}
```
证据：`@deepseek-ai/dsh-tool-subagent/lib/index.js:286-309`

### 2.5 成功结果完整字段

```js
return { output, stopReason };              // driver:248-251
return { output, structured, stopReason };  // driver:238-242
```
- `output`：内容块数组（每项 `{type:"text", text}`）
- `stopReason`：见下
- `structured`：仅当传了 `outputSchema` 时存在
- `diagnostic`：**in-process 路径不会出现**（见 Q6）

证据：`@deepseek-ai/dsh-subagent-in-process-driver/lib/index.js:231-252`

**stopReason 完整枚举：** `completed | aborted | error | max-tokens | refusal` + 合并可扩展的 default 分支。
证据：`dsh-subagent-in-process-driver/lib/index.js:125-133`
---

## Q3 · one-shot 是否受 maxActiveSubagents=8 限制

**结论：受限的只有 continuable。one-shot 完全在限制之外。**

README 明说：
> "One-shot and external-provider runs are outside this limit."
> —— `@deepseek-ai/dsh-subagent/README.md:51`

源码侧确认（该值只流经 continuable 路径）：

| 行号 | 代码 | 含义 |
|---|---|---|
| `dsh-subagent/lib/index.js:759` | `maxActiveSubagents;` | 字段声明在 `ContinuableActivationRegistry` 类内 |
| `:783` | `constructor(ctx, observeActivation, maxActiveSubagents)` | 仅注入该类 |
| `:970` | `const releaseSlot = pool.reserve(this.maxActiveSubagents());` | 唯一执行限制的地点 |
| `:1659` | `constructor(ctx, host, maxActiveSubagents)` | 只被 `SubagentContinuationManager` 消费 |

one-shot 执行入口 `startInProcessRun`（`dsh-subagent-in-process-driver/lib/index.js:161-190`）全程**无任何 reserve/semaphore 调用**，直接 `parent.ctx.agents.create({...})`。

其他相关行为（README:53, 55）：限制池是进程内的，不约束 Session 历史与 token；满了不排队，直接拒绝并抛 `ACTIVATION_LIMIT_REACHED`。

> **对调度器的含义：** 首波 5 并发、放量节奏、能力收缩全部由**插件自己**实现，DSH 不会拒绝第 6 个 one-shot。这也意味着调度器必须自行防止过载——限流反压入口在你这里，不在 DSH。

---

## Q4 · agentOptions 支持哪些覆盖 + 能力门槛

**四个字段：** `provider` / `model` / `reasoningEffort` / `maxTokens`（输出 token 上限）。

官方 config schema：
```js
agentOptions: z.object({
`	provider: z.string(),
`	model: z.string(),
`	reasoningEffort: z.string().min(1),
`	maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
}).default(void 0),
```
证据：`@deepseek-ai/dsh-tool-subagent/lib/index.js:258-263`；表格见 `@deepseek-ai/dsh-tool-subagent/README.md:50`

### 4.1 能力门槛

使用 `agentOptions` **必须** provider 声明 `capabilities.agentOptions === true`：
```js
if (config.agentOptions !== void 0 && !subagentProvider.capabilities.agentOptions)
`	throw new Error(`tool-subagent: provider "${subagentProvider.name}" does not support child agentOptions`);
```
证据：`@deepseek-ai/dsh-tool-subagent/lib/index.js:378-379`

`spawn` provider 声明了全部五项能力：
```js
capabilities = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true };
```
证据：`@deepseek-ai/dsh-subagent-spawn-in-process/lib/index.js:22-29`

对照：进程外后端全是 `false`，服务层会在 `start` 之前直接拒绝——"never accepted-then-ignored"。
证据：`@deepseek-ai/dsh-subagent/lib/index.js:2517-2529`

### 4.2 继承与覆盖规则
```js
function resolveChildAgentOptions(parent, requested, childDepth) {
`	const parentOptions = parentAgentOptionsForDelegation(parent);
`	const resolved = { ...parentProvider?, ...parentModel?, ...parentReasoningEffort?, ...parentMaxTokens?,
`		...requested,`            // :447  请求值覆盖父值
`		subagentDepth: childDepth
`	};
`	// :450 改路由但未显式给 effort 时，删掉继承的 effort
`	if ((resolved.provider !== parentProvider || resolved.model !== parentModel) && requested?.reasoningEffort === undefined)
`		delete resolved.reasoningEffort;
`	return resolved;
}
```
证据：`@deepseek-ai/dsh-subagent/lib/index.js:436-452`

**要点：** 不传 `agentOptions` 子代理自动继承父的 provider/model/effort/maxTokens；传了就是"父值 + 覆盖"的合并，且改路由会丢旧 effort。

### 4.3 额外的路由白名单约束

若开启 `modelSelectionSettings`，模型选择会做**会话级白名单**校验：
```js
throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session`);
```
证据：`@deepseek-ai/dsh-tool-subagent/lib/index.js:91-98`；白名单持久化于 `subagent/model-selection-policy` 事件（`:232`）。

> **一期建议：** 完全不开 `modelSelectionSettings`，子代理路由写死在插件 config 的 `agentOptions` 里。这样路由不会被模型随意改写，也不会命中白名单拒绝。

---

## Q5 · signal 取消语义

**结论：中断后 run 仍然 settle，stopReason 为 `"aborted"`，且未完成时不会丢掉已有输出。**

机制：
```js
const flags = { cancelled: false };
const onAbort = () => { flags.cancelled = true; child.cancel({ kind: "parent" }); };
signal.addEventListener("abort", onAbort, { once: true });
if (signal.aborted) onAbort();     // :198-203
```
证据：`@deepseek-ai/dsh-subagent-in-process-driver/lib/index.js:197-203`

结果映射：
```js
const recorded = toStopReason(lastEnd?.data.reason);
const stopReason = cancelled && recorded !== "completed" ? "aborted" : recorded;  // :235-236
```
证据：`@deepseek-ai/dsh-subagent-in-process-driver/lib/index.js:235-236`

三条异常路径要区分（影响调度器的超时设计）：

| 情况 | 行为 | 证据 |
|---|---|---|
| signal 在发布前已 aborted | `start()` 直接 **throw** | driver:163 |
| 发布后 abort | 子代理取消，settle 为 `aborted` | driver:198-203, 236 |
| 已 completed 后 abort | 仍为 `completed`（不被追溯取消） | driver:236 |

**超时实现结论：** 请求对象无 `timeout` 字段，每个任务的 2h 超时必须自建：
```ts
const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(2*60*60*1000)]);
const run = await ctx.subagents.start(provider, { ...request, signal });
```
官方未提供子代理级 timeout——**这是一期需自行实现的一处空白**。

取消后的资源清理：`settleRun` 会自动 `dispose()`（run-settlement.js:62）；但若你自己管理 run，仍须在 finally 中 `dispose()`，否则泄漏。

---

## Q6 · 限流 / 429 如何透传到 start() 的失败结果 ⚠️

**结论：在 `spawn`（in-process）one-shot 路径上，限流信息会在两层被吃掉，父工具拿不到稳定的限流信号。**

### 6.1 第一层：子代理内部会自己重试

`RATE_LIMIT` 是稳定错误码，属于默认可重试集：
```js
const DEFAULT_RETRYABLE_CODES = Object.freeze([
`	EMPTY_RESPONSE_CODE, "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT",
]);
```
证据：`@deepseek-ai/dsh-llm/lib/types/retry-policy.js:16-22`

默认参数：`maxRetries=5`、`initialDelayMs=500`、`maxDelayMs=10000`、`jitterRatio=0.1`。
证据：`@deepseek-ai/dsh-llm/lib/types/retry-policy.js:12-15`

429 → `RATE_LIMIT` 的映射（DeepSeek 适配器）：
```js
else if (isQuotaExceededError(detail) || status === 402) code = "QUOTA";
else if (status === 429 || type === "rate_limit_error") code = "RATE_LIMIT";
else if (isContextWindowExceededError(detail)) code = "CONTEXT_WINDOW_EXCEEDED";
```
证据：`@deepseek-ai/dsh-llm-deepseek/lib/index.js:1750-1755`；同族映射见 `:584`（Files API）；按 code 路由而非解析 message 的建议见 `@deepseek-ai/dsh-llm/lib/types/error.js:13`。

重试引擎路径：
```js
} else if (!policy.retryableCodes.includes(failure.code)) return next();   // :160
...
if (failure.providerRetryAfterMs !== void 0 && ...) delayMs = failure.providerRetryAfterMs;  // :168-171
else delayMs = localDelay(policy, retry, random);                          // :172
```
证据：`@deepseek-ai/dsh-llm-retry/lib/index.js:151-173`

→ **子代理内部最多自己重试 5 次（退避到 10s 上限），总耗时可达 30s+。父工具在这期间什么也拿不到。**

重试事件可从子会话日志的 `llm/retry` / `llm/retry-started` 事件直接观测。
证据：`@deepseek-ai/dsh-llm-retry/lib/index.js:141-148`，投影名 `llmRetry`（`:89`）。

### 6.2 第二层：result 里没有错误码

当重试耗尽，agent-loop 把错误写入 turn/end（**code 在这里**）：
```js
turnEnds = {
`	kind: "error",
`	error: error instanceof LlmError ? error.failure : { message: errorChain(error), code: "UNKNOWN" }
};
```
证据：`@deepseek-ai/dsh-agent-loop/lib/index.js:1017-1021`

但子代理结果的读取只取 **kind**，**丢掉 code 和 message**：
```js
function toStopReason(reason) {
`	switch (reason?.kind) {
`		case "completed":  return "completed";
`		case "max-tokens": return "max-tokens";
`		case "aborted":    return "aborted";
`		case "blocked":    return "refusal";
`		default:           return "error";`     // → 信息丢失
`	}
}
...
return { output, stopReason };    // :248-251  没有 diagnostic 字段
```
证据：`@deepseek-ai/dsh-subagent-in-process-driver/lib/index.js:125-133, 248-251`

全局搜索验证：在整个 `dsh-subagent-in-process-driver` 与 `dsh-subagent-spawn-in-process` 中，`diagnostic` 字段**从未被赋值**。只有 `dsh-subagent/lib/index.js:2493-2516` 定义了它的 4KB 截断上限——那是**为进程外后端准备的**，in-process 路径不走。

### 6.3 结论与影响

| 情况 | 父工具能看到吗 |
|---|---|
| 限流、重试次数未耗尽 | 什么都看不到（子代理内部恢复成功） |
| 重试耗尽 | 只看到 `stopReason:"error"`，无 diagnostic、无 code |
| 尝试区分限流 vs 其他错误 | **不可能** |

**因此一期调度器的限流判定函数必须换路。**

### 三条可行路径（按优先级）

1. **监听子会话的 `llm/retry` 事件（推荐）**
   每个子代理都有 sessionId（= run.id），可绕过 result 直接观测限流事件。
   事件名固定为 `llm/retry`（`dsh-llm-retry/lib/index.js:141`），数据含 `{retryId, turn, step, provider, mode, policyKey, retry, maxRetries, delayMs, failure}`（`:119-140`）。
   需确认 `failure.code === "RATE_LIMIT"` 可用。
2. **降配 retryPolicy**：在子代理的 LLM provider 配置上把 `maxRetries` 设小，让限流快速浮到父层。
   但这改变子代理行为，需权衡与兼容性评估。
3. **保守建议：调度器改用时间 + 子代理存活率作为反压信号**，而非声称"检测 429"。

> 此项为 **待实机验证**：需真实触发一次限流，从子会话日志确认 `llm/retry` 的 `failure.code` 字段实际取值。
---

## Q7 · defineTool 完整必填形态

### 7.1 必填字段
```ts
defineTool({
`	name: string,`          // 必填
`	description: string,`   // 必填
`	parameters: {...},`     // 必填，所有字段在此声明
`	output: { schema, render },`  // 必填
`	execute(args, exec)`    // 必填
});
```
证据：`@deepseek-ai/dsh-tools/lib/index.js:838-850, 851-871`

可选字段：`timeoutMs`（必须正有限数，否则启动即报错，`:847`）、`deferLoading`、`isConcurrencySafe`、`finalizeContent`、`projectContent`、`presentCall`、`presentResult`、`output.presentationMeta`。
证据：`dsh-tools/lib/index.js:864-885`

### 7.2 扁平字段映射规则（required 只能 true）

**结论：是的——`required` 只能取布尔 `true`。标记为 true 的字段一律被收集进 schema 的 `required` 数组；不接受数组等其他形式。**

实现只挑选 `required === true`：
```js
const schema = {
`	type: "object",
`	properties: compiled.properties,
`	...compiled.required === void 0 ? {} : { required: compiled.required }
};
```
证据：`@deepseek-ai/dsh-tools/lib/index.js:802-811`（由 `compilePropertyMap(spec, "parameters")` 产生，`:803`；`compilePropertyMap` 注释 "collecting per-property requiredness" 见 `:755-756`）

官方参考写法全是布尔式：`{ type:"string", required: true, description:"..." }`。
证据：`@deepseek-ai/dsh-tool-subagent/lib/index.js:402-411`

使用建议：需要数组/对象参数时使用 `type:"array"` / `type:"object"` 的嵌套形式（参考 tool-subagent 的 `output.schema` 用了 `items: { type: "json" }`，`:479`）。

### 7.3 output.schema 与 output.render 签名
```ts
output: {
`	schema: <JSON Schema>,`   // 必填，经 compileValueSchema + assertSupportedJsonSchema
`	render: (args, value) => ContentBlock[]`  // 必填，两参数
}
```
证据：`@deepseek-ai/dsh-tools/lib/index.js:849, 855-863`

- `render(args, value)`——**两个参数**（调用方完整转发：`args` 为模型原始参数，`value` 为 execute 返回值，允许为"旧日志中已不同的实际输出"，见 `:834-835`）。
- 返回值是内容块数组：`[{ type: "text", text: ... }]`。证据：`@deepseek-ai/dsh-tool-subagent/lib/index.js:484-487`
- 官方示例包含 `oneOf` 分支（background / continuable / foreground 三种），可直接借鉴。证据：`@deepseek-ai/dsh-tool-subagent/lib/index.js:431-483`

### 7.4 工具返回 isError 的形态

**结论：execute 本身不返回 `isError`。失败就是抛异常。**

- defineTool 包装的 execute 只做参数校验，不捕获异常：
```js
async execute(args, exec) {
`	const violations = validate(args);
`	if (violations.length > 0) throw new ToolArgsError(violations);
`	return userExecute(args, exec);
}
```
证据：`@deepseek-ai/dsh-tools/lib/index.js:866-870`
- 异常由调用方转成 `isError`：
```js
appendToolResult(session, turn, step, block, result, callSeq) {
`	const message = createToolResultMessage({ callId, content: result.content, isError: result.isError ... });
```
证据：`@deepseek-ai/dsh-agent-loop/lib/index.js:690-695`
- 官方前台子代理也是用 throw 语义：非 `completed` 就 throw。证据：`@deepseek-ai/dsh-tool-subagent/lib/index.js:286-296, 315-317`

> **对本插件：** 个别任务失败不应让整个工具调用变成失败——**收集全部结果后再决定是否抛异常**。见末尾建议。

---

## Q8 · 如何声明「自动批准」不弹审批

**结论：存在的正是"不申请"——工具不会被自动审批，只有显式调用 `ctx.approval` 才会弹窗。无 `approvalRule` 或白名单字段。**

### 8.1 defineTool 中无审批字段

全文扫 `dsh-tools/lib/index.js`，审批相关命中全部是对 `run_code` 工具自身的字段描述文案，**不是工具协议**。defineTool 返回对象的全部字段见 `dsh-tools/lib/index.js:851-886`：
`name` / `description` / `parameters` / `output` / `deferLoading?` / `timeoutMs?` / `execute` / `projectContent?` / `finalizeContent?` / `presentCall?` / `presentResult?` / `isConcurrencySafe?`。
**其中无任何审批相关字段。**

### 8.2 审批是工具主动申请的

只有需要审批的工具才主动调 `ctx.approval`：
```js
approver: ctx.get("approval"),
agent: exec.agent,
callId: exec.callId,
toolName: "bash",
signal: exec.signal
```
证据：`@deepseek-ai/dsh-tool-bash/lib/index.js:361-374`

失败时 fail-closed：
> "Missing or failed answerers return `unavailable`, so the action fails closed"
> —— `@deepseek-ai/dsh-user-approval/README.md:12`

保持断言的工具（如 `dsh-tool-fs`）同样是"不调就不审"，它的审批仅限于沙箱升级字段。证据：`@deepseek-ai/dsh-tool-fs/lib/index.js:1060-1116`

### 8.3 结论

- spec 里"`agent_swarm` 声明自动批准"这一条 **实现上是空操作**——不调 `ctx.approval`、不声明任何字段即自动批准。
- 实际风险在另一侧：**子代理自身的工具会许可触发审批**，这才是需要关注的地方。

---

## Q9 · 工具执行中能否拿到会话 / 父代理上下文

### 9.1 不用去 ctx.get("sessions")，用 exec.agent

`exec` 对象由 agent-loop 构造：
```js
const agent = ctx.agents.requireInitiator();
const { session } = agent;
exec: { callId: block.id, name: block.name, arguments: ..., agent, signal }
```
证据：`@deepseek-ai/dsh-agent-loop/lib/index.js:507-518`

因此：
- `exec.agent` → 当前调用者 Agent（完整对象）
- `exec.agent.session` → 当前 Session
- `exec.agent.id` → 会话能力的代表身份

官方包的保守写法：
```js
const parent = exec.agent;
if (!parent) throw new Error("subagent tool requires a calling agent (exec.agent was undefined)");
```
证据：`@deepseek-ai/dsh-tool-subagent/lib/index.js:491-492`；它构造 request 时用的就是 `parent`（`:515`）。

### 9.2 子代理继承沙箱档位的机制

继承在 **第一个 await 之前**快照：
```js
const inherited = captureDelegatedPolicyOverrides(parent);          // driver:169
...
appendDelegatedPolicyOverrides(child.session, inherited);          // driver:172
```
证据：`@deepseek-ai/dsh-subagent-in-process-driver/lib/index.js:169-172`

README 说明具体语义：
> "an Auto or Full access parent gives the child the same `permission/preset` identity, while the existing sandbox override and approval-policy pin continue to apply. Recording both identities prevents an older same-bundle fork value from winning."
> —— `@deepseek-ai/dsh-subagent/README.md:107`

即：父会话选的权限档位（Auto / Full access）**自动应用到子代理**，无需插件自行传递。

另两个重要细节：
- **Auto 不是无条件放行**：中风险任务需明确授权，高风险一律拒绝。证据：`@deepseek-ai/dsh-subagent/README.md:107`
- 请求超出上述时间前，你仍必须自行判断限流（见 Q6）。

---

## Q10 · 智能体团队面板数据源

**结论：one-shot 子代理不会自动出现在智能体团队面板。**

### 10.1 面板读的是 agentTeam 投影，不是 subagentCatalog
```js
const projection = this.ctx.sessionProjections.stateOf(root.session, "agentTeam");
```
证据：`@deepseek-ai/dsh-experimental-agent-team/lib/index.js:128-133`

### 10.2 主动排除子代理

身份解析函数里，对带有 `subagent/descriptor` 的会话直接返回 `undefined`（非成员）：
```js
if (this.subagentDescriptor(agent)) return void 0;    // :411 和 :420
return { root: agent, id: TeamId(agent.id), role: "lead", name: "lead" };
```
证据：`@deepseek-ai/dsh-experimental-agent-team/lib/index.js:397-430`（关键行 411、419-420）

而描述事件恰好是 **in-process driver 为每个 one-shot 子代理写入的**：
```js
childCtx.on("agent/pre-step", async ({ agent }, next) => {
`	if (!appended && decision.kind === "enter") { appended = true; agent.session.append("subagent/descriptor", descriptor); }
});
```
证据：`@deepseek-ai/dsh-subagent-in-process-driver/lib/index.js:139-149, 178`

判定函数：
```js
subagentDescriptor(agent) {
`	return foldSubagentDescriptor(agent.session.snapshotEvents(agent.session.inheritedEventCount)) !== void 0;
}
```
证据：`@deepseek-ai/dsh-experimental-agent-team/lib/index.js:722-725`

→ **one-shot 子代理永远带 descriptor，因此永远被团队面板过滤。**

### 10.3 面板成员的正确来源

成员必须由 `TeamRoster` 显式登记（`phase` 为 `provisioning`/`active`）：
```js
const member = state.members.find((candidate) => candidate.id === agent.id);
if (member?.phase === "active" || member?.phase === "provisioning") return { root, id: TeamId(root.id), role: "teammate", ... };
```
证据：`@deepseek-ai/dsh-experimental-agent-team/lib/index.js:404-410`

登记入口是专属的建组流程（随机 childId、限 `maxMembers`）：
证据：`@deepseek-ai/dsh-experimental-agent-team/lib/index.js:363-381, 548-554`

包定位也明确"自己不提供工具"，工具在同兄弟包 `dsh-experimental-tool-agent-team`。
证据：`@deepseek-ai/dsh-experimental-agent-team/README.md:12, 28`

### 10.4 与 spec 的冲突 ⚠️

spec.md 功能清单第 6 条与 M3 验收写着"成员在智能体团队面板可见"。
**按当前源码，这一条在一期不可能通过；** 一期使用的 `ctx.subagents.start()` 是 one-shot，会被面板排除。

**三条选择（交由下一阶段决定）：**
1. 改为 `startContinuable()` 派发并通过 Team 工具登记成员——但成员数有上限，且会受 maxActiveSubagents 限制（Q3），与"首波 5 并发"的设计冲突。
2. 一期改口径为"面板不可见"，在工具返回的 XML 里自行呈现成员状态（spec 功能 5 已要求做结果汇总）。
3. 插件自行向 `agentTeam` 投影写入成员事件——**需先验证该投影是否允许外部提供事件**（本次未找到证据，见风险清单）。

---

## 风险与待实机验证清单

| # | 事项 | 为何需实机 | 验证步骤 |
|---|---|---|---|
| R1 | 限流判定 | in-process 路径不透传 `diagnostic`/`code`（Q6） | 真实触发一次 429，从子会话日志查 `llm/retry` 事件的 `failure.code` 实际取值 |
| R2 | 团队面板可见性 | 一期按设计不可见（Q10） | 真实会话调 `agent_swarm` 后开智能体团队面板目测 |
| R3 | 子代理等待与抢占 | 未找到 in-process 路径的队列/信号量证据 | 实机测 5 并发时观测每个子会话的并行活跃度 |
| R4 | 沙箱继承精确形态 | README 有描述但未逐字段验证 | 实机对比父/子会话 header 的 `permission/preset` |
| R5 | 子代理工具审批行为 | Auto 中风险需授权的界面未实测 | 实机让子代理跑一个需审批的工具 |
| R6 | 插件能否写 agentTeam 投影 | 未找到允许外部写入该投影的公开 API | 查 `dsh-experimental-agent-team` 是否导出成员登记 API |

### 未找到的项（明确标注，不以猜测填补）

- `ctx.subagents.start()` 请求中的**子代理级 `timeout` 字段**——已审计并确认不存在，需自行用 `AbortSignal.timeout` 实现。
- **工具级自动批准声明式**（任何 `approvalRule` / 白名单字段）——已确认不存在。
- **外部插件向 `agentTeam` 投影写成员**的公开 API。
- asar 内 **不是缺口**：`dsh-llm-deepseek` 的 429 → `RATE_LIMIT` 映射代码本次已读到（`:1752`）；但 `dsh-llm-pi-ai` 适配器未逐一读取。`dsh-llm/lib/types/error.js:13` 已明确该码语义（"route on this, never by parsing message"），可作判定依据。
- 工具 `parameters` 中容器类型（如 `items[]`）在 `compilePropertyMap` 中的完整支持清单——已确认 `array`/`object`/`boolean`/`string` 可用（见 tool-subagent 与 run_code 的实际用法），但未逐一测试。

---

## 对插件 index.ts 的接口建议

### 1. 插件声明（最小集成）
```ts
export const name = "agent-swarm";
export const inject = ["tools", "subagents"] as const;

export const Config = Schema.object({
`	provider: Schema.string().default("spawn"),`          // 子代理 provider 名，不硬编码
`	firstWave: Schema.natural().default(5),`             // 首波并发
`	releaseIntervalMs: Schema.natural().default(700),`   // 放量节奏
`	backoffInitialMs: Schema.natural().default(3000),`  // 退避基准 3000ms×2^n
`	maxBackoffMs: Schema.natural().default(120000),
`	shrinkDebounceMs: Schema.natural().default(2000),`   // 容量收缩防抖
`	recoverIntervalMs: Schema.natural().default(180000),
`	taskTimeoutMs: Schema.natural().default(7_200_000),` // 单任务 2h
`	maxItems: Schema.natural().default(128),
`	// 子代理路由写死，不开 modelSelectionSettings
`	agentOptions: Schema.object({
`		provider: Schema.string(),
`		model: Schema.string(),
`		reasoningEffort: Schema.string().min(1),
`		maxTokens: Schema.natural().min(1),
`	}).default(undefined),
});
```

尽量不声明 `systemPrompt`、`sessionProjections`，避免多拔奇这两个服务。

### 2. 注册工具的形态
```ts
ctx.tools.register(defineTool({
`	name: "agent_swarm",
`	description: "——重写，不得复制 Kimi 原文——",
`	parameters: {
`		description: { type: "string", required: true, description: "本批次目标" },
`		prompt_template: { type: "string", required: true, description: "含 {{item}} 占位符的模板" },
`		items: { type: "array", required: true, description: "展开后的独立任务列表" },
`	},
`	output: {
`		schema: { type: "object", additionalProperties: false,
`			properties: { xml: { type: "string", required: true } } },
`		render: (_args, value) => [{ type: "text", text: value.xml }],
`	},
`	isConcurrencySafe: () => true,`   // 与官方子代理工具一致
`	async execute(args, exec) { /* 调度器 */ },
}));
```

强调：
- `required` 只写 `true`（Q7.2）；
- **不设任何审批字段**（Q8）——不声明就自动批准；
- `isConcurrencySafe: () => true` 可以声明，允许模型在同一消息里并发调用。

### 3. 派发单个子代理（含超时与取消级联）
```ts
const signal = AbortSignal.any([
`	exec.signal,`                          // 父会话中断
`	AbortSignal.timeout(cfg.taskTimeoutMs),`  // 2h 单任务超时
]);
let run;
try {
`	run = await ctx.subagents.start(cfg.provider, {
`		parent: exec.agent,`              // 必填，沙箱档位沿此继承
`		prompt: [{ type: "text", text: prompt }],
`		label,
`		...agentOptions ? { agentOptions } : {},
`		signal,
`	});
} catch (err) {
`	// start 三种异常路径：模型解析失败 / 发布前已 abort / 子代理创建失败
`	return { kind: "failed", detail: String(err) };
}
try {
`	const result = await run.result;`     // 结果，含 stopReason
`	return { kind: result.stopReason === "completed" ? "ok" : "failed", result };
} finally {
`	await run.dispose();`                  // 必须！否则泄漏
}
```

红线（依赖顺序）：
1. 每个 `start()` 成功后**必须**有对应 `dispose()`（否则泄漏，Q2.3）。
2. 取消后 settle 为 `stopReason:"aborted"`（Q5）——调度器应把它归为"取消"而非"限流"。
3. 不要自作主张向 run 传不支持的字段（如 `timeout`）。

### 4. 限流判定（待 R1 验证，不要按当前代码写）

不要写这种代码：
```ts
// 错：in-process 路径不产生 diagnostic，这一次判断总是失败
if (result.diagnostic?.includes("429")) shrink();
```

推荐写法：监听子会话的 `llm/retry` 事件（run.id 即子会话 id），
在 `llm/retry` 事件里找 `failure.code === "RATE_LIMIT"`，在**子代理级**触发退避，
**而不是在结果级判定**。
在 R1 验证完成前，调度器的退避分支先按"时间与存活率"跑通，不依赖错误码。

### 5. 不要做的事

- **不要为"自动批准"写任何声明**（Q8）——没有这个机制。
- **不要依赖智能体团队面板可见**（Q10）——一期成员不会出现在那里，可见性走结果 XML。
- **不要自己管理沙箱档位**（Q9）——传 `parent: exec.agent` 即可自动继承。
- **不要因个别任务失败就把整个工具调用判为失败**（Q7.4）——先收全部结果，再决定是否抛异常。

### 6. 下一步建议优先级

1. **R1 限流验证**（阻塞性）——决定调度器退避逻辑能否成立。
2. **Q10 面板可见性与 spec 的冲突裁定**（范围级）——需回写 spec.md。
3. 其余事项均有一手源码证据，可直接进入实现。
