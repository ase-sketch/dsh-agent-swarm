/**
 * dsh-agent-swarm — 入参校验与模板展开（纯函数，零 DSH 依赖）
 *
 * 设计依据：extracted/kimi-code-swarm-analysis/01-机制文档/03-工具入参与校验规则.md §5。
 * clean-room 重写：只依据机制文档描述的行为，未复制上游源码；错误文案为本仓自拟。
 *
 * 五条硬校验（一期，无 resume 运行时分支）：
 *   1. items >= 2
 *   2. 展开后成员总数 <= 128
 *   3. 提供了 items 就必须提供 prompt_template
 *   4. prompt_template 必须含 `{{item}}` 占位符
 *   5. 展开后的 prompt 必须互不相同
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
  const items = (input.items ?? []).map((item) => item.trim());
  const itemCount = items.length;

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

  // ── 校验 3/4：模板 ──
  const promptTemplate = normalizeOptionalString(input.promptTemplate);
  if (items.length > 0 && promptTemplate === undefined) {
    return fail(
      SWARM_ERROR_CODES.PROMPT_TEMPLATE_REQUIRED,
      "prompt_template is required when items are provided.",
    );
  }
  if (promptTemplate !== undefined && !promptTemplate.includes(SWARM_PROMPT_PLACEHOLDER)) {
    return fail(
      SWARM_ERROR_CODES.PROMPT_TEMPLATE_PLACEHOLDER_MISSING,
      `prompt_template must include the ${SWARM_PROMPT_PLACEHOLDER} placeholder.`,
      { placeholder: SWARM_PROMPT_PLACEHOLDER },
    );
  }

  // ── 展开 + 校验 5：prompt 去重 ──
  // 模板在通过校验 3 后必然存在（items.length > 0 且未报错）。
  const template = promptTemplate as string;
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
