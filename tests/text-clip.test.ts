import { describe, expect, it } from "vitest";
import { clipText, sliceCodeUnitsSafely, sliceJsonTextSafely } from "../src/text-clip.js";
import { endsInsideJsonEscape, hasLoneSurrogate } from "./helpers/surrogates.js";

describe("sliceCodeUnitsSafely / clipText：截断点不劈开代理对", () => {
  it("复现评审给出的反例：'🚀🚀' 截 3 个码元不再残留高代理", () => {
    const sliced = sliceCodeUnitsSafely("🚀🚀", 3);
    expect(sliced).toBe("🚀");
    expect(hasLoneSurrogate(sliced)).toBe(false);
  });

  it("截断点落在 BMP 字符之间时照常截满 max 个码元", () => {
    expect(sliceCodeUnitsSafely("abcdef", 4)).toBe("abcd");
    expect(sliceCodeUnitsSafely("中文字符", 2)).toBe("中文");
  });

  it("任意截断位置都不会产生孤立代理，且结果是原文前缀、最多少截一个码元", () => {
    const text = "a🚀b😀😀c𠮷d";
    for (let max = 0; max <= text.length + 1; max += 1) {
      const sliced = sliceCodeUnitsSafely(text, max);
      expect(hasLoneSurrogate(sliced)).toBe(false);
      expect(text.startsWith(sliced)).toBe(true);
      expect(sliced.length).toBeLessThanOrEqual(Math.max(0, max));
      expect(sliced.length).toBeGreaterThanOrEqual(Math.min(text.length, max) - 1);
    }
  });

  it("clipText：超长才补省略号，未超长原样返回", () => {
    expect(clipText("short", 10)).toBe("short");
    expect(clipText("🚀🚀", 3)).toBe("🚀…");
  });
});

describe("sliceJsonTextSafely：不切碎 JSON 转义序列", () => {
  it("在任意位置截断 JSON.stringify 的输出，都不会落在转义序列或代理对中间", () => {
    const json = JSON.stringify({
      a: 'q"uote\\back\nline\u001bctl',
      b: "🚀x",
      c: "\\\\\"",
    });
    for (let max = 0; max <= json.length; max += 1) {
      const sliced = sliceJsonTextSafely(json, max);
      expect(endsInsideJsonEscape(sliced), `max=${String(max)} → ${sliced}`).toBe(false);
      expect(hasLoneSurrogate(sliced)).toBe(false);
      expect(json.startsWith(sliced)).toBe(true);
    }
  });

  it("截断点恰在 \\u001b 中间时退到转义起点之前", () => {
    const json = JSON.stringify({ k: "x\u001by" });
    const escapeStart = json.indexOf("\\u");
    expect(escapeStart).toBeGreaterThan(0);
    expect(sliceJsonTextSafely(json, escapeStart + 3)).toBe(json.slice(0, escapeStart));
  });

  it("未超长时原样返回", () => {
    const json = JSON.stringify({ k: "v" });
    expect(sliceJsonTextSafely(json, 100)).toBe(json);
  });
});
