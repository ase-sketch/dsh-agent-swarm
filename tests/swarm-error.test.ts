import { describe, expect, it } from "vitest";
import {
  ERROR_DETAILS_MAX_CHARS,
  SWARM_ERROR_NAME,
  formatSwarmErrorMessage,
  toThrownSwarmError,
} from "../src/swarm-error.js";
import { SWARM_ERROR_CODES } from "../src/types.js";
import { endsInsideJsonEscape, hasLoneSurrogate } from "./helpers/surrogates.js";

/**
 * 结构化错误 → 模型可见文本。
 *
 * 背景：DSH 把 execute 抛出的异常转成工具结果时，模型只看得到 `Error: ${message}`；
 * 挂在 Error 上的自定义字段（swarmErrorCode / swarmErrorDetails）对模型不可见。
 * 这里断言的落点因此一律是 message。
 */
describe("formatSwarmErrorMessage", () => {
  it("message 以 [CODE] 开头，模型能按错误码区分失败类别", () => {
    const text = formatSwarmErrorMessage({ code: SWARM_ERROR_CODES.ITEMS_TOO_FEW, message: "need 2" });
    expect(text).toBe("[ITEMS_TOO_FEW] need 2");
  });

  it("有 details 时另起一行附紧凑 JSON：候选清单等自纠信息进入模型可见文本", () => {
    const text = formatSwarmErrorMessage({
      code: SWARM_ERROR_CODES.MODEL_AMBIGUOUS,
      message: "ambiguous",
      details: { requested: "m", candidates: ["p/m", "q/m"] },
    });
    expect(text).toBe('[MODEL_AMBIGUOUS] ambiguous\nDetails: {"requested":"m","candidates":["p/m","q/m"]}');
  });

  it("details 总长封顶并注明原长，绝不用一条报错挤爆上下文", () => {
    const huge = "x".repeat(ERROR_DETAILS_MAX_CHARS * 3);
    const text = formatSwarmErrorMessage({
      code: SWARM_ERROR_CODES.DUPLICATE_PROMPTS,
      message: "dup",
      details: { blob: huge },
    });
    const detailsLine = text.split("\n")[1] ?? "";
    expect(detailsLine.length).toBeLessThan(ERROR_DETAILS_MAX_CHARS + 80);
    expect(detailsLine).toMatch(/…\(truncated, \d+ chars total\)$/);
  });

  it("details 截断点落在 emoji 或转义序列中间时，退到完整字符 / 完整转义之前（评审第 1 条）", () => {
    for (let pad = 0; pad < 12; pad += 1) {
      const text = formatSwarmErrorMessage({
        code: SWARM_ERROR_CODES.DUPLICATE_PROMPTS,
        message: "dup",
        details: { blob: `${"x".repeat(ERROR_DETAILS_MAX_CHARS - 12 + pad)}🚀"\u001b\\🚀` },
      });
      const kept = (text.split("\nDetails: ")[1] ?? "").split("…(truncated")[0] ?? "";
      expect(hasLoneSurrogate(kept)).toBe(false);
      expect(endsInsideJsonEscape(kept)).toBe(false); // 不以悬空反斜杠或残缺的 \u 结尾
    }
  });

  it("details 不可序列化时退回只给 [CODE] message，报错本身不变成另一个异常", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      formatSwarmErrorMessage({ code: SWARM_ERROR_CODES.INVALID_INPUT, message: "bad", details: cyclic }),
    ).toBe("[INVALID_INPUT] bad");
    expect(
      formatSwarmErrorMessage({ code: SWARM_ERROR_CODES.INVALID_INPUT, message: "bad", details: { n: 1n } }),
    ).toBe("[INVALID_INPUT] bad");
  });
});

describe("toThrownSwarmError", () => {
  it("message 用模型可见格式，同时保留机器可读字段供日志与测试", () => {
    const error = toThrownSwarmError({
      code: SWARM_ERROR_CODES.TOO_MANY_SUBAGENTS,
      message: "too many",
      details: { total: 3, max: 2 },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(SWARM_ERROR_NAME);
    expect(error.message).toBe('[TOO_MANY_SUBAGENTS] too many\nDetails: {"total":3,"max":2}');
    expect(error.swarmErrorCode).toBe("TOO_MANY_SUBAGENTS");
    expect(error.swarmErrorDetails).toEqual({ total: 3, max: 2 });
  });

  it("没有 details 时不挂 swarmErrorDetails 字段", () => {
    const error = toThrownSwarmError({ code: SWARM_ERROR_CODES.PROMPT_TEMPLATE_REQUIRED, message: "m" });
    expect("swarmErrorDetails" in error).toBe(false);
  });
});
