
import { describe, it, expect, vi } from "vitest";
import { hasLoneSurrogate } from "./helpers/surrogates.js";
import { runSwarm } from "../src/scheduler.js";
import { renderSwarmResult } from "../src/result-xml.js";
import {
  MEMBER_VIEW_DETAIL_MAX_CHARS,
  MEMBER_VIEW_ITEM_MAX_CHARS,
  SwarmRegistry,
  type SwarmFrame,
} from "../src/swarm-registry.js";
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

  it("respects maxRetainedBatches per session（淘汰最旧的已结束批次）", () => {
    const reg = new SwarmRegistry({ maxRetainedBatches: 2 });
    const id1 = reg.beginBatch("sess-a", "Batch 1", [{ index: 1, item: "a" }]);
    reg.endBatch(id1);
    const id2 = reg.beginBatch("sess-a", "Batch 2", [{ index: 1, item: "b" }]);
    reg.endBatch(id2);
    const id3 = reg.beginBatch("sess-a", "Batch 3", [{ index: 1, item: "c" }]);

    expect(reg.getBatch(id1)).toBeUndefined();
    expect(reg.getBatch(id2)).toBeDefined();
    expect(reg.getBatch(id3)).toBeDefined();
    expect(reg.getLatestBatch("sess-a")?.swarmId).toBe(id3);
  });

  it("运行中的批次永不被淘汰（软上限）：否则它之后的相位更新会静默落空、面板停在中途", () => {
    const reg = new SwarmRegistry({ maxRetainedBatches: 2 });
    const running = reg.beginBatch("sess-a", "still running", [{ index: 1, item: "a" }]);
    const ended = reg.beginBatch("sess-a", "ended", [{ index: 1, item: "b" }]);
    reg.endBatch(ended);
    const newest = reg.beginBatch("sess-a", "newest", [{ index: 1, item: "c" }]);
    // 超出上限时跳过运行中的 running，淘汰已结束的 ended
    expect(reg.getBatch(running)).toBeDefined();
    expect(reg.getBatch(ended)).toBeUndefined();
    expect(reg.getBatch(newest)).toBeDefined();
    // 全是运行中的批次时允许暂时超出上限
    const another = reg.beginBatch("sess-a", "another", [{ index: 1, item: "d" }]);
    expect([running, newest, another].every((id) => reg.getBatch(id) !== undefined)).toBe(true);
    // 运行中批次的更新照常生效
    reg.markSettled(running, 1, "completed");
    expect(reg.getBatch(running)?.members.get(1)?.phase).toBe("completed");
  });

  it("会话数上限：按最近活跃淘汰空闲会话，有运行中批次的会话不淘汰（此前会话表只增不减）", () => {
    const reg = new SwarmRegistry({ maxRetainedSessions: 2 });
    const busy = reg.beginBatch("sess-busy", "running", [{ index: 1, item: "a" }]);
    const idle = reg.beginBatch("sess-idle", "done", [{ index: 1, item: "b" }]);
    reg.endBatch(idle);
    reg.beginBatch("sess-new", "new", [{ index: 1, item: "c" }]);
    // 超出 2 个会话：最久未活跃的 sess-busy 有运行中批次 → 跳过；淘汰空闲的 sess-idle
    expect(reg.getBatch(busy)).toBeDefined();
    expect(reg.getBatch(idle)).toBeUndefined();
    expect(reg.getLatestBatch("sess-idle")).toBeUndefined();
    expect(reg.getLatestBatch("sess-new")).toBeDefined();
  });

  it("成员视图只保留显示摘要：长 item / detail 截断，原长另给（XML 不受影响，它不读 registry）", () => {
    const reg = new SwarmRegistry();
    const longItem = "x".repeat(MEMBER_VIEW_ITEM_MAX_CHARS + 50);
    const swarmId = reg.beginBatch("sess-t", "trunc", [
      { index: 1, item: longItem },
      { index: 2, item: "short" },
    ]);
    const member = reg.getBatch(swarmId)?.members.get(1);
    expect(member?.item).toBe(`${"x".repeat(MEMBER_VIEW_ITEM_MAX_CHARS)}…`);
    expect(member?.itemChars).toBe(MEMBER_VIEW_ITEM_MAX_CHARS + 50);
    expect(reg.getBatch(swarmId)?.members.get(2)).not.toHaveProperty("itemChars");

    reg.markSettled(swarmId, 1, "failed", "e".repeat(MEMBER_VIEW_DETAIL_MAX_CHARS * 3));
    expect(reg.getBatch(swarmId)?.members.get(1)?.detail?.length).toBe(MEMBER_VIEW_DETAIL_MAX_CHARS + 1);
  });

  it("roster 帧里的成员是快照：之后的相位变化不会改写已经发出的帧", () => {
    const reg = new SwarmRegistry();
    const swarmId = reg.beginBatch("sess-snap", "snap", [{ index: 1, item: "a" }]);
    const frame = reg.toRosterFrame(reg.getBatch(swarmId)!);
    reg.markSettled(swarmId, 1, "completed");
    expect(frame.members[0]?.phase).toBe("pending");
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


describe("routeLabel（批次路由标签）", () => {
  it("beginBatch 给了 routeLabel：roster 帧携带；没给：帧上缺省", () => {
    const reg = new SwarmRegistry();
    const withLabel = reg.beginBatch(
      "sess-r",
      "Routed batch",
      [{ index: 1, item: "a" }],
      1000,
      "minimax/MiniMax-M2",
    );
    const batchWith = reg.getBatch(withLabel);
    expect(reg.toRosterFrame(batchWith!, 1001).routeLabel).toBe("minimax/MiniMax-M2");

    const without = reg.beginBatch("sess-r", "Plain batch", [{ index: 1, item: "b" }], 1002);
    const batchWithout = reg.getBatch(without);
    expect(reg.toRosterFrame(batchWithout!, 1003).routeLabel).toBeUndefined();
  });
});

// ───────────────────────── 推流：按会话唤醒 / 只发增量 / 并发批次可见 ─────────────────────────

/** 后台收集某会话的帧，直到 stop()；返回已收到的帧。 */
function collectFrames(reg: SwarmRegistry, sessionId: string, flushMs = 1) {
  const ac = new AbortController();
  const frames: SwarmFrame[] = [];
  const done = (async () => {
    try {
      for await (const frame of reg.framesFor(sessionId, ac.signal, flushMs)) frames.push(frame);
    } catch (err) {
      if (!ac.signal.aborted) throw err;
    }
  })();
  return {
    frames,
    async stop(): Promise<SwarmFrame[]> {
      ac.abort();
      await done;
      return frames;
    },
  };
}

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

describe("framesFor：资源边界与并发批次", () => {
  it("只有本会话的变化才唤醒本会话的流（此前任一会话变化都会唤醒全部订阅者）", async () => {
    const reg = new SwarmRegistry();
    const mine = reg.beginBatch("sess-A", "mine", [{ index: 1, item: "a" }]);
    const stream = collectFrames(reg, "sess-A");
    await tick();
    const initial = stream.frames.length;
    expect(initial).toBe(2); // opened + roster

    const other = reg.beginBatch("sess-B", "other", [
      { index: 1, item: "p" },
      { index: 2, item: "q" },
    ]);
    for (let i = 0; i < 10; i += 1) {
      reg.markStarting(other, 1 + (i % 2));
      await tick(2);
    }
    await tick();
    expect(stream.frames.length).toBe(initial);

    reg.markSettled(mine, 1, "completed");
    await tick();
    const frames = await stream.stop();
    expect(frames.length).toBe(initial + 1);
    expect(frames[frames.length - 1]).toMatchObject({ type: "roster", swarmId: mine, completedCount: 1 });
  });

  it("并发批次：同一会话里重叠运行的批次同时可见，roster 帧携带 visibleSwarmIds", async () => {
    const reg = new SwarmRegistry();
    const first = reg.beginBatch("sess-C", "first", [{ index: 1, item: "a" }]);
    const second = reg.beginBatch("sess-C", "second", [{ index: 1, item: "b" }]);
    expect(reg.visibleBatches("sess-C").map((b) => b.swarmId)).toEqual([first, second]);

    const stream = collectFrames(reg, "sess-C");
    await tick();
    // 两个批次都有 opened + roster；先开的不会因为后开的出现而从面板消失（此前只推最新一个）
    const openedIds = stream.frames.filter((f) => f.type === "opened").map((f) => f.swarmId);
    expect(openedIds).toEqual([first, second]);
    const roster = stream.frames.find((f) => f.type === "roster" && f.swarmId === first);
    expect(roster).toMatchObject({ visibleSwarmIds: [first, second] });

    // first 先结束：second 还在跑，first 仍可见（与 second 重叠）
    reg.markSettled(first, 1, "completed");
    reg.endBatch(first);
    await tick();
    expect(reg.visibleBatches("sess-C").map((b) => b.swarmId)).toEqual([first, second]);
    expect(stream.frames.filter((f) => f.type === "closed").map((f) => f.swarmId)).toEqual([first]);

    // 两者都结束后，新一次调用开新批次：旧的一组整体被取代
    reg.endBatch(second);
    const third = reg.beginBatch("sess-C", "third", [{ index: 1, item: "c" }]);
    await tick();
    const frames = await stream.stop();
    expect(reg.visibleBatches("sess-C").map((b) => b.swarmId)).toEqual([third]);
    const lastRoster = [...frames].reverse().find((f) => f.type === "roster");
    expect(lastRoster).toMatchObject({ swarmId: third, visibleSwarmIds: [third] });
    // 每个批次的 closed 恰好一次
    for (const id of [first, second]) {
      expect(frames.filter((f) => f.type === "closed" && f.swarmId === id)).toHaveLength(1);
    }
  });

  it("只重发版本变化了的批次：另一个并发批次的更新不会让本批次的 roster 重发", async () => {
    const reg = new SwarmRegistry();
    const quiet = reg.beginBatch("sess-D", "quiet", [{ index: 1, item: "a" }]);
    const busy = reg.beginBatch("sess-D", "busy", [{ index: 1, item: "b" }]);
    const stream = collectFrames(reg, "sess-D");
    await tick();
    for (let i = 0; i < 5; i += 1) {
      reg.setAgentId(busy, 1, `agent-${String(i)}`);
      await tick(3);
    }
    await tick();
    const frames = await stream.stop();
    const quietRosters = frames.filter((f) => f.type === "roster" && f.swarmId === quiet);
    const busyRosters = frames.filter((f) => f.type === "roster" && f.swarmId === busy);
    expect(quietRosters).toHaveLength(1); // 只有连接时那一帧
    expect(busyRosters.length).toBeGreaterThan(1);
  });
});

// ───────────────────────── 独立审查回归（第三轮）─────────────────────────

describe("独立审查回归：推流与批次状态", () => {
  it("消费方持有某一帧期间发生的变化不会丢失（版本在构造帧之前取快照）", async () => {
    const reg = new SwarmRegistry();
    const swarmId = reg.beginBatch("sess-H", "hold", [{ index: 1, item: "a" }]);
    const ac = new AbortController();
    const iterator = reg.framesFor("sess-H", ac.signal, 1)[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ type: "opened" });
    const firstRoster = (await iterator.next()).value as SwarmFrame;
    expect(firstRoster).toMatchObject({ type: "roster", completedCount: 0 });

    // 消费方还"拿着"第一帧（尚未要下一帧）时，批次跑完并收尾
    reg.markSettled(swarmId, 1, "completed");
    reg.endBatch(swarmId);

    // 修复前：恢复后才读版本 → 变化被记成已发送，只会再收到 closed，面板永远停在 pending
    const rest: SwarmFrame[] = [];
    while (true) {
      const next = await iterator.next();
      rest.push(next.value as SwarmFrame);
      if ((next.value as SwarmFrame).type === "closed") break;
    }
    ac.abort();
    expect(rest.map((f) => f.type)).toEqual(["roster", "closed"]);
    expect(rest[0]).toMatchObject({ completedCount: 1 });
  });

  it("其它会话的变化根本不会触发本会话的比对（守护按会话唤醒，而不只是帧数）", async () => {
    const reg = new SwarmRegistry();
    reg.beginBatch("sess-W", "watched", [{ index: 1, item: "a" }]);
    const spy = vi.spyOn(reg, "visibleBatches");
    const stream = collectFrames(reg, "sess-W");
    await tick();
    const diffsAfterConnect = spy.mock.calls.length;
    const other = reg.beginBatch("sess-X", "other", [{ index: 1, item: "b" }]);
    for (let i = 0; i < 6; i += 1) {
      reg.setAgentId(other, 1, `agent-${String(i)}`);
      await tick(3);
    }
    await tick();
    await stream.stop();
    expect(spy.mock.calls.length).toBe(diffsAfterConnect);
  });

  it("视图截断不劈开代理对：item / description 在 emoji 处截断不残留孤立代理（评审第 1 条）", () => {
    const reg = new SwarmRegistry();
    const text = `${"a".repeat(MEMBER_VIEW_ITEM_MAX_CHARS - 1)}🚀rest`;
    const swarmId = reg.beginBatch("sess-U", text, [{ index: 1, item: text }]);
    const batch = reg.getBatch(swarmId);
    expect(hasLoneSurrogate(batch?.description ?? "")).toBe(false);
    expect(hasLoneSurrogate(batch?.members.get(1)?.item ?? "")).toBe(false);
    expect(batch?.members.get(1)?.item).toBe(`${"a".repeat(MEMBER_VIEW_ITEM_MAX_CHARS - 1)}…`);
  });

  it("description 同样截成显示摘要（它随每个 opened / roster 帧下发）", () => {
    const reg = new SwarmRegistry();
    const swarmId = reg.beginBatch("sess-L", "d".repeat(MEMBER_VIEW_ITEM_MAX_CHARS * 5), [{ index: 1, item: "a" }]);
    expect(reg.getBatch(swarmId)?.description.length).toBe(MEMBER_VIEW_ITEM_MAX_CHARS + 1);
  });

  it("收尾之后才落定的成员会重算批次状态（中断时 run.result 异步收场晚于 endBatch）", () => {
    const reg = new SwarmRegistry();
    const swarmId = reg.beginBatch("sess-S", "late", [
      { index: 1, item: "a" },
      { index: 2, item: "b" },
    ]);
    reg.markReady(swarmId, 1);
    reg.markReady(swarmId, 2);
    reg.endBatch(swarmId); // 中断瞬间两个成员都还在 running（结局尚未回执）→ 只能推导为 failed
    expect(reg.getBatch(swarmId)?.status).toBe("failed");
    reg.markSettled(swarmId, 1, "aborted"); // 晚到的中断结局
    reg.markSettled(swarmId, 2, "aborted");
    expect(reg.getBatch(swarmId)?.status).toBe("aborted");
  });
});
