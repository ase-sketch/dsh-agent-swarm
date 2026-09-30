
import { describe, it, expect } from "vitest";
import { runSwarm } from "../src/scheduler.js";
import { renderSwarmResult } from "../src/result-xml.js";
import { SwarmRegistry } from "../src/swarm-registry.js";
import type {
  SwarmAttemptResult,
  SwarmSchedulerDeps,
  SwarmTaskResult,
  SwarmTaskSpec,
} from "../src/types.js";

describe("SwarmRegistry state machine", () => {
  it("initializes members in pending phase and tracks counts correctly", () => {
    const reg = new SwarmRegistry();
    const specs = [
      { index: 1, item: "task 1" },
      { index: 2, item: "task 2" },
      { index: 3, item: "task 3" },
    ];
    const swarmId = reg.beginBatch("sess-1", "Test batch", specs, 1000);

    const batch = reg.getBatch(swarmId);
    expect(batch).toBeDefined();
    expect(batch?.total).toBe(3);
    expect(batch?.status).toBe("running");

    const roster1 = reg.toRosterFrame(batch!, 1050);
    expect(roster1.activeCount).toBe(0);
    expect(roster1.completedCount).toBe(0);
    expect(roster1.failedCount).toBe(0);
    expect(roster1.abortedCount).toBe(0);
    expect(roster1.members.every((m) => m.phase === "pending")).toBe(true);

    // mark starting & agentId
    reg.markStarting(swarmId, 1);
    reg.setAgentId(swarmId, 1, "agent-1");
    expect(batch?.members.get(1)?.phase).toBe("starting");
    expect(batch?.members.get(1)?.agentId).toBe("agent-1");

    // mark ready (running)
    reg.markReady(swarmId, 1, 1100);
    expect(batch?.members.get(1)?.phase).toBe("running");
    expect(batch?.members.get(1)?.startedAt).toBe(1100);

    // mark suspended (retrying)
    reg.markSuspended(swarmId, 2, 1, 4000, "Rate limited");
    expect(batch?.members.get(2)?.phase).toBe("retrying");
    expect(batch?.members.get(2)?.retryCount).toBe(1);
    expect(batch?.members.get(2)?.retryReadyAt).toBe(4000);
    expect(batch?.members.get(2)?.detail).toBe("Rate limited");

    const roster2 = reg.toRosterFrame(batch!, 1200);
    expect(roster2.activeCount).toBe(2); // running + retrying

    // mark completed, failed, aborted
    reg.markSettled(swarmId, 1, "completed", undefined, 2000);
    reg.markSettled(swarmId, 2, "failed", "Max retries exceeded", 2100);
    reg.markSettled(swarmId, 3, "aborted", "Cancelled by user", 2200);

    const roster3 = reg.toRosterFrame(batch!, 2300);
    expect(roster3.activeCount).toBe(0);
    expect(roster3.completedCount).toBe(1);
    expect(roster3.failedCount).toBe(1);
    expect(roster3.abortedCount).toBe(1);

    // end batch
    reg.endBatch(swarmId, 2500);
    expect(batch?.endedAt).toBe(2500);
    expect(batch?.status).toBe("failed"); // has failed member
  });

  it("calculates batch completed status when all succeed", () => {
    const reg = new SwarmRegistry();
    const specs = [
      { index: 1, item: "task 1" },
      { index: 2, item: "task 2" },
    ];
    const swarmId = reg.beginBatch("sess-1", "All succeed", specs, 1000);
    reg.markSettled(swarmId, 1, "completed");
    reg.markSettled(swarmId, 2, "completed");
    reg.endBatch(swarmId, 1100);

    const batch = reg.getBatch(swarmId);
    expect(batch?.status).toBe("completed");
  });

  it("calculates batch aborted status when aborted and no failure", () => {
    const reg = new SwarmRegistry();
    const specs = [
      { index: 1, item: "task 1" },
      { index: 2, item: "task 2" },
    ];
    const swarmId = reg.beginBatch("sess-1", "Aborted batch", specs, 1000);
    reg.markSettled(swarmId, 1, "completed");
    reg.markSettled(swarmId, 2, "aborted");
    reg.endBatch(swarmId, 1100);

    const batch = reg.getBatch(swarmId);
    expect(batch?.status).toBe("aborted");
  });

  it("respects maxRetainedBatches per session", () => {
    const reg = new SwarmRegistry({ maxRetainedBatches: 2 });
    const id1 = reg.beginBatch("sess-a", "Batch 1", [{ index: 1, item: "a" }]);
    const id2 = reg.beginBatch("sess-a", "Batch 2", [{ index: 1, item: "b" }]);
    const id3 = reg.beginBatch("sess-a", "Batch 3", [{ index: 1, item: "c" }]);

    expect(reg.getBatch(id1)).toBeUndefined();
    expect(reg.getBatch(id2)).toBeDefined();
    expect(reg.getBatch(id3)).toBeDefined();
    expect(reg.getLatestBatch("sess-a")?.swarmId).toBe(id3);
  });
});

describe("SwarmRegistry framesFor stream", () => {
  it("streams opened, roster, and closed frames with coalescing", async () => {
    const reg = new SwarmRegistry({ flushMs: 20 });
    const ac = new AbortController();

    const framesPromise = (async () => {
      const received: any[] = [];
      try {
        for await (const frame of reg.framesFor("sess-stream", ac.signal, 10)) {
          received.push(frame);
          if (frame.type === "closed") break;
        }
      } catch (err) {
        if (!ac.signal.aborted) throw err;
      }
      return received;
    })();

    // Start batch after opening stream
    await new Promise((r) => setTimeout(r, 10));
    const swarmId = reg.beginBatch("sess-stream", "Stream test", [
      { index: 1, item: "A" },
      { index: 2, item: "B" },
    ]);

    // Do updates
    reg.markStarting(swarmId, 1);
    reg.markReady(swarmId, 1);
    reg.markSettled(swarmId, 1, "completed");
    reg.markSettled(swarmId, 2, "completed");
    reg.endBatch(swarmId);

    const frames = await framesPromise;
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames[0].type).toBe("opened");
    expect(frames[1].type).toBe("roster");
    expect(frames[frames.length - 1].type).toBe("closed");

    ac.abort();
  });

  /**
   * 协议缺口回归：连接一个**已经结束**的批次时，帧序列必须包含 closed。
   *
   * 缺陷成因：生成器进入时把 lastEndedAt 初始化成 currentBatch?.endedAt，
   * 于是循环里的「latest.endedAt !== undefined && lastEndedAt === undefined」
   * 对「连接时批次已结束」恒为假 → 永远不发 closed。
   * 任何以 frame.type === "closed" 作为结束信号的客户端会一直等。
   *
   * 顺序约定：opened → roster → closed（roster 先给全量快照，closed 收尾），
   * 与循环内既有顺序保持一致。
   */
  it("连接时批次已结束：帧序列必须含 closed（opened → roster → closed）", async () => {
    const reg = new SwarmRegistry({ flushMs: 10 });
    const ac = new AbortController();

    // 先把批次跑完，再建立连接
    const swarmId = reg.beginBatch("sess-done", "已结束批次", [
      { index: 1, item: "A" },
      { index: 2, item: "B" },
    ], 1000);
    reg.markSettled(swarmId, 1, "completed", undefined, 1100);
    reg.markSettled(swarmId, 2, "completed", undefined, 1200);
    reg.endBatch(swarmId, 1300);
    expect(reg.getBatch(swarmId)?.endedAt).toBe(1300);

    const received: any[] = [];
    for await (const frame of reg.framesFor("sess-done", ac.signal, 5)) {
      received.push(frame);
      if (frame.type === "closed") break;
    }
    ac.abort();

    expect(received.length).toBe(3);
    expect(received.map((f) => f.type)).toEqual(["opened", "roster", "closed"]);
    expect(received[0].swarmId).toBe(swarmId);
    expect(received[1].swarmId).toBe(swarmId);
    expect(received[2].swarmId).toBe(swarmId);
    expect(received[2].at).toBe(1300);
  });

  /**
   * 连接时**仍在进行**、稍后结束：既有行为不得回退，且 closed 只发一次。
   */
  it("连接后进行中再结束：closed 仍会发且不重复发", async () => {
    const reg = new SwarmRegistry({ flushMs: 10 });
    const ac = new AbortController();

    const swarmId = reg.beginBatch("sess-live", "进行中批次", [{ index: 1, item: "A" }], 1000);
    reg.markReady(swarmId, 1, 1050);

    const received: any[] = [];
    const stream = (async () => {
      try {
        for await (const frame of reg.framesFor("sess-live", ac.signal, 5)) {
          received.push(frame);
          if (frame.type === "closed") break;
        }
      } catch (err) {
        if (!ac.signal.aborted) throw err;
      }
    })();

    // 让循环跑起来（连接时批次尚未结束）
    await new Promise((r) => setTimeout(r, 20));
    reg.markSettled(swarmId, 1, "completed", undefined, 1200);
    reg.endBatch(swarmId, 1300);
    // 结束后再补一次更新，closed 不得被二次发出
    reg.markSettled(swarmId, 1, "completed", undefined, 1400);

    await stream;
    ac.abort();

    const types = received.map((f) => f.type);
    expect(types[0]).toBe("opened");
    expect(types.filter((t) => t === "closed")).toHaveLength(1);
    const lastClosed = received[received.length - 1];
    expect(lastClosed.type).toBe("closed");
    expect(lastClosed.at).toBe(1300);
  });

  /**
   * 切换到新批次：新批次的 opened/roster 必须重发；若新批次同样是已结束的，
   * 也要立刻补 closed（与「连接时已结束」同一条语义）。
   */
  it("新批次切换：重发 opened/roster，已结束的新批次补 closed", async () => {
    const reg = new SwarmRegistry({ flushMs: 10 });
    const ac = new AbortController();

    const first = reg.beginBatch("sess-switch", "批次一", [{ index: 1, item: "A" }], 1000);
    reg.markSettled(first, 1, "completed", undefined, 1050);
    reg.endBatch(first, 1100);

    const received: any[] = [];
    const stream = (async () => {
      try {
        for await (const frame of reg.framesFor("sess-switch", ac.signal, 5)) {
          received.push(frame);
          // 连接后新开一个已结束的批次，等它的 closed 到达
          if (frame.type === "roster" && frame.swarmId === first) {
            const second = reg.beginBatch("sess-switch", "批次二", [{ index: 1, item: "B" }], 2000);
            reg.markSettled(second, 1, "completed", undefined, 2050);
            reg.endBatch(second, 2100);
          }
          if (frame.type === "closed" && frame.swarmId !== first) break;
        }
      } catch (err) {
        if (!ac.signal.aborted) throw err;
      }
    })();

    await stream;
    ac.abort();

    // 批次一：opened → roster → closed（连接时已结束）
    const firstFrames = received.filter((f) => f.swarmId === first).map((f) => f.type);
    expect(firstFrames.slice(0, 3)).toEqual(["opened", "roster", "closed"]);

    // 批次二：新 opened/roster + closed，且 closed 末帧 at=2100
    const secondFrames = received.filter((f) => f.swarmId !== first);
    const secondTypes = secondFrames.map((f) => f.type);
    expect(secondTypes[0]).toBe("opened");
    expect(secondTypes).toContain("roster");
    const secondClosed = secondFrames.filter((f) => f.type === "closed");
    expect(secondClosed).toHaveLength(1);
    expect(secondClosed[0].at).toBe(2100);
  });
});

// ───────────────────────── 中断：registry 与调度器结论必须一致 ─────────────────────────

/**
 * 中断全链回归（WP-B）：
 * 一批 8 个成员、首波只启动 1 个就中断时，调度器必须为**从未启动**的排队成员
 * 也发出放弃通知；否则它们在 registry 里永久停在 pending，批次被推导成 failed，
 * 与 XML 里"全员 aborted"的结论互相矛盾。
 *
 * 这里不 mock 任何内部方法，而是照 src/index.ts:250-310 / 437-440 的真实接线
 * 把 SwarmScheduler + SwarmRegistry 接起来，断言**可观测的最终状态**：
 * 成员相位、批次状态、roster 计数、XML 文本。
 */
describe("中断后 registry 与调度器结论一致", () => {
  it("8 个成员只启动 1 个就中断：无成员停在非终态、批次 aborted、XML 同为 aborted", async () => {
    const registry = new SwarmRegistry();
    const specs: SwarmTaskSpec[] = Array.from({ length: 8 }, (_, i) => ({
      kind: "spawn" as const,
      index: i + 1,
      item: `item-${String(i + 1)}`,
      prompt: `prompt-${String(i + 1)}`,
    }));
    const swarmId = registry.beginBatch("sess-abort", "中断场景", specs);
    const controller = new AbortController();
    const started: number[] = [];

    const deps: SwarmSchedulerDeps = {
      now: () => Date.now(),
      setTimeout: (handler, ms) => setTimeout(handler, ms) as unknown,
      clearTimeout: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
      signal: controller.signal,
      isRateLimitError: () => false,
      classify: () => "in-flight-limited",
      onAbandoned: (event) => {
        registry.markSettled(
          swarmId,
          event.spec.index,
          event.outcome === "cancelled" ? "aborted" : "failed",
          event.error,
        );
      },
      executor: {
        run: (spec, attempt): Promise<SwarmAttemptResult> => {
          // 与 src/index.ts 的 runOneTask 同序：markStarting → setAgentId → markReady
          registry.markStarting(swarmId, spec.index);
          return new Promise<SwarmAttemptResult>((_resolve, reject) => {
            const agentId = `agent-${String(spec.index)}`;
            attempt.setAgentId(agentId);
            registry.setAgentId(swarmId, spec.index, agentId);
            attempt.markReady();
            registry.markReady(swarmId, spec.index);
            started.push(spec.index);
            attempt.signal.addEventListener(
              "abort",
              () => {
                // 真实 provider 是在 signal 触发后的**下一个事件循环**才回
                // stopReason="aborted"（index.ts:297-300 才 markSettled）。
                // 这里保留这段异步延迟，否则成员 1 会在 endBatch 之前就落终态，
                // 掩盖"批次被判 failed"的原始时序缺陷。
                setTimeout(() => {
                  registry.markSettled(swarmId, spec.index, "aborted", "interrupted");
                  reject(new Error("interrupted"));
                }, 0);
              },
              { once: true },
            );
          });
        },
      },
    };

    const promise = runSwarm(specs, deps, { initialLaunchLimit: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([1]); // 首波只放 1 个，其余 7 个仍在队列里

    controller.abort();

    let results: readonly SwarmTaskResult[] = [];
    try {
      results = await promise;
    } finally {
      // 与 src/index.ts:468-470 的 finally 同序
      registry.endBatch(swarmId);
    }

    const batch = registry.getBatch(swarmId);
    expect(batch).toBeDefined();
    // 批次状态必须在 endBatch 当场就是 aborted：此刻只有"放弃通知"能证明
    // 未启动成员的终态，XML 侧的 aborted 结论与它同源。
    expect(batch?.status).toBe("aborted");
    // 未启动的成员不得伪造 agentId
    const neverStarted = [...(batch?.members.values() ?? [])].filter((m) => m.index !== 1);
    expect(neverStarted).toHaveLength(7);
    expect(neverStarted.every((m) => m.agentId === undefined)).toBe(true);

    // 等"在跑成员"的回执落地（真实系统里它晚于 endBatch）
    await new Promise((resolve) => setTimeout(resolve, 10));

    const phases = [...(batch?.members.values() ?? [])].map((m) => m.phase);
    expect(phases.filter((p) => p === "pending" || p === "starting" || p === "running" || p === "retrying")).toEqual([]);
    expect(phases.every((p) => p === "aborted")).toBe(true);

    const roster = registry.toRosterFrame(batch!, Date.now());
    expect(roster.abortedCount).toBe(8);
    expect(roster.activeCount).toBe(0);

    // XML 侧不回归
    expect(results.map((r) => r.outcome)).toEqual(Array.from({ length: 8 }, () => "aborted"));
    const xml = renderSwarmResult(results, { omitNotStarted: false });
    expect(xml).toContain("<summary>aborted: 8</summary>");
    expect(xml).not.toContain('outcome="failed"');
    expect(xml.match(/outcome="aborted"/g)).toHaveLength(8);
  });
});

/**
 * 终态粘性回归（WP-B 之后由父代理补的守卫）：
 * 中断时调度器会先把"尚未 ready"的成员落 aborted；而此刻可能仍有在飞的
 * ctx.subagents.start，它之后才 reject，宿主 catch 会再调一次 markSettled("failed")。
 * 若允许覆写，这次"后到者"会把 aborted 改成 failed，批次又被 endBatch 推导成 failed，
 * 与 XML 侧"全员 aborted"的结论重新矛盾。守卫语义：**先到的终态才是真实结局**。
 */
describe("markSettled 的终态粘性", () => {
  it("迟到的 start 失败不得把已落定的 aborted 改成 failed", () => {
    const registry = new SwarmRegistry();
    const swarmId = registry.beginBatch("sess-sticky", "中断竞态", [
      { index: 1, item: "a" },
      { index: 2, item: "b" },
    ]);

    // ① 中断路径：未 ready 的成员先落 aborted
    registry.markSettled(swarmId, 1, "aborted", "The swarm was interrupted before this member finished.");
    registry.markSettled(swarmId, 2, "aborted", "The swarm was interrupted before this member finished.");
    // ② 在飞的 start 随后 reject → 宿主 catch 再落一次 failed
    registry.markSettled(swarmId, 1, "failed", "Subagent could not be started: the run was aborted");

    const member = registry.getBatch(swarmId)?.members.get(1);
    expect(member?.phase).toBe("aborted");
    expect(member?.detail).toBe("The swarm was interrupted before this member finished.");

    registry.endBatch(swarmId);
    expect(registry.getBatch(swarmId)?.status).toBe("aborted");
  });

  it("反向时序一致：先落 failed 的成员不被后到的 aborted 改写", () => {
    const registry = new SwarmRegistry();
    const swarmId = registry.beginBatch("sess-sticky-2", "反序", [
      { index: 1, item: "a" },
      { index: 2, item: "b" },
    ]);

    registry.markSettled(swarmId, 1, "failed", "Subagent could not be started: boom");
    registry.markSettled(swarmId, 2, "completed");
    registry.markSettled(swarmId, 1, "aborted", "interrupted");

    expect(registry.getBatch(swarmId)?.members.get(1)?.phase).toBe("failed");
    registry.endBatch(swarmId);
    expect(registry.getBatch(swarmId)?.status).toBe("failed");
  });
});
