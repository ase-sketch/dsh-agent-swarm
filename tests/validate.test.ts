import { describe, expect, it } from "vitest";
import { hasLoneSurrogate } from "./helpers/surrogates.js";

import {
  SWARM_ERROR_CODES,
  SWARM_MAX_SUBAGENTS,
  SWARM_MIN_ITEMS,
  SWARM_PROMPT_PLACEHOLDER,
  type SwarmRequestInput,
} from "../src/types.js";
import {
  ALLOWED_ROUTES_DETAILS_CAP,
  DUPLICATE_SNIPPET_MAX_CHARS,
  expandPromptTemplate,
  resolveSwarmContextMode,
  resolveSwarmModelRoute,
  validateSwarmInput,
} from "../src/validate.js";

function input(overrides: Partial<SwarmRequestInput>): SwarmRequestInput {
  return { promptTemplate: `work on ${SWARM_PROMPT_PLACEHOLDER}`, items: ["a", "b"], ...overrides };
}

describe("expandPromptTemplate", () => {
  it("替换全部占位符出现处", () => {
    expect(expandPromptTemplate("x {{item}} y {{item}}", "V")).toBe("x V y V");
  });

  it("item 为空串时占位符被抹掉", () => {
    expect(expandPromptTemplate("[{{item}}]", "")).toBe("[]");
  });

  it("模板不含占位符时原样返回", () => {
    expect(expandPromptTemplate("plain", "V")).toBe("plain");
  });

  it("item 里的占位符字面量不会被二次展开", () => {
    expect(expandPromptTemplate("a {{item}}", "{{item}}")).toBe("a {{item}}");
  });
});

/**
 * 回归（2026-10-01 审查缺陷 3）：入参自身的空值防护曾形同虚设。
 *
 * 原实现只兜住了 `items`（`input.items ?? []`），`input` 自身是 undefined/null 时
 * 会在读 `.items` 的那一刻抛 TypeError——而本文件的立意恰恰是"绝不让校验函数抛异常"。
 * 即：立意写进了注释，最外层却恰恰是它。
 *
 * 钉住：返回值是**结构化失败**（ok:false + 错误码），而不是异常。
 */
describe("入参自身的前置防护（2026-10-01 缺陷 3）", () => {
  it("undefined / null 返回结构化 INVALID_INPUT，不抛 TypeError", () => {
    for (const bad of [undefined, null]) {
      const r = validateSwarmInput(bad as unknown as Parameters<typeof validateSwarmInput>[0]);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.error.code).toBe(SWARM_ERROR_CODES.INVALID_INPUT);
      // 不得报成"条数不够"：入参压根不是对象，调用方要改的是入参本身。
      expect(r.error.code).not.toBe(SWARM_ERROR_CODES.ITEMS_TOO_FEW);
    }
  });

  it("数组入参同样被拒（把 items 直接当整参传入是常见的调用方错误）", () => {
    const r = validateSwarmInput(["a", "b"] as unknown as Parameters<typeof validateSwarmInput>[0]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe(SWARM_ERROR_CODES.INVALID_INPUT);
  });

  it("原始值 / 函数入参也返回结构化失败而非抛错", () => {
    for (const bad of [42, "str", true, () => undefined]) {
      const r = validateSwarmInput(bad as unknown as Parameters<typeof validateSwarmInput>[0]);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.error.code).toBe(SWARM_ERROR_CODES.INVALID_INPUT);
    }
  });

  it("失败文案与 details 说出实际收到的是什么（供模型自纠）", () => {
    const r = validateSwarmInput(null as unknown as Parameters<typeof validateSwarmInput>[0]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.message).toMatch(/must be an object/i);
    expect(r.error.message).toMatch(/null/);
    expect(r.error.details?.["received"]).toBe("null");
  });

  it("向后兼容：合法对象入参行为完全不变", () => {
    const r = validateSwarmInput({ items: ["a", "b"], promptTemplate: "do {{item}}" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.specs.map((s) => s.index)).toEqual([1, 2]);
    // 空对象仍走原有的 ITEMS_TOO_FEW 路径（新防护只在入参不是对象时才介入）。
    const empty = validateSwarmInput({});
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error("unreachable");
    expect(empty.error.code).toBe(SWARM_ERROR_CODES.ITEMS_TOO_FEW);
  });
});
describe("校验 1：items >= 2", () => {
  it("0 个 item 报 ITEMS_TOO_FEW", () => {
    const r = validateSwarmInput(input({ items: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.ITEMS_TOO_FEW);
      expect(r.error.details).toMatchObject({ itemCount: 0, min: 2 });
    }
  });

  it("1 个 item 报 ITEMS_TOO_FEW（边界）", () => {
    const r = validateSwarmInput(input({ items: ["only"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(SWARM_ERROR_CODES.ITEMS_TOO_FEW);
  });

  it("items 缺省等同 0 个", () => {
    const r = validateSwarmInput({ promptTemplate: "{{item}}" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(SWARM_ERROR_CODES.ITEMS_TOO_FEW);
  });

  it("2 个 item 通过（下边界）", () => {
    expect(validateSwarmInput(input({})).ok).toBe(true);
  });
});

describe("校验 2：总数 <= 128", () => {
  it("128 个 item 通过（上边界），且编号 1 起始连续、逐项对上输入", () => {
    const items = Array.from({ length: SWARM_MAX_SUBAGENTS }, (_, i) => `item-${String(i)}`);
    const r = validateSwarmInput(input({ items }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.specs).toHaveLength(SWARM_MAX_SUBAGENTS);
    // 完整性断言：编号序列必须是恰好 1..128。只钉末项的话，中间丢项/错位/重复编号
    // 都能蒙混过关——而"编号全链一致"正是下游渲染的硬不变量（specs.index 对齐数组位置）。
    expect(r.specs.map((spec) => spec.index)).toEqual(
      Array.from({ length: SWARM_MAX_SUBAGENTS }, (_, i) => i + 1),
    );
    // 编号对上但内容错位同样要红：item 与展开后的 prompt 都逐项比对。
    expect(r.specs.map((spec) => spec.item)).toEqual(items);
    expect(r.specs.map((spec) => spec.prompt)).toEqual(items.map((item) => `work on ${item}`));
    // 首末两项单独钉一遍：编号基（1 起始）与上边界落点（第 128 条）由它们把守。
    expect(r.specs[0]).toMatchObject({ kind: "spawn", index: 1, item: "item-0" });
    expect(r.specs[SWARM_MAX_SUBAGENTS - 1]).toMatchObject({
      kind: "spawn",
      index: SWARM_MAX_SUBAGENTS,
      item: `item-${String(SWARM_MAX_SUBAGENTS - 1)}`,
    });
  });

  it("129 个 item 报 TOO_MANY_SUBAGENTS（越界一）", () => {
    const items = Array.from({ length: 129 }, (_, i) => `item-${String(i)}`);
    const r = validateSwarmInput(input({ items }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.TOO_MANY_SUBAGENTS);
      expect(r.error.details).toMatchObject({ total: 129, max: SWARM_MAX_SUBAGENTS });
    }
  });
});

describe("校验 3：item 元素必须是非空字符串", () => {
  function inputWithItems(items: readonly unknown[]): SwarmRequestInput {
    return { ...input({}), items: items as readonly string[] };
  }

  it("空串 item 报 ITEM_EMPTY，details 带 1 起始位置与实际值", () => {
    const r = validateSwarmInput(input({ items: ["", "b"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.ITEM_EMPTY);
      expect(r.error.details).toMatchObject({ index: 1, received: "" });
    }
  });

  it("纯空白 item（空格/制表/换行）报 ITEM_EMPTY，定位到它所在的位置", () => {
    for (const blank of [" ", "\t", "\n", " \t\r\n "]) {
      const r = validateSwarmInput(input({ items: ["ok", blank] }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe(SWARM_ERROR_CODES.ITEM_EMPTY);
        expect(r.error.details).toMatchObject({ index: 2, received: blank });
      }
    }
  });

  it("超长全空白 item：回显截断到片段上限，另给原长度（报错不能挤爆上下文）", () => {
    const blank = "\n".repeat(50_000);
    const r = validateSwarmInput(input({ items: ["ok", blank] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.ITEM_EMPTY);
      expect(r.error.message.length).toBeLessThan(DUPLICATE_SNIPPET_MAX_CHARS * 4);
      expect(r.error.details).toMatchObject({ index: 2, receivedChars: 50_000 });
      expect(String(r.error.details?.received).length).toBeLessThanOrEqual(DUPLICATE_SNIPPET_MAX_CHARS + 1);
    }
  });

  it("两个全空白 item 报 ITEM_EMPTY，而不是误导性的 DUPLICATE_PROMPTS", () => {
    const r = validateSwarmInput(input({ items: ["   ", "\t"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.ITEM_EMPTY);
      expect(r.error.code).not.toBe(SWARM_ERROR_CODES.DUPLICATE_PROMPTS);
      expect(r.error.details).toMatchObject({ index: 1 });
    }
  });

  it("失败文案指出第几条并带上实际收到的值", () => {
    const r = validateSwarmInput(input({ items: ["a", " \t "] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain("2");
      expect(r.error.message).toContain(JSON.stringify(" \t "));
    }
  });

  const nonStringCases: Array<[unknown, string]> = [
    [123, "number 123"],
    [null, "null"],
    [undefined, "undefined"],
    [{}, "an object"],
    [[1, 2], "an array"],
    [true, "boolean true"],
  ];

  it.each(nonStringCases)(
    "非 string 元素（received: %s）报 ITEM_NOT_STRING 而不是抛 TypeError",
    (value: unknown, received: string) => {
      const rawItems = [value, "b"];
      expect(() => validateSwarmInput(inputWithItems(rawItems))).not.toThrow();
      const r = validateSwarmInput(inputWithItems(rawItems));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe(SWARM_ERROR_CODES.ITEM_NOT_STRING);
        expect(r.error.details).toMatchObject({ index: 1, received });
        expect(r.error.message).toContain(received);
      }
    },
  );

  it("非 string 元素位于末位时定位同样准确", () => {
    const r = validateSwarmInput(inputWithItems(["a", 42]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.ITEM_NOT_STRING);
      expect(r.error.details).toMatchObject({ index: 2, received: "number 42" });
    }
  });
});

describe("校验 4：有 items 必有 prompt_template", () => {
  it("缺 prompt_template 报 PROMPT_TEMPLATE_REQUIRED", () => {
    const r = validateSwarmInput({ items: ["a", "b"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(SWARM_ERROR_CODES.PROMPT_TEMPLATE_REQUIRED);
  });

  it("空串/纯空白视为未提供", () => {
    for (const t of ["", "   ", "\t\n"]) {
      const r = validateSwarmInput({ items: ["a", "b"], promptTemplate: t });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(SWARM_ERROR_CODES.PROMPT_TEMPLATE_REQUIRED);
    }
  });
});

describe("校验 5：template 必含 {{item}}", () => {
  it("不含占位符报 PLACEHOLDER_MISSING", () => {
    const r = validateSwarmInput({ items: ["a", "b"], promptTemplate: "do the thing" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.PROMPT_TEMPLATE_PLACEHOLDER_MISSING);
      expect(r.error.details).toMatchObject({ placeholder: SWARM_PROMPT_PLACEHOLDER });
    }
  });

  it("大小写/多余括号不构成占位符", () => {
    for (const t of ["{{Item}}", "{{ item }}", "{item}", "{{item}"]) {
      const r = validateSwarmInput({ items: ["a", "b"], promptTemplate: t });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(SWARM_ERROR_CODES.PROMPT_TEMPLATE_PLACEHOLDER_MISSING);
    }
  });
});

describe("校验 6：展开后 prompt 互不相同", () => {
  it("重复 item 展开出相同 prompt → DUPLICATE_PROMPTS", () => {
    const r = validateSwarmInput(input({ items: ["same", "same"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.DUPLICATE_PROMPTS);
      expect(r.error.details).toMatchObject({ previousIndex: 1, index: 2 });
    }
  });

  it("details 带碰撞文本片段：模型看得到重复的是哪一段，而不是只知道两个编号", () => {
    const r = validateSwarmInput(input({ items: ["same", "same"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.details).toMatchObject({
        previousIndex: 1,
        index: 2,
        itemSnippet: "same",
        promptSnippet: "work on same",
        itemChars: "same".length,
        promptChars: "work on same".length,
      });
    }
  });

  it("超长 item/prompt 只把截断片段放进 details，全量长度另行给出", () => {
    // 截断点落在 x 段内部（后半段是 y），这样"只取开头"这件事是被逼出来的，而不是碰巧成立
    const head = "x".repeat(DUPLICATE_SNIPPET_MAX_CHARS);
    const longItem = `${head}${"y".repeat(99_880)}`; // 总长 100_000
    const r = validateSwarmInput(input({ items: [longItem, longItem] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const details = r.error.details as {
        itemSnippet: string;
        promptSnippet: string;
        itemChars: number;
        promptChars: number;
      };
      // 片段 = 前 N 个字符 + 一个省略号标记（N 由 DUPLICATE_SNIPPET_MAX_CHARS 定义）
      expect(details.itemSnippet).toBe(`${head}…`);
      expect(details.promptSnippet).toBe(`work on ${head.slice("work on ".length)}…`);
      // 被截掉多少是可解释的：全量长度照旧带出去
      expect(details.itemChars).toBe(100_000);
      expect(details.promptChars).toBe(100_000 + "work on ".length);
      // 整个 details 仍然很小：1e5 字符的原文一个字都不进 details
      expect(JSON.stringify(details).length).toBeLessThan(500);
      expect(JSON.stringify(r.error)).not.toContain(longItem);
    }
  });

  it("片段边界：正好等于上限不截断，多一个字符就截断并补省略号", () => {
    for (const [length, truncated] of [
      [DUPLICATE_SNIPPET_MAX_CHARS - 1, false],
      [DUPLICATE_SNIPPET_MAX_CHARS, false],
      [DUPLICATE_SNIPPET_MAX_CHARS + 1, true],
    ] as const) {
      const item = "y".repeat(length);
      const r = validateSwarmInput(input({ items: [item, item] }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const details = r.error.details as { itemSnippet: string };
        const expected = truncated ? `${item.slice(0, DUPLICATE_SNIPPET_MAX_CHARS)}…` : item;
        expect(details.itemSnippet).toBe(expected);
        expect(details.itemSnippet.includes("…")).toBe(truncated);
      }
    }
  });

  it("huge 模板场景：片段策略按码元截断，不依赖模板长度", () => {
    const item = "z".repeat(50_000);
    const r = validateSwarmInput({
      items: [item, item],
      promptTemplate: `${"P".repeat(50_000)}{{item}}`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const details = r.error.details as { promptSnippet: string; promptChars: number };
      expect(details.promptSnippet).toBe(`${"P".repeat(DUPLICATE_SNIPPET_MAX_CHARS)}…`);
      expect(details.promptChars).toBe(50_000 + item.length);
    }
  });

  it("item 不同但 trim 后相同 → 同样拒绝", () => {
    const r = validateSwarmInput(input({ items: ["a", "  a  "] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(SWARM_ERROR_CODES.DUPLICATE_PROMPTS);
  });

  it("模板占位符出现多次时仍能正确检测重复", () => {
    const r = validateSwarmInput({
      items: ["a", "a"],
      promptTemplate: "{{item}} and {{item}}",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(SWARM_ERROR_CODES.DUPLICATE_PROMPTS);
  });

  it("非相邻的重复也报错，且报告首次出现位置", () => {
    const r = validateSwarmInput(input({ items: ["a", "b", "c", "a"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details).toMatchObject({ previousIndex: 1, index: 4 });
  });
});

describe("成功路径", () => {
  it("展开 spec、trim item、编号 1 起始连续", () => {
    const r = validateSwarmInput({ items: ["  src/a.ts ", "src/b.ts"], promptTemplate: "review {{item}}" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.specs).toEqual([
      { kind: "spawn", index: 1, item: "src/a.ts", prompt: "review src/a.ts" },
      { kind: "spawn", index: 2, item: "src/b.ts", prompt: "review src/b.ts" },
    ]);
  });
});

// ───────────── clean-room 错误文案（P1-8 路线 A：本仓自拟，不复用上游措辞） ─────────────

describe("clean-room 错误文案", () => {
  // 只断言本仓新文案的关键要素；上游逐字文案刻意不出现在本仓任何文件里。

  it("缺 prompt_template 的文案点名字段，并说明这是 items 带来的要求", () => {
    const r = validateSwarmInput({ items: ["a", "b"] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.PROMPT_TEMPLATE_REQUIRED);
      expect(r.error.message.startsWith("Missing prompt_template")).toBe(true);
      expect(r.error.message).toContain("items");
    }
  });

  it("缺占位符的文案带字面量 {{item}}，便于模型自纠", () => {
    const r = validateSwarmInput({ items: ["a", "b"], promptTemplate: "do the thing" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.PROMPT_TEMPLATE_PLACEHOLDER_MISSING);
      expect(r.error.message).toContain(SWARM_PROMPT_PLACEHOLDER);
      expect(r.error.details).toMatchObject({ placeholder: SWARM_PROMPT_PLACEHOLDER });
    }
  });
});

/**
 * 剩余错误码的文案关键要素断言。
 *
 * 只断言"文案必须携带的要素"——实际值、上限/下限、位置、字面量标识符；
 * 不逐字断言整句：换词、调语序、补一句解释都属于正常文案迭代，不该让测试变红。
 * 断言的落点是 message（模型真正读到的那一面），不是内部实现细节。
 * 失败时列出缺失的要素本身，避免 toContain 那种"看不出差在哪"的红。
 * （PROMPT_TEMPLATE_REQUIRED 与 PLACEHOLDER_MISSING 的关键要素已在上面的块里断言。）
 */
describe("错误文案关键要素（其余错误码）", () => {
  function missingElements(message: string, expected: readonly string[]): string[] {
    return expected.filter((element) => !message.includes(element));
  }

  it("ITEMS_TOO_FEW：带最小条数（下限）与实际条数", () => {
    const zero = validateSwarmInput({ promptTemplate: "{{item}}" });
    expect(zero.ok).toBe(false);
    if (!zero.ok) {
      expect(zero.error.code).toBe(SWARM_ERROR_CODES.ITEMS_TOO_FEW);
      expect(missingElements(zero.error.message, [String(SWARM_MIN_ITEMS), "0"])).toEqual([]);
    }

    const one = validateSwarmInput({ promptTemplate: "{{item}}", items: ["only"] });
    expect(one.ok).toBe(false);
    if (!one.ok) {
      // 实际条数是 1、下限是 2：两个要素缺一不可（只带"至少 2 条"而不说收到几条，
      // 模型无法确认自己是不是真的少给了）。
      expect(missingElements(one.error.message, ["1", String(SWARM_MIN_ITEMS)])).toEqual([]);
    }
  });

  it("TOO_MANY_SUBAGENTS：带上限值与实际条数", () => {
    const items = Array.from({ length: SWARM_MAX_SUBAGENTS + 1 }, (_, i) => `item-${String(i)}`);
    const r = validateSwarmInput(input({ items }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.TOO_MANY_SUBAGENTS);
      expect(
        missingElements(r.error.message, [String(SWARM_MAX_SUBAGENTS), String(items.length)]),
      ).toEqual([]);
    }
  });

  it("ITEM_EMPTY：带 1 起始位置与实际收到的字面量", () => {
    const blank = " \t ";
    const r = validateSwarmInput(input({ items: ["a", "b", blank] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.ITEM_EMPTY);
      expect(missingElements(r.error.message, ["3", JSON.stringify(blank)])).toEqual([]);
    }
  });

  it("ITEM_NOT_STRING：带 1 起始位置与收到的类型描述", () => {
    const r = validateSwarmInput(input({ items: ["a", 42] as unknown as readonly string[] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.ITEM_NOT_STRING);
      expect(missingElements(r.error.message, ["2", "number 42"])).toEqual([]);
    }
  });

  it("DUPLICATE_PROMPTS：带两个 1 起始位置（首次出现处 + 碰撞处）", () => {
    const r = validateSwarmInput(input({ items: ["a", "b", "a"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.DUPLICATE_PROMPTS);
      expect(missingElements(r.error.message, ["1", "3"])).toEqual([]);
      // 文案之外还有机器可读的 details：位置与碰撞文本片段同时给到
      expect(r.error.details).toMatchObject({ previousIndex: 1, index: 3, itemSnippet: "a" });
    }
  });
});


// ─────────────────── per-call 模型路由匹配（resolveSwarmModelRoute）───────────────────

describe("resolveSwarmModelRoute", () => {
  const allowed = [
    { provider: "deepseek", model: "deepseek-chat" },
    { provider: "minimax", model: "MiniMax-M2" },
    { provider: "google", model: "gemini-2.5-pro" },
    { provider: "vertex", model: "gemini-2.5-pro" }, // 与 google 同 model id：歧义测试用
  ];

  it('"provider/model" 精确式：逐字命中即采用', () => {
    const r = resolveSwarmModelRoute("minimax/MiniMax-M2", allowed);
    expect(r).toEqual({ ok: true, route: { provider: "minimax", model: "MiniMax-M2" } });
  });

  it('精确式按第一个 "/" 切分：model id 自身含 "/" 也能命中', () => {
    const fw = [{ provider: "fireworks", model: "accounts/fireworks/models/llama-v3" }];
    const r = resolveSwarmModelRoute("fireworks/accounts/fireworks/models/llama-v3", fw);
    expect(r).toEqual({ ok: true, route: fw[0] });
  });

  it("裸 model id：白名单内唯一时采用", () => {
    const r = resolveSwarmModelRoute("MiniMax-M2", allowed);
    expect(r).toEqual({ ok: true, route: { provider: "minimax", model: "MiniMax-M2" } });
  });

  it("裸 model id 多 provider 命中：MODEL_AMBIGUOUS 并列出候选", () => {
    const r = resolveSwarmModelRoute("gemini-2.5-pro", allowed);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.MODEL_AMBIGUOUS);
      expect(r.error.details?.candidates).toEqual(["google/gemini-2.5-pro", "vertex/gemini-2.5-pro"]);
      expect(r.error.details?.candidateCount).toBe(2);
    }
  });

  it("候选与回显同样封顶：候选超过上限时截断并给总数，超长 model 串只回显片段", () => {
    const many = Array.from({ length: ALLOWED_ROUTES_DETAILS_CAP + 5 }, (_, i) => ({
      provider: `p${String(i)}`,
      model: "shared",
    }));
    const ambiguous = resolveSwarmModelRoute("shared", many);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.error.details?.candidates).toHaveLength(ALLOWED_ROUTES_DETAILS_CAP);
      expect(ambiguous.error.details?.candidateCount).toBe(ALLOWED_ROUTES_DETAILS_CAP + 5);
    }
    const longModel = "m".repeat(10_000);
    const notAllowed = resolveSwarmModelRoute(longModel, many);
    expect(notAllowed.ok).toBe(false);
    if (!notAllowed.ok) {
      expect(notAllowed.error.message.length).toBeLessThan(DUPLICATE_SNIPPET_MAX_CHARS * 3);
    }
  });

  it("不在白名单：MODEL_NOT_ALLOWED 并附允许清单", () => {
    const r = resolveSwarmModelRoute("openai/gpt-5", allowed);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(SWARM_ERROR_CODES.MODEL_NOT_ALLOWED);
      expect(r.error.details?.requested).toBe("openai/gpt-5");
      expect(r.error.details?.allowedCount).toBe(allowed.length);
    }
  });

  it("畸形入参（非字符串 / 空串 / 单边空段）：不抛异常，报 MODEL_NOT_ALLOWED", () => {
    for (const bad of [123, null, undefined, {}, [], "", "   ", "/model", "provider/"]) {
      const r = resolveSwarmModelRoute(bad, allowed);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(SWARM_ERROR_CODES.MODEL_NOT_ALLOWED);
    }
  });

  it(`允许清单在 details 里截断到 ${String(ALLOWED_ROUTES_DETAILS_CAP)} 条并给总数`, () => {
    const big = Array.from({ length: ALLOWED_ROUTES_DETAILS_CAP + 10 }, (_, i) => ({
      provider: `p${String(i)}`,
      model: `m${String(i)}`,
    }));
    const r = resolveSwarmModelRoute("no/such-route", big);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect((r.error.details?.allowedRoutes as unknown[]).length).toBe(ALLOWED_ROUTES_DETAILS_CAP);
      expect(r.error.details?.allowedCount).toBe(big.length);
    }
  });
});

describe("回显截断不劈开代理对（评审第 1 条）", () => {
  it("DUPLICATE_PROMPTS 的片段在 emoji 处截断时不残留孤立代理", () => {
    // 前 119 个码元是 ASCII，第 120/121 个码元是一个 emoji 的代理对 → 旧实现截在两者之间
    const item = `${"a".repeat(DUPLICATE_SNIPPET_MAX_CHARS - 1)}🚀tail`;
    const r = validateSwarmInput(input({ items: [item, item] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const snippet = String(r.error.details?.itemSnippet);
      expect(hasLoneSurrogate(snippet)).toBe(false);
      expect(snippet).toBe(`${"a".repeat(DUPLICATE_SNIPPET_MAX_CHARS - 1)}…`);
    }
  });
});

describe("resolveSwarmContextMode", () => {
  it("缺省 / 空白 → fresh；fresh / fork（允许首尾空白）→ 原值", () => {
    for (const value of [undefined, "", "   "]) {
      expect(resolveSwarmContextMode(value)).toEqual({ ok: true, mode: "fresh" });
    }
    expect(resolveSwarmContextMode("fresh")).toEqual({ ok: true, mode: "fresh" });
    expect(resolveSwarmContextMode(" fork ")).toEqual({ ok: true, mode: "fork" });
  });

  it("其它取值一律 CONTEXT_MODE_INVALID，永不抛异常，回显截断", () => {
    for (const value of ["Fork", "share", 1, null, {}, "x".repeat(10_000)]) {
      const r = resolveSwarmContextMode(value);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe(SWARM_ERROR_CODES.CONTEXT_MODE_INVALID);
        expect(r.error.message.length).toBeLessThan(DUPLICATE_SNIPPET_MAX_CHARS * 2);
      }
    }
  });
});
