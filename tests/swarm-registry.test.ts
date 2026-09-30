
import { describe, it, expect } from "vitest";
import { SwarmRegistry } from "../src/swarm-registry.js";

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
});
