import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SwarmScheduler, runSwarm } from "../src/scheduler.js";
import type {
  SwarmAttemptContext,
  SwarmAttemptResult,
  SwarmSchedulerConfig,
  SwarmSchedulerDeps,
  SwarmTaskSpec,
} from "../src/types.js";

// ───────────────────────── 夹具 ─────────────────────────

/**
 * 单任务节奏配置：initialLaunchLimit=1 / maxConcurrency=1。
 *
 * 用它来断言"退避序列"本身。若沿用默认首波 5，限流后容量会落在 4，
 * 于是"何时重试"由**容量**而非**退避延迟**决定，退避序列就被掩盖了。
 */
const SLOW: Partial<SwarmSchedulerConfig> = { initialLaunchLimit: 1, maxConcurrency: 1 };

function specsOf(n: number): SwarmTaskSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "spawn" as const,
    index: i + 1,
    item: `item-${String(i + 1)}`,
    prompt: `prompt-${String(i + 1)}`,
  }));
}

const rateLimitError = (): Error => Object.assign(new Error("429"), { name: "RateLimitError" });

interface RunControl {
  spec: SwarmTaskSpec;
  attempt: number;
  ready: boolean;
  ctx: SwarmAttemptContext;
  resolve(result: SwarmAttemptResult): void;
  reject(error: unknown): void;
}

interface HarnessOptions extends Partial<SwarmSchedulerDeps> {
  /**
   * 是否自动 markReady（默认 true）。设为 false 后由测试显式 `markReady(index)`，
   * 用于构造「首个请求尚未发出就被限流」的重罚场景。
   */
  autoReady?: boolean;
}

/** 手动驾驶的执行器：时钟/定时器/执行函数全部注入，测试完全掌控节奏。 */
function harness(over: HarnessOptions = {}) {
  const { autoReady = true, ...depsOver } = over;
  const runs: RunControl[] = [];

  const deps: SwarmSchedulerDeps = {
    // 必须与 setTimeout 共用同一时钟：vi.useFakeTimers() 会同步推进 Date.now()。
    // 注入冻结的 now() 会让调度器永远认为"还没到点"，退避与容量恢复全部失效。
    now: () => Date.now(),
    setTimeout: (handler, ms) => setTimeout(handler, ms) as unknown,
    clearTimeout: (handle) => {
      clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    },
    isRateLimitError: (error: unknown) => error instanceof Error && error.name === "RateLimitError",
    classify: () => "first-request-blocked",
    executor: {
      run: (spec, ctx) => {
        let resolve!: (r: SwarmAttemptResult) => void;
        let reject!: (e: unknown) => void;
        const promise = new Promise<SwarmAttemptResult>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        const control: RunControl = {
          spec,
          attempt: ctx.attempt,
          ready: false,
          ctx,
          resolve,
          reject,
        };
        runs.push(control);
        ctx.setAgentId(`agent-${String(spec.index)}`);
        // 真实执行函数在 attempt 被中断（用户取消/超时）时会以该原因 reject。
        ctx.signal.addEventListener("abort", () => {
          reject(ctx.signal.reason ?? new Error("aborted"));
        });
        if (autoReady) {
          queueMicrotask(() => {
            if (ctx.signal.aborted) return;
            control.ready = true;
            ctx.markReady();
          });
        }
        return promise;
      },
    },
    ...depsOver,
  };

  const latest = (index: number): RunControl | undefined =>
    [...runs].reverse().find((r) => r.spec.index === index);

  return {
    deps,
    runs,
    /** 已启动的 spec.index 序列（按启动顺序，含重试）。 */
    started: () => runs.map((r) => r.spec.index),
    attemptsOf: (index: number) => runs.filter((r) => r.spec.index === index).length,
    markReady: (index: number) => {
      const last = latest(index);
      if (last === undefined) throw new Error(`markReady: no run for index ${String(index)}`);
      last.ready = true;
      last.ctx.markReady();
    },
    complete: (index: number, result: SwarmAttemptResult = { result: `done-${String(index)}` }) => {
      latest(index)?.resolve(result);
    },
    rateLimit: (index: number, error: unknown = rateLimitError()) => {
      latest(index)?.reject(error);
    },
    fail: (index: number, error: unknown = new Error("boom")) => {
      latest(index)?.reject(error);
    },
  };
}

const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

/**
 * 稳健收尾：反复结算所有已启动的尝试并推进时钟，直到批次 Promise 落定。
 * 对已结算的 Promise 再 resolve 是 no-op，所以重复调用安全；
 * 对已被 reject 的尝试再 resolve 同样是 no-op。
 */
async function drain(h: ReturnType<typeof harness>, p: Promise<unknown>, maxRounds = 80): Promise<void> {
  let settled = false;
  void p.then(() => {
    settled = true;
  });
  for (let i = 0; i < maxRounds && !settled; i += 1) {
    for (const run of [...h.runs]) run.resolve({ result: `ok-${String(run.spec.index)}` });
    await flush(20_000);
  }
  await p;
}

/**
 * 推进时钟直到 `index` 的尝试次数增加。
 *
 * 为什么需要它：限流模式下新任务（retryReadyAt=0）与已退避任务竞争同一个容量槽位，
 * 每次放量还会把全局节流阀往前推一个 globalRetryIntervalMs。所以"第 n 次重试究竟
 * 落在第几毫秒"是**容量 + 全局节流 + 退避就绪时间**三者共同决定的复合结果，
 * 不适合作为退避公式的断言对象。这里改为：每步先让其它成员完成以腾出容量，
 * 再推进时钟，直到目标成员真的被重试——于是断言对象回到纯粹的重试延迟序列。
 */
async function driveRetry(h: ReturnType<typeof harness>, index: number, maxMs = 120_000): Promise<void> {
  const before = h.attemptsOf(index);
  let elapsed = 0;
  while (h.attemptsOf(index) === before && elapsed < maxMs) {
    for (const run of [...h.runs]) if (run.spec.index !== index) run.resolve({ result: "ok" });
    await flush(500);
    elapsed += 500;
  }
  if (h.attemptsOf(index) === before) {
    throw new Error(`driveRetry: #${String(index)} was not retried within ${String(maxMs)}ms`);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────── 正常节奏 ─────────────────────────

describe("正常模式节奏", () => {
  it("首波立即起 5 个，之后每 700ms 放 1 个", async () => {
    const h = harness();
    const p = runSwarm(specsOf(8), h.deps);

    expect(h.started()).toEqual([1, 2, 3, 4, 5]);

    await flush(699);
    expect(h.started()).toHaveLength(5);

    await flush(1); // t=700
    expect(h.started()).toEqual([1, 2, 3, 4, 5, 6]);

    await flush(700); // t=1400
    expect(h.started()).toEqual([1, 2, 3, 4, 5, 6, 7]);

    await flush(700); // t=2100
    expect(h.started()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    for (const i of [1, 2, 3, 4, 5, 6, 7, 8]) h.complete(i);
    const results = await p;
    expect(results.map((r) => r.outcome)).toEqual(Array(8).fill("completed"));
    expect(results.map((r) => r.spec.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("任务少于首波时全部立即启动，不等 700ms", async () => {
    const h = harness();
    const p = runSwarm(specsOf(3), h.deps);
    expect(h.started()).toEqual([1, 2, 3]);
    for (const i of [1, 2, 3]) h.complete(i);
    expect((await p).every((r) => r.outcome === "completed")).toBe(true);
  });

  it("空 spec 集合立即完成", async () => {
    const h = harness();
    expect(await runSwarm([], h.deps)).toEqual([]);
  });

  it("maxConcurrency 压住首波，完成后放行下一个", async () => {
    const h = harness();
    const p = runSwarm(specsOf(6), h.deps, { maxConcurrency: 2 });
    expect(h.started()).toEqual([1, 2]);

    h.complete(1);
    await flush(0);
    expect(h.started()).toEqual([1, 2, 3]);

    await drain(h, p);
  });
});

// ───────────────────────── 限流退避 ─────────────────────────

describe("限流退避序列", () => {
  it("重排队延迟 = 3000ms × 2^(n-1)，无抖动", async () => {
    const suspended: { retryCount: number; retryDelayMs: number; retryReadyAt: number }[] = [];
    const h = harness({ onSuspended: (e) => suspended.push(e) });
    const p = runSwarm(specsOf(6), h.deps, SLOW);
    expect(h.started()).toEqual([1]);
    await flush(0);

    // 第 1 次限流 → 3000ms。此刻容量空闲，故可精确断言"到点才重试"。
    h.rateLimit(1);
    await flush(0);
    expect(suspended[0]?.retryCount).toBe(1);
    expect(suspended[0]?.retryDelayMs).toBe(3000);
    expect(suspended[0]?.retryReadyAt).toBe(Date.now() + 3000);

    await flush(2999);
    expect(h.attemptsOf(1)).toBe(1); // 绝不早于 retryReadyAt
    await flush(1);
    expect(h.attemptsOf(1)).toBe(2);
    expect(h.runs.filter((r) => r.spec.index === 1)[1]?.attempt).toBe(2);

    // 第 2 次 → 6000ms
    h.rateLimit(1);
    await flush(0);
    expect(suspended[1]?.retryCount).toBe(2);
    expect(suspended[1]?.retryDelayMs).toBe(6000);
    expect(suspended[1]?.retryReadyAt).toBe(Date.now() + 6000);

    await driveRetry(h, 1);
    expect(h.attemptsOf(1)).toBe(3);

    // 第 3 次 → 12000ms
    h.rateLimit(1);
    await flush(0);
    expect(suspended[2]?.retryCount).toBe(3);
    expect(suspended[2]?.retryDelayMs).toBe(12_000);
    expect(suspended[2]?.retryReadyAt).toBe(Date.now() + 12_000);

    await driveRetry(h, 1);
    expect(h.attemptsOf(1)).toBe(4);

    await drain(h, p);
  });

  it("退避未到期前不放量；容量未腾出时也不放量", async () => {
    const h = harness();
    const p = runSwarm(specsOf(6), h.deps, { initialLaunchLimit: 2, maxConcurrency: 2 });
    await flush(0);
    expect(h.started()).toEqual([1, 2]);

    h.rateLimit(1);
    await flush(0);
    // 容量 = 已成功启动数(2) - 1 = 1，在跑的 2 号占满 → 即使退避已到期也不放量
    await flush(3000);
    expect(h.attemptsOf(1)).toBe(1);
    expect(h.started()).toEqual([1, 2]);

    // 2 号完成腾出容量 → 1 号立刻按退避就绪时间重试
    h.complete(2);
    await flush(0);
    expect(h.attemptsOf(1)).toBe(2);

    await drain(h, p);
  });

  it("重排队任务优先于尚未启动的新任务", async () => {
    const h = harness();
    const p = runSwarm(specsOf(6), h.deps, { initialLaunchLimit: 2, maxConcurrency: 2 });
    await flush(0);
    expect(h.started()).toEqual([1, 2]);

    h.rateLimit(1);
    await flush(0);
    h.complete(2);
    await flush(3000);

    // 1 号（重排队）先于 3 号（从未启动）被放量
    expect(h.started()).toEqual([1, 2, 1]);
    expect(h.attemptsOf(3)).toBe(0);

    await drain(h, p);
  });

  it("限流回调 onSuspended 带上 spec 与原因", async () => {
    const suspended: { index: number; reason: string }[] = [];
    const h = harness({ onSuspended: (e) => suspended.push({ index: e.spec.index, reason: e.reason }) });
    const p = runSwarm(specsOf(3), h.deps, SLOW);
    await flush(0);
    h.rateLimit(1);
    await flush(0);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]?.index).toBe(1);
    expect(suspended[0]?.reason).toMatch(/rate limit/i);
    await drain(h, p);
  });
});

// ───────────────────────── 容量收缩 / 恢复 ─────────────────────────

describe("容量收缩与恢复", () => {
  it("进入限流模式时容量 = 已成功启动数 - 1", async () => {
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(10), h.deps);
    const p = scheduler.run();
    await flush(0);
    expect(scheduler.snapshot().startedSuccessCount).toBe(5);

    h.rateLimit(1);
    await flush(0);
    const snap = scheduler.snapshot();
    expect(snap.rateLimitMode).toBe(true);
    expect(snap.rateLimitCapacity).toBe(4); // max(1, 5) - 1

    await drain(h, p);
  });

  it("容量收缩有 2000ms 防抖，超过后才继续 -1", async () => {
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(10), h.deps);
    const p = scheduler.run();
    await flush(0);

    h.rateLimit(1);
    await flush(0);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(4);

    // 防抖窗口内再来一次限流 → 容量不动
    await flush(1000);
    h.rateLimit(2);
    await flush(0);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(4);

    // 跨过 2000ms 窗口后再限流 → 允许收缩
    await flush(1001);
    h.rateLimit(3);
    await flush(0);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(3);

    await drain(h, p);
  });

  it("容量下限为 1", async () => {
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(4), h.deps, SLOW);
    const p = scheduler.run();
    await flush(0);
    expect(scheduler.snapshot().startedSuccessCount).toBe(1);

    // max(1, 1) = 1，再 -1 → 被下限钉在 1
    h.rateLimit(1);
    await flush(0);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(1);

    await drain(h, p);
  });

  it("每 180s 容量 +1 恢复，并把放量时刻拉回当下", async () => {
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(10), h.deps, SLOW);
    const p = scheduler.run();
    await flush(0);
    h.rateLimit(1);
    await flush(0);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(1);

    await flush(179_999);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(1);

    await flush(1); // 满 180s
    expect(scheduler.snapshot().rateLimitCapacity).toBe(2);

    // 第二个 180s 窗口。
    //
    // 这里不能再断言「容量涨到 3」，因为 F3 放宽死锁防护后 1 号会被重排队并真的重启，
    // 于是 active 恒为 1；而容量恢复只在 #scheduleRateLimitLaunch 的一轮里发生，
    // 该方法开头先判 `active.size >= rateLimitCapacity` 就返回（尚未 +1）。
    // 换言之：**满载时容量恢复被并发闸门挡住**，这是既有设计，不是本次改动引入的。
    // 旧用例之所以能连涨到 3，恰恰是因为旧行为下 1 号首次限流即被判死、不再重排队，
    // active 才会在 t=180s 时归零。
    //
    // 因此本用例收敛为它真正要验的那一条：180s 时刻容量确实 +1（1 → 2）。
    // 「满载时恢复被挡」由下面的独立回归用例显式钉住。
    expect(scheduler.snapshot().rateLimitCapacity).toBe(2);

    await drain(h, p);
  });

  it("回归：满载（active 达到容量）时容量恢复被并发闸门挡住，不靠清空队列也能测", async () => {
    // 把 F3 造成的行为变化钉成显式契约，避免以后有人误把它当成回归改回去：
    // 1 号首次限流 → 退避重排队（不再判死）；
    // 到 180s 容量恢复到 2 并真的重启 1 号；
    // 此后 active 恒为 1（maxConcurrency=1），恢复闸门关闭，容量停在 2。
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(10), h.deps, SLOW);
    const p = scheduler.run();
    await flush(0);
    h.rateLimit(1);
    await flush(0);
    expect(h.attemptsOf(1)).toBe(1);

    await flush(180_000);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(2);
    expect(h.attemptsOf(1)).toBe(2); // 恢复瞬间真的重试了，不是判死

    await flush(180_000);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(2); // 满载，恢复被挡住

    await drain(h, p);
  });

  it("回归：限流模式满并发时仍装唤醒定时器，容量恢复不被饿死", async () => {
    // F5 修复引入的回归护栏：满并发时若直接 return 而不装唤醒定时器，
    // 180s 容量恢复将永远等不到 tick，恢复机制被静默饿死。
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(10), h.deps, {
      initialLaunchLimit: 1,
      maxConcurrency: 1,
    });
    const p = scheduler.run();
    await flush(0);
    h.rateLimit(1);
    await flush(0);

    // 推进到第一个恢复点：容量必须真的 +1（说明唤醒定时器被正确装上了）。
    await flush(180_000);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(2);

    await drain(h, p);
  });
});

// ───────────────────────── 重罚 / 轻罚 ─────────────────────────

describe("首个请求未发出的重罚 vs 运行中被限流的轻罚", () => {
  it("ready 前被限流 → 全局间隔翻倍（6000ms）", async () => {
    const h = harness({ autoReady: false });
    const scheduler = new SwarmScheduler(specsOf(6), h.deps, SLOW);
    const p = scheduler.run();
    await flush(0);
    expect(h.runs[0]?.ready).toBe(false);

    h.rateLimit(1); // 从未 markReady：模拟"连首个请求都没发出去"
    await flush(0);

    const snap = scheduler.snapshot();
    expect(snap.rateLimitMode).toBe(true);
    expect(snap.startedSuccessCount).toBe(0);
    expect(snap.rateLimitCapacity).toBe(1); // max(1, 0) - 1 → 下限 1
    expect(snap.globalRetryIntervalMs).toBe(6000); // 3000 × 2
    expect(snap.nextRateLimitLaunchAt).toBe(Date.now() + 6000);

    await drain(h, p);
  });

  it("ready 后被限流 → 全局间隔只推 3000ms", async () => {
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(6), h.deps, SLOW);
    const p = scheduler.run();
    await flush(0);
    expect(h.runs[0]?.ready).toBe(true);

    h.rateLimit(1);
    await flush(0);
    const snap = scheduler.snapshot();
    expect(snap.globalRetryIntervalMs).toBe(3000);
    expect(snap.nextRateLimitLaunchAt).toBe(Date.now() + 3000);

    await drain(h, p);
  });

  it("markReady 后全局间隔复位回 3000ms", async () => {
    const h = harness({ autoReady: false });
    const scheduler = new SwarmScheduler(specsOf(6), h.deps, { initialLaunchLimit: 2, maxConcurrency: 2 });
    const p = scheduler.run();
    await flush(0);

    h.rateLimit(1); // 重罚 → 6000
    await flush(0);
    expect(scheduler.snapshot().globalRetryIntervalMs).toBe(6000);

    h.markReady(2); // 2 号发出首个请求 → 复位
    expect(scheduler.snapshot().globalRetryIntervalMs).toBe(3000);

    await drain(h, p);
  });
});

// ───────────────────────── 死锁防护 ─────────────────────────

describe("死锁防护", () => {
  /**
   * 判死门槛：只剩它一个未完成 **且** retryCount >= 1（已退避重试过一次仍限流）。
   * 相对上游是有意放宽（见 src/scheduler.ts #handleAttemptOutcome 的偏离说明）。
   */
  it("只剩一个未完成任务且它持续限流（已重试过）→ 判 failed 并回调 onAbandoned", async () => {
    const abandoned: { index: number; outcome: string }[] = [];
    const h = harness({ onAbandoned: (e) => abandoned.push({ index: e.spec.index, outcome: e.outcome }) });
    const p = runSwarm(specsOf(3), h.deps);
    await flush(0);

    h.complete(2);
    h.complete(3);
    await flush(0);

    // 第一次限流：不再直接判死，退避重排队（这是与上游的差异点）。
    h.rateLimit(1);
    await flush(3000);
    expect(abandoned).toHaveLength(0);

    // 重试后仍然限流 → 此刻 retryCount >= 1，判死。
    h.rateLimit(1);
    const results = await p;

    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.error).toMatch(/rate limit/i);
    expect(results[0]?.state).toBe("started");
    expect(results[1]?.outcome).toBe("completed");
    expect(results[2]?.outcome).toBe("completed");
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.index).toBe(1);
    expect(abandoned[0]?.outcome).toBe("failed");
  });

  it("回归：只剩一个未完成任务时的首次限流不判死，退避后重试仍可成功", async () => {
    const abandoned: unknown[] = [];
    const h = harness({ onAbandoned: (e) => abandoned.push(e) });
    const p = runSwarm(specsOf(3), h.deps);
    await flush(0);

    h.complete(2);
    h.complete(3);
    await flush(0);

    // 首次限流：只重排队，不放弃（F3 修复前这里会立刻判 failed）。
    h.rateLimit(1);
    await flush(3000);
    expect(abandoned).toHaveLength(0);
    expect(h.attemptsOf(1)).toBe(2);

    // 第二次尝试成功 → 该成员正常完成，没有任何成员被放弃。
    h.complete(1);
    const results = await p;
    expect(results[0]?.outcome).toBe("completed");
    expect(abandoned).toHaveLength(0);
  });

  it("还有别的未完成任务时限流只重排队，不判 failed", async () => {
    const abandoned: unknown[] = [];
    const h = harness({ onAbandoned: (e) => abandoned.push(e) });
    const p = runSwarm(specsOf(3), h.deps);
    await flush(0);

    h.complete(3);
    await flush(0);
    h.rateLimit(1);
    await flush(3000);
    expect(abandoned).toHaveLength(0);
    expect(h.attemptsOf(1)).toBe(2);

    await drain(h, p);
  });

  it("死锁防护只对限流生效；普通失败本来就判 failed", async () => {
    const h = harness();
    const p = runSwarm(specsOf(2), h.deps);
    await flush(0);
    h.fail(1, new Error("hard failure"));
    h.complete(2);
    const results = await p;
    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.error).toBe("hard failure");
  });
});

// ───────────────────────── 中断 ─────────────────────────

describe("中断", () => {
  it("abort → 已完成保留、在跑标 aborted、未启动不再启动", async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    const p = runSwarm(specsOf(10), h.deps);
    await flush(0);

    h.complete(1);
    await flush(0);
    const runsBefore = h.runs.length;

    controller.abort();
    const results = await p;

    expect(results).toHaveLength(10);
    expect(results[0]?.outcome).toBe("completed");
    expect(results[1]?.outcome).toBe("aborted");
    expect(results[1]?.state).toBe("started");
    expect(results[1]?.error).toMatch(/interrupted/i);
    expect(results[5]?.outcome).toBe("aborted");
    expect(results[5]?.state).toBe("not_started");
    expect(h.runs.length).toBe(runsBefore);
  });

  it("传入已 aborted 的 signal → 全部 aborted 且不启动任何任务", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });
    const results = await runSwarm(specsOf(3), h.deps);
    expect(h.runs).toHaveLength(0);
    expect(results.map((r) => r.outcome)).toEqual(["aborted", "aborted", "aborted"]);
    expect(results.every((r) => r.state === "not_started")).toBe(true);
  });

  it("abort 触发 onAbandoned(cancelled)，只针对建了但没跑起来的成员", async () => {
    const controller = new AbortController();
    const abandoned: string[] = [];
    const h = harness({
      signal: controller.signal,
      autoReady: false,
      onAbandoned: (e) => abandoned.push(e.outcome),
    });
    const p = runSwarm(specsOf(2), h.deps, { maxConcurrency: 2 });
    await flush(0);
    expect(h.runs.every((r) => r.ready)).toBe(false);

    controller.abort();
    await p;
    expect(abandoned).toEqual(["cancelled", "cancelled"]);
  });

  it("已 ready 的成员不计入挂起清理（由 abort 路径处理终态）", async () => {
    const controller = new AbortController();
    const abandoned: string[] = [];
    const h = harness({ signal: controller.signal, onAbandoned: (e) => abandoned.push(e.outcome) });
    const p = runSwarm(specsOf(3), h.deps);
    await flush(0);
    expect(h.runs.every((r) => r.ready)).toBe(true);

    controller.abort();
    await p;
    expect(abandoned).toEqual([]);
  });

  it("中断时在跑任务的 attempt signal 被 abort", async () => {
    const controller = new AbortController();
    let aborted = 0;
    const h = harness({
      signal: controller.signal,
      executor: {
        run: (_spec, ctx) =>
          new Promise<SwarmAttemptResult>((_res, rej) => {
            ctx.signal.addEventListener("abort", () => {
              aborted += 1;
              rej(ctx.signal.reason ?? new Error("aborted"));
            });
          }),
      },
    });
    const p = runSwarm(specsOf(2), h.deps);
    await flush(0);
    controller.abort();
    await p;
    expect(aborted).toBe(2);
  });

  it("回归：批次中断时，从未启动的排队成员也必须收到 onAbandoned(cancelled)", async () => {
    const controller = new AbortController();
    const abandoned: { index: number; agentId?: string }[] = [];
    const h = harness({
      signal: controller.signal,
      onAbandoned: (e) =>
        abandoned.push({ index: e.spec.index, ...(e.agentId === undefined ? {} : { agentId: e.agentId }) }),
    });
    const p = runSwarm(specsOf(8), h.deps, { initialLaunchLimit: 1 });
    await flush(0);
    expect(h.started()).toEqual([1]); // 首波只放 1 个，其余 7 个仍在队列里

    controller.abort();
    await p;

    // 跑起来的 #1 由 abort 路径处理终态；从未启动的 #2..#8 必须走同一条放弃路径，
    // 否则宿主（registry）永远不知道它们已经不可能再启动。
    expect(abandoned.map((e) => e.index)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    // 从未启动的成员没有 agentId —— 事件里不得伪造
    expect(abandoned.every((e) => e.agentId === undefined)).toBe(true);
    // 中断路径必须把那支"首波之后每 700ms 放一个"的定时器清干净（leftovers=0 回归护栏）
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ───────────────────────── 超时 ─────────────────────────

describe("超时", () => {
  it("超过 timeoutMs 判 failed，文案为超时", async () => {
    const h = harness();
    const p = runSwarm(specsOf(2), h.deps, { timeoutMs: 5000 });
    await flush(0);
    h.complete(2);
    await flush(5000);
    const results = await p;
    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.error).toBe("Subagent timed out.");
    expect(results[1]?.outcome).toBe("completed");
  });

  it("timeoutMs 为 0 或未设时不超时", async () => {
    const h = harness();
    const p = runSwarm(specsOf(2), h.deps, { timeoutMs: 0 });
    await flush(0);
    await flush(10_000_000);
    h.complete(1);
    h.complete(2);
    const results = await p;
    expect(results.every((r) => r.outcome === "completed")).toBe(true);
  });
});

// ───────────────────────── 结果落位 ─────────────────────────

describe("结果落位", () => {
  it("结果按 index 落位，乱序完成也不乱序", async () => {
    const h = harness();
    const p = runSwarm(specsOf(3), h.deps);
    await flush(0);
    h.complete(3, { result: "c" });
    h.complete(1, { result: "a" });
    h.complete(2, { result: "b" });
    const results = await p;
    expect(results.map((r) => r.result)).toEqual(["a", "b", "c"]);
    expect(results.map((r) => r.spec.index)).toEqual([1, 2, 3]);
  });

  it("非限流失败判 failed 并带错误文案，state=started", async () => {
    const h = harness();
    const p = runSwarm(specsOf(2), h.deps);
    await flush(0);
    h.fail(1, new Error("provider exploded"));
    h.complete(2);
    const results = await p;
    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.error).toBe("provider exploded");
    expect(results[0]?.state).toBe("started");
  });

  it("stopReason 透传", async () => {
    const h = harness();
    const p = runSwarm(specsOf(2), h.deps);
    await flush(0);
    h.complete(1, { result: "partial", stopReason: "max_tokens" });
    h.complete(2);
    const results = await p;
    expect(results[0]?.stopReason).toBe("max_tokens");
  });

  it("执行器同步抛出（非 reject）也判 failed", async () => {
    const h = harness({
      executor: {
        run: () => {
          throw new Error("sync boom");
        },
      },
    });
    const results = await runSwarm(specsOf(2), h.deps);
    expect(results.every((r) => r.outcome === "failed")).toBe(true);
    expect(results[0]?.error).toBe("sync boom");
  });
});

// ───────────────────────── 配置 ─────────────────────────

describe("配置校验与自定义", () => {
  it("非法 config 直接抛错", () => {
    const h = harness();
    expect(() => new SwarmScheduler(specsOf(2), h.deps, { initialLaunchLimit: 0 })).toThrow(/initialLaunchLimit/);
    expect(() => new SwarmScheduler(specsOf(2), h.deps, { retryFactor: 0.5 })).toThrow(/retryFactor/);
    expect(() => new SwarmScheduler(specsOf(2), h.deps, { retryBaseMs: -1 })).toThrow(/retryBaseMs/);
  });

  it("自定义节奏参数生效", async () => {
    const h = harness();
    const p = runSwarm(specsOf(4), h.deps, { initialLaunchLimit: 1, initialLaunchIntervalMs: 100 });
    expect(h.started()).toEqual([1]);
    await flush(100);
    expect(h.started()).toEqual([1, 2]);
    await flush(100);
    expect(h.started()).toEqual([1, 2, 3]);
    await flush(100);
    expect(h.started()).toEqual([1, 2, 3, 4]);
    for (const i of [1, 2, 3, 4]) h.complete(i);
    expect((await p).length).toBe(4);
  });

  it("自定义 retryBaseMs / retryFactor 影响退避序列", async () => {
    const suspended: { retryCount: number; retryDelayMs: number; retryReadyAt: number }[] = [];
    const h = harness({ onSuspended: (e) => suspended.push(e) });
    const p = runSwarm(specsOf(3), h.deps, { ...SLOW, retryBaseMs: 100, retryFactor: 3 });
    await flush(0);

    h.rateLimit(1);
    await flush(0);
    expect(suspended[0]?.retryDelayMs).toBe(100); // 100 × 3^0
    expect(suspended[0]?.retryReadyAt).toBe(Date.now() + 100);

    await flush(99);
    expect(h.attemptsOf(1)).toBe(1);
    await flush(1);
    expect(h.attemptsOf(1)).toBe(2);

    h.rateLimit(1);
    await flush(0);
    expect(suspended[1]?.retryDelayMs).toBe(300); // 100 × 3^1
    expect(suspended[1]?.retryReadyAt).toBe(Date.now() + 300);

    await driveRetry(h, 1);
    expect(h.attemptsOf(1)).toBe(3);

    await drain(h, p);
  });
});

// ───────────────────────── 规模 ─────────────────────────

describe("规模", () => {
  it("128 个成员全部完成，结果长度与编号一致", async () => {
    const h = harness();
    const p = runSwarm(specsOf(128), h.deps);
    await flush(0);
    expect(h.started()).toHaveLength(5);

    // 放量完 128 个需要 (128 - 5) × 700ms
    await flush(123 * 700 + 10);
    expect(h.runs).toHaveLength(128);

    for (const r of h.runs) r.resolve({ result: `ok-${String(r.spec.index)}` });
    const results = await p;
    expect(results).toHaveLength(128);
    expect(results.map((r) => r.spec.index)).toEqual(Array.from({ length: 128 }, (_, i) => i + 1));
  });
});