/**
 * dsh-agent-swarm — 入参校验与模板展开（纯函数，零 DSH 依赖）
 *
 * 设计依据：extracted/kimi-code-swarm-analysis/01-机制文档/03-工具入参与校验规则.md §5。
 * clean-room 重写：只依据机制文档描述的行为，未复制上游源码；本文件每条错误文案
 * 都是本仓独立拟写的（与上游文案无逐字等同、无长串连续同词）。
 *
 * 六条硬校验（一期，无 resume 运行时分支）：
 *   0. **入参自身**必须是非 null 的非数组对象（INVALID_INPUT）——
 *      排在最前是因为它是其余六条的前提；入参不是对象时读 .items 就会抛 TypeError，
 *      而本文件的立意恰恰是"绝不让校验函数抛异常"（2026-10-01 审查实证该防护曾形同虚设）。
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
  type SwarmModelRoute,
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
 * 把一个形状不合法的值（入参自身、item 元素、model 参数）渲染成可安全放进 message / details 的描述。
 *
 * 刻意不依赖对象自身的 toString / valueOf：入参来自模型，真实可能传入
 * `Object.create(null)` 这类没有原型的对象，直接拼接或 `String(value)` 会抛错——
 * 那又变成"校验函数自己抛 TypeError"，正是本文件要消灭的行为。
 * 因此对象与函数只报类型；其余原始类型用 String() 显式转换（对 symbol 也安全）。
 */
function describeInvalidValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const kind = typeof value;
  if (kind === "object") return "an object";
  if (kind === "function") return "a function";
  return `${kind} ${String(value)}`;
}

/**
 * 碰撞信息里单侧文本片段的最大码元数。
 *
 * 为什么必须截断：item 与 prompt 都是模型给的自由文本，prompt 还是"模板 + item"展开的结果；
 * 一条 item 完全可能是十几万字符（比如把整份文件塞进 item）。把原文整段放进 error.details，
 * 本意是帮模型自纠，实际会先用一条超长报错挤爆上下文——比不报还糟。
 * 120 是个折中：足以让模型认出重复的是哪段文本，人类一眼也能读完一行。
 */
export const DUPLICATE_SNIPPET_MAX_CHARS = 120;

/**
 * 取文本开头的定长片段：超出上限时截断并补一个省略号标记，未超出则原样返回（不留标记）。
 *
 * 刻意不改写片段的空白/控制字符：片段的唯一用途是"让人认出是哪段文本"，
 * 任何重写都会让它在细节上与原文对不上号；长度信息由调用方另行给出（*Chars 字段）。
 */
function snippetOf(value: string): string {
  if (value.length <= DUPLICATE_SNIPPET_MAX_CHARS) return value;
  return `${value.slice(0, DUPLICATE_SNIPPET_MAX_CHARS)}…`;
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
 * **永不抛异常**（本文件的立意）：入参由模型给出，形状完全不可信，因此从入参自身到
 * 每个 item 元素都按 unknown 收并逐层判型。原实现只兜住了 `items`（`input.items ?? []`），
 * `input` 自身是 undefined/null 时会在读 `.items` 的那一刻抛 TypeError——
 * 那恰是本文件要消灭的行为，却漏在了最外层。现由入口处的 INVALID_INPUT 挡住。
 *
 * 编号语义：`index` 从 1 开始、按 specs 顺序连续递增（全链一致的唯一编号基）。
 */
export function validateSwarmInput(input: SwarmRequestInput): SwarmValidationResult {
  // 入参自身的前置防护：undefined / null / 数组 / 原始值 / 函数都不是合法的入参形状。
  // 数组一并拒绝：数组上取 .items 是 undefined，落到校验 1 会报成"至少 2 条"——
  // 而调用方真正的问题是把 items 直接当成了整个入参，报条数是误导。

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    const received = describeInvalidValue(input);
    return fail(
      SWARM_ERROR_CODES.INVALID_INPUT,
      `Swarm input must be an object with items and prompt_template; received ${received}.`,
      { received },
    );
  }
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
      const received = describeInvalidValue(raw);
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
        // 编号之外还要给"重复的是哪一段文本"——只报两个编号的话，模型知道"1 和 3 撞了"
        // 却不知道该改哪一条。片段只给一份：模板固定且至少含一个 {{item}}（校验 5 已保证），
        // prompt 关于 item 是**单射**的——prompt 相同 ⇔ item 相同，故首次出现处与碰撞处的
        // 文本必然逐字一致，再复制一份 previousItem/previousPrompt 只是噪音。
        // 长度（*Chars）另行给出，读取方能看出片段被截掉了多少。
        {
          previousIndex,
          index: i + 1,
          itemSnippet: snippetOf(item),
          promptSnippet: snippetOf(prompt),
          itemChars: item.length,
          promptChars: prompt.length,
        },
      );
    }
    seenPrompts.set(prompt, i + 1);
    specs.push({ kind: "spawn", index: specs.length + 1, item, prompt });
  }

  return { ok: true, specs };
}

// ───────────────────────── per-call 模型路由匹配（纯函数）─────────────────────────

/**
 * details 里允许清单的最大条数。
 *
 * 白名单是部署方维护的，理论上可以很长；整份塞进 error.details 会用一条超长报错
 * 挤爆模型上下文（与 DUPLICATE_SNIPPET_MAX_CHARS 同一个考量）。
 * 截断时另给 allowedCount，读取方知道清单被截掉了多少。
 */
export const ALLOWED_ROUTES_DETAILS_CAP = 20;

export type SwarmModelResolution =
  | { ok: true; route: SwarmModelRoute }
  | { ok: false; error: SwarmValidationError };

/** 把允许清单渲染成 details 用的紧凑形态（截断 + 总数）。 */
function allowedRoutesDetails(allowed: readonly SwarmModelRoute[]): Record<string, unknown> {
  return {
    allowedRoutes: allowed.slice(0, ALLOWED_ROUTES_DETAILS_CAP).map((r) => `${r.provider}/${r.model}`),
    allowedCount: allowed.length,
  };
}

/**
 * 把模型给出的 per-call `model` 参数解析成一条白名单内的精确路由。
 *
 * 两种写法：
 *   - `"provider/model"` 精确式：按第一个 "/" 切分（model id 自身可能含 "/"，
 *     如 fireworks 风格的层级 id，provider 段不会含 "/"），要求白名单里逐字命中；
 *   - 裸 model id：白名单里按 model 段匹配，恰好一条才采用；
 *     多条命中（多个 provider 提供同一 model id）报 MODEL_AMBIGUOUS 并列出候选。
 *
 * 永不抛异常（与 validateSwarmInput 同一立意）：入参由模型给出，形状完全不可信。
 * 白名单本身由宿主服务保证形状（SubagentModelSelectionConfig.current() 自带断言），
 * 这里对它按只读消费，不做防御性逐条判型。
 */
export function resolveSwarmModelRoute(
  requested: unknown,
  allowed: readonly SwarmModelRoute[],
): SwarmModelResolution {
  if (typeof requested !== "string" || requested.trim() === "") {
    const received = describeInvalidValue(requested);
    return {
      ok: false,
      error: {
        code: SWARM_ERROR_CODES.MODEL_NOT_ALLOWED,
        message: `model must be a non-empty string ("provider/model" or a whitelisted model id); received ${received}.`,
        details: { received },
      },
    };
  }
  const value = requested.trim();

  if (value.includes("/")) {
    const slash = value.indexOf("/");
    const provider = value.slice(0, slash);
    const model = value.slice(slash + 1);
    if (provider === "" || model === "") {
      return {
        ok: false,
        error: {
          code: SWARM_ERROR_CODES.MODEL_NOT_ALLOWED,
          message: `model "${value}" is not a valid route: "provider/model" needs non-empty provider and model ids.`,
          details: { received: value },
        },
      };
    }
    const hit = allowed.find((r) => r.provider === provider && r.model === model);
    if (hit !== undefined) return { ok: true, route: { provider: hit.provider, model: hit.model } };
    return {
      ok: false,
      error: {
        code: SWARM_ERROR_CODES.MODEL_NOT_ALLOWED,
        message: `Route "${provider}/${model}" is not in this deployment's allowed subagent models.`,
        details: { requested: `${provider}/${model}`, ...allowedRoutesDetails(allowed) },
      },
    };
  }

  const matches = allowed.filter((r) => r.model === value);
  if (matches.length === 1) {
    const hit = matches[0] as SwarmModelRoute;
    return { ok: true, route: { provider: hit.provider, model: hit.model } };
  }
  if (matches.length === 0) {
    return {
      ok: false,
      error: {
        code: SWARM_ERROR_CODES.MODEL_NOT_ALLOWED,
        message: `Model "${value}" is not in this deployment's allowed subagent models.`,
        details: { requested: value, ...allowedRoutesDetails(allowed) },
      },
    };
  }
  return {
    ok: false,
    error: {
      code: SWARM_ERROR_CODES.MODEL_AMBIGUOUS,
      message: `Model id "${value}" is offered by ${String(matches.length)} providers; pass it as "provider/model" instead.`,
      details: {
        requested: value,
        candidates: matches.map((r) => `${r.provider}/${r.model}`),
      },
    },
  };
}

