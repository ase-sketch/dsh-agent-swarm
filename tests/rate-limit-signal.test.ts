import { describe, expect, it } from "vitest";
import { ChildRunWatch, RateLimitWatchRouter } from "../src/rate-limit-signal.js";

const CONFIG = { failureCodes: ["RATE_LIMIT"] } as const;

/** DSH dsh-llm-retry 追加的重试事件（data.failure.code 是这次失败的码）。 */
function retry(code: string) {
  return { type: "llm/retry", data: { retry: 1, delayMs: 500, failure: { code, message: "x" } } };
}

/** DSH dsh-agent-loop 追加的轮末事件；失败收场时 reason.error 是最终失败。 */
function turnEndError(code: string) {
  return { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { code, message: "x" } } } };
}

describe("ChildRunWatch：子代理收场时判定是否被限流拖死", () => {
  it("以 error 收场且轮末最终失败码是限流码 → 判限流，并给出子代理内部的限流重试次数", () => {
    const watch = new ChildRunWatch(CONFIG);
    for (let i = 0; i < 5; i += 1) watch.observe(retry("RATE_LIMIT"));
    watch.observe(turnEndError("RATE_LIMIT"));
    expect(watch.assess("error")).toEqual({ rateLimited: true, rateLimitRetries: 5, failureCode: "RATE_LIMIT" });
  });

  it("最终失败码优先：重试期间限流、最终却是别的错误 → 不判限流", () => {
    const watch = new ChildRunWatch(CONFIG);
    watch.observe(retry("RATE_LIMIT"));
    watch.observe(turnEndError("CONTEXT_WINDOW_EXCEEDED"));
    expect(watch.assess("error")).toMatchObject({ rateLimited: false, failureCode: "CONTEXT_WINDOW_EXCEEDED" });
  });

  it("拿不到轮末失败码时退而看最后一次重试的失败码", () => {
    const watch = new ChildRunWatch(CONFIG);
    watch.observe(retry("SERVER"));
    watch.observe(retry("RATE_LIMIT"));
    expect(watch.assess("error")).toMatchObject({ rateLimited: true, failureCode: "RATE_LIMIT" });
  });

  it("非 error 收场一律不判限流（取消/超时/截断/拒答都不是限流）", () => {
    const watch = new ChildRunWatch(CONFIG);
    watch.observe(turnEndError("RATE_LIMIT"));
    for (const stopReason of ["completed", "aborted", "max-tokens", "refusal"]) {
      expect(watch.assess(stopReason).rateLimited).toBe(false);
    }
  });

  it("没观测到任何失败码（例如事件没送达）→ 不猜，不判限流", () => {
    expect(new ChildRunWatch(CONFIG).assess("error")).toEqual({
      rateLimited: false,
      rateLimitRetries: 0,
      failureCode: undefined,
    });
  });

  it("形状不符的事件 data 一律忽略，绝不抛错", () => {
    const watch = new ChildRunWatch(CONFIG);
    for (const data of [undefined, null, 42, "x", { failure: null }, { reason: { kind: "error", error: 7 } }]) {
      expect(() => watch.observe({ type: "llm/retry", data })).not.toThrow();
      expect(() => watch.observe({ type: "turn/end", data })).not.toThrow();
    }
    expect(watch.assess("error").rateLimited).toBe(false);
  });

  it("限流码集合可配置（实机确认的取值可能不同）", () => {
    const watch = new ChildRunWatch({ failureCodes: ["RATE_LIMITED", "QUOTA"] });
    watch.observe(turnEndError("QUOTA"));
    expect(watch.assess("error").rateLimited).toBe(true);
  });
});

describe("RateLimitWatchRouter：按子会话 id 路由事件", () => {
  it("只把被观察的子会话、且是关心类型的事件交给观察窗", () => {
    const router = new RateLimitWatchRouter(CONFIG);
    const watch = router.watch("child-1");
    router.dispatch("other-session", turnEndError("RATE_LIMIT"));
    router.dispatch("child-1", { type: "assistant/message", data: {} });
    expect(watch.assess("error").rateLimited).toBe(false);
    router.dispatch("child-1", turnEndError("RATE_LIMIT"));
    expect(watch.assess("error").rateLimited).toBe(true);
  });

  it("release 之后不再记录，也不残留观察窗", () => {
    const router = new RateLimitWatchRouter(CONFIG);
    const watch = router.watch("child-2");
    expect(router.size).toBe(1);
    router.release("child-2");
    expect(router.size).toBe(0);
    router.dispatch("child-2", turnEndError("RATE_LIMIT"));
    expect(watch.assess("error").rateLimited).toBe(false);
  });
});
