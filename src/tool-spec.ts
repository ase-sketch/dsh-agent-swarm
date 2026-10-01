/**
 * dsh-agent-swarm — 面向模型的工具规格（纯函数，零 DSH 依赖）
 *
 * 职责：工具名、工具描述、参数映射、输出契约，以及它们共用的「生效上限」。
 * 这些文本是模型规划批量、填写参数时直接读的东西，必须与运行时校验共用同一个上限函数
 * （{@link effectiveMaxItems}），否则会分叉出"文案说 10、校验按 128"（或反之）的偏差。
 *
 * clean-room：本文件全部文案为本仓自拟英文，未复制任何上游原文。
 */

import { SWARM_MAX_SUBAGENTS, SWARM_MIN_ITEMS } from "./types.js";

/** 模型可调用的工具名。 */
export const SWARM_TOOL_NAME = "agent_swarm";

// ──────────────────────── 生效上限（描述与校验的唯一口径）────────────────────────

/**
 * 生效的 items 上限 = min(宿主配置的 maxItems, SWARM_MAX_SUBAGENTS)。
 *
 * 这是全插件**唯一**算上限的地方：工具描述、参数描述与运行时校验全部调它。
 * 集中在一处是本条契约能成立的唯一保证——三处各算一遍，
 * 即便写法一样，下一次改其中一处就会重新分叉。
 *
 * 协议常量 128 是硬上限，宿主只允许调低；调高（如 999）在这里被静默收敛回 128。
 */
export function effectiveMaxItems(configuredMaxItems: number): number {
  return Math.min(configuredMaxItems, SWARM_MAX_SUBAGENTS);
}

/** fork 批次的生效上限 = min(通用生效上限, fork 专属上限)。同样是描述与校验的唯一口径。 */
export function effectiveMaxForkItems(configuredMaxItems: number, configuredMaxForkItems: number): number {
  return Math.min(effectiveMaxItems(configuredMaxItems), configuredMaxForkItems);
}

// ──────────────────────── 工具描述 ────────────────────────

/**
 * 工具描述：英文、面向模型、全部自拟（clean-room，未复制任何上游原文）。
 * 覆盖四块：用途 / 六道硬校验（与 validate.ts 一一对应）/ 与单个 subagent 工具的分工 / 禁止嵌套。
 *
 * 文案里的**上界一律取生效上限**，不是协议常量 128。
 * 理由：模型是照着这段说明去规划批量的——若宿主把 config.maxItems 调到 10，
 * 描述却仍写 "at most 128"，模型会按 128 去切批，然后被第 11 条以
 * TOO_MANY_SUBAGENTS 拒掉，"描述与运行时校验不符"会变成稳定可复现的浪费。
 * 因此描述在 apply 期按 config 生成（每个插件实例各一份），与校验走同一个上限函数。
 *
 * 下界仍取 SWARM_MIN_ITEMS（协议常量，宿主不可调）。
 *
 * 协议硬上限的说明始终保留：它解释的是"为什么宿主只能调低"，即便生效上限正好等于
 * 128（宿主未调低）也要写——否则配置作者看不到这条不可绕过的边界。
 */
export function buildToolDescription(effectiveMax: number, effectiveForkMax: number): string {
  return [
    "Dispatch a batch of independent, same-shaped tasks as multiple parallel subagents, and receive every member's result in one aggregated XML report.",
    "",
    `Use this when you have N (${String(SWARM_MIN_ITEMS)} to ${String(effectiveMax)}) self-contained subtasks of the same kind that can run in parallel without depending on each other's output — reviewing N files the same way, researching N independent topics, applying one transform to N inputs. Each entry in items is substituted into prompt_template and dispatched as its own subagent; the call returns a single <agent_swarm_result> block listing every member's outcome and output.`,
    "",
    "Hard requirements (the call is rejected before any subagent starts if violated):",
    `1. items must contain at least ${String(SWARM_MIN_ITEMS)} entries.`,
    `2. items must contain at most ${String(effectiveMax)} entries.`,
    "3. if you provide items, you must also provide prompt_template.",
    "4. prompt_template must contain the {{item}} placeholder, which is replaced once per item.",
    "5. every item must expand to a distinct prompt; items that expand to the same prompt are rejected.",
    "6. every item must be a string with at least one non-whitespace character.",
    "",
    `Item-count limit: the protocol hard limit is ${String(SWARM_MAX_SUBAGENTS)} entries and cannot be raised; the host can only lower it, and the effective limit on this deployment is ${String(effectiveMax)}. Plan and split your batch against the number stated in requirement 2 above — submitting more than the effective limit is rejected.`,
    "",
    "How to choose between this tool and a single-subagent tool:",
    "- Use this tool for several independent, same-shaped tasks that benefit from running at the same time.",
    "- Use a single-subagent tool when the work is one cohesive task, or when a later step depends on an earlier step's result — swarm members cannot see each other or your intermediate work.",
    "- Do not call this tool from inside a swarm member's subtask. Nesting a swarm within a swarm member is not supported: members run under the host's subagent depth limit (1 by default), and a call that would exceed it is rejected before any subagent starts. Call it from your own turn instead.",
    "",
    "Individual members may fail; that is reported per member in the result rather than failing the whole call. Read the per-member outcomes to decide what to do next.",
    "",
    "Optional model routing: pass model as \"provider/model\" (or a bare model id that is unique in this deployment's allowed subagent models) to run the whole batch on that route. The route must appear in the deployment's subagent model allowlist — discover candidates with list_subagent_models when that tool is available. Omit model to inherit the calling agent's route (or the plugin's configured fixed route). A rejected model fails the call before any subagent starts.",
    "",
    `Optional starting context: by default (context "fresh") every member starts from a blank conversation and sees only its own prompt, so the prompt must carry everything it needs. Pass context "fork" when members should build on this conversation: each member then starts with a copy of the conversation's completed turns (your current, in-progress turn is not included). A fork batch accepts at most ${String(effectiveForkMax)} entries because every member carries the whole conversation, and it cannot be combined with model, since forked members stay on the calling agent's route.`,
  ].join("\n");
}

// ──────────────────────── 参数映射 ────────────────────────

/**
 * 扁平参数映射：description / prompt_template / items / model / context；required 只写布尔 true。
 *
 * 与 buildToolDescription 同理：items 的上界取**生效上限**而非协议常量 128。
 * 参数描述是模型填参时直接对着的文案，它说 128 就会让模型往里塞 128 条。
 *
 * 注意：DSH 的 defineTool 会在 execute 之前按本映射校验参数**类型**（实测非字符串 item
 * 以 ToolArgsError 被宿主拒绝），但不支持 minItems/maxItems 这类数量约束——数量仍由
 * validate.ts 的硬校验负责。
 */
export function buildToolParameters(effectiveMax: number, effectiveForkMax: number) {
  return {
    description: {
      type: "string",
      required: true,
      description: "One short sentence describing what this whole batch accomplishes.",
    },
    prompt_template: {
      type: "string",
      required: true,
      description:
        "Prompt template sent to every member, containing the {{item}} placeholder. Each entry of items is substituted for it to form one member's full prompt.",
    },
    items: {
      type: "array",
      items: { type: "string" },
      required: true,
      description: `The independent per-member inputs, at least ${String(SWARM_MIN_ITEMS)} and at most ${String(effectiveMax)} entries. Plan against this number: the protocol hard limit is ${String(SWARM_MAX_SUBAGENTS)} and cannot be raised, so on this deployment the host can only lower the cap, and more than ${String(effectiveMax)} entries is rejected before any subagent starts.`,
    },
    model: {
      type: "string",
      description:
        "Optional LLM route for the whole batch: \"provider/model\", or a bare model id unique in this deployment's allowed subagent models. Must appear in the subagent model allowlist (see list_subagent_models). Omit to inherit the calling agent's route (or the plugin's fixed route).",
    },
    context: {
      type: "string",
      description: `Optional starting context for every member: "fresh" (default) starts each member from a blank conversation; "fork" starts each member with a copy of this conversation's completed turns. A fork batch accepts at most ${String(effectiveForkMax)} entries and cannot be combined with model.`,
    },
  } as const;
}

// ──────────────────────── 输出契约 ────────────────────────

/**
 * 工具结果内容块。真身定义在 @deepseek-ai/dsh-llm（dsh-tools 的依赖）；
 * 这里只声明本插件真正产出的那一种形状，避免为一次类型注解新增一条依赖。
 */
export type ContentBlock = { type: "text"; text: string };

/** 输出契约：{ xml: string }，render 两参（args, value），返回内容块数组。 */
export const TOOL_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { xml: { type: "string" } },
  },
  render: (_args: unknown, value: { xml: string }): ContentBlock[] => [{ type: "text", text: value.xml }],
} as const;
