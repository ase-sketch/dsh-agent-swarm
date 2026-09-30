/**
 * dsh-agent-swarm — 入参校验与模板展开（纯函数，零 DSH 依赖）
 *
 * 设计依据：extracted/kimi-code-swarm-analysis/01-机制文档/03-工具入参与校验规则.md §5。
 * clean-room 重写：只依据机制文档描述的行为，未复制上游源码；本文件每条错误文案
 * 都是本仓独立拟写的（与上游文案无逐字等同、无长串连续同词）。
 *
 * 六条硬校验（一期，无 resume 运行时分支）：
 *   1. items >= 2
 *   2. 展开后成员总数 <= 128
 *   3. 每个 item 元素必须是非空字符串（trim 后仍 >= 1 个字符）
 *   4. 提供了 items 就必须提供 prompt_template
 *   5. prompt_template 必须含 `{{item}}` 占位符
 *   6. 展开后的 prompt 必须互不相同
 */

import {
  SWARM_ERROR_CODES,
  SWARM_MAX_SUBAGENTS,
  SWARM_MIN_ITEMS,
  SWARM_PROMPT_PLACEHOLDER,
  type SwarmRequestInput,
  type SwarmTaskSpec,
  type SwarmValidationError,
} from "./types.js";

export interface SwarmValidationSuccess {
  ok: true;
  specs: SwarmTaskSpec[];
}

export interface SwarmValidationFailure {
  ok: false;
  error: SwarmValidationError;
}

export type SwarmValidationResult = SwarmValidationSuccess | SwarmValidationFailure;

/** 把模板里的 `{{item}}` 全部替换为 item 值（全量替换，不是只换第一处）。 */
export function expandPromptTemplate(template: string, item: string): string {
  return template.split(SWARM_PROMPT_PLACEHOLDER).join(item);
}

/** trim 后为空视同未提供。 */
function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * 把非法 item 元素渲染成一段可安全放进 message / details 的描述。
 *
 * 刻意不依赖对象自身的 toString / valueOf：入参来自模型，真实可能传入
 * `Object.create(null)` 这类没有原型的对象，直接拼接或 `String(value)` 会抛错——
 * 那又变成"校验函数自己抛 TypeError"，正是本次要消灭的行为。
 * 因此对象与函数只报类型；其余原始类型用 String() 显式转换（对 symbol 也安全）。
 */
function describeInvalidItem(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const kind = typeof value;
  if (kind === "object") return "an object";
  if (kind === "function") return "a function";
  return `${kind} ${String(value)}`;
}

function fail(
  code: SwarmValidationError["code"],
  message: string,
  details?: Record<string, unknown>,
): SwarmValidationFailure {
  return { ok: false, error: details === undefined ? { code, message } : { code, message, details } };
}

/**
 * 校验并入队。全部校验在任何子代理启动之前完成；本函数不产生任何副作用。
 *
 * 编号语义：`index` 从 1 开始、按 specs 顺序连续递增（全链一致的唯一编号基）。
 */
export function validateSwarmInput(input: SwarmRequestInput): SwarmValidationResult {
  // 类型层是 string[]，但真实入参由模型给出、运行时可能是 123/null/对象；
  // 所以这里按 unknown 收，逐个判型，绝不在元素上直接点 .trim()（那会抛 TypeError）。
  const rawItems: readonly unknown[] = input.items ?? [];
  const itemCount = rawItems.length;

  // ── 校验 1：数量下限（一期无 resume，故没有豁免路径）──
  if (itemCount < SWARM_MIN_ITEMS) {
    return fail(
      SWARM_ERROR_CODES.ITEMS_TOO_FEW,
      `A swarm needs at least ${String(SWARM_MIN_ITEMS)} items, got ${String(itemCount)}.`,
      { itemCount, min: SWARM_MIN_ITEMS },
    );
  }

  // ── 校验 2：数量上限 ──
  if (itemCount > SWARM_MAX_SUBAGENTS) {
    return fail(
      SWARM_ERROR_CODES.TOO_MANY_SUBAGENTS,
      `A swarm supports at most ${String(SWARM_MAX_SUBAGENTS)} subagents, got ${String(itemCount)}.`,
      { total: itemCount, max: SWARM_MAX_SUBAGENTS },
    );
  }

  // ── 校验 3：每个 item 元素必须是非空字符串 ──
  // 上游契约是 array(string().trim().min(1))：元素级非法必须在派发前拦下，
  // 否则 item 为 "" 时会真的派一个空实体的子代理；两个全空白 item 还会先撞出
  // 误导性的 DUPLICATE_PROMPTS。本段排在数量校验之后，是为了让"数组整体规模不对"
  // 优先报出——规模错时先修规模，一轮就能收敛。
  const items: string[] = [];
  for (let i = 0; i < rawItems.length; i += 1) {
    const raw = rawItems[i];
    const position = i + 1;
    if (typeof raw !== "string") {
      const received = describeInvalidItem(raw);
      return fail(
        SWARM_ERROR_CODES.ITEM_NOT_STRING,
        `Item at position ${String(position)} is not a string (received ${received}); items may only contain strings.`,
        { index: position, received },
      );
    }
    const trimmed = raw.trim();
    if (trimmed === "") {
      return fail(
        SWARM_ERROR_CODES.ITEM_EMPTY,
        `Item at position ${String(position)} holds no non-whitespace character (received ${JSON.stringify(raw)}); each item needs at least one.`,
        { index: position, received: raw },
      );
    }
    items.push(trimmed);
  }

  // ── 校验 4/5：模板 ──
  // 到这里 items 必然非空：校验 1 已保证 itemCount >= 2，故不再重复判断 items.length。
  const promptTemplate = normalizeOptionalString(input.promptTemplate);
  if (promptTemplate === undefined) {
    return fail(
      SWARM_ERROR_CODES.PROMPT_TEMPLATE_REQUIRED,
      "Missing prompt_template: this call supplied items but no template string to expand.",
    );
  }
  if (!promptTemplate.includes(SWARM_PROMPT_PLACEHOLDER)) {
    return fail(
      SWARM_ERROR_CODES.PROMPT_TEMPLATE_PLACEHOLDER_MISSING,
      `prompt_template carries no literal ${SWARM_PROMPT_PLACEHOLDER} marker, so there is nothing to substitute per member.`,
      { placeholder: SWARM_PROMPT_PLACEHOLDER },
    );
  }

  // ── 展开 + 校验 6：prompt 去重 ──
  // 模板此时已被收窄为 string（校验 4 排除了 undefined），无需断言。
  const template = promptTemplate;
  const seenPrompts = new Map<string, number>();
  const specs: SwarmTaskSpec[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as string;
    const prompt = expandPromptTemplate(template, item);
    const previousIndex = seenPrompts.get(prompt);
    if (previousIndex !== undefined) {
      return fail(
        SWARM_ERROR_CODES.DUPLICATE_PROMPTS,
        `Items ${String(previousIndex)} and ${String(i + 1)} expand to the same prompt; swarm members must be distinct.`,
        { previousIndex, index: i + 1 },
      );
    }
    seenPrompts.set(prompt, i + 1);
    specs.push({ kind: "spawn", index: specs.length + 1, item, prompt });
  }

  return { ok: true, specs };
}
