import { describe, expect, it } from "vitest";

import {
  SWARM_ERROR_CODES,
  SWARM_MAX_SUBAGENTS,
  SWARM_PROMPT_PLACEHOLDER,
  type SwarmRequestInput,
} from "../src/types.js";
import { expandPromptTemplate, validateSwarmInput } from "../src/validate.js";

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
  it("128 个 item 通过（上边界）", () => {
    const items = Array.from({ length: 128 }, (_, i) => `item-${String(i)}`);
    const r = validateSwarmInput(input({ items }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.specs).toHaveLength(128);
      expect(r.specs[127]?.index).toBe(128);
    }
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
