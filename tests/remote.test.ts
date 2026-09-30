
import { describe, it, expect } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { SwarmRegistry } from "../src/swarm-registry.js";
import { SwarmRemote, TYPERT_REMOTE } from "../src/remote.js";

describe("SwarmRemote service and TYPERT_REMOTE descriptors", () => {
  it("exposes swarm namespace and stream roster method", async () => {
    const ctx = new Context();
    const registry = new SwarmRegistry();
    const remote = new SwarmRemote(ctx, registry);

    expect(remote.typertRemote.namespace).toBe("swarm");
    expect(remote.typertRemote.serviceKey).toBe("swarmRemote");
    expect(remote.getRegistry()).toBe(registry);

    const methods = remoteMethods(remote);
    expect(methods).toHaveLength(1);
    expect(methods[0]?.method).toBe("roster");
    expect(methods[0]?.mode).toBe("stream");

    // Test streaming through roster method
    const swarmId = registry.beginBatch("sess-remote", "Remote test", [{ index: 1, item: "Item 1" }]);
    const ac = new AbortController();

    const frames: any[] = [];
    for await (const frame of remote.roster({ sessionId: "sess-remote" }, ac.signal)) {
      frames.push(frame);
      break;
    }
    ac.abort();

    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe("opened");
    expect(frames[0].swarmId).toBe(swarmId);
  });

  it("exports strictly conforming TYPERT_REMOTE descriptors", () => {
    expect(TYPERT_REMOTE.package).toBe("dsh-agent-swarm");
    expect(TYPERT_REMOTE.descriptors).toHaveLength(1);

    const desc = TYPERT_REMOTE.descriptors[0];
    expect(desc?.id).toBe("dsh-agent-swarm#swarm/roster");
    expect(desc?.service).toBe("swarmRemote");
    expect(desc?.namespace).toBe("swarm");
    expect(desc?.method).toBe("roster");
    expect(desc?.mode).toBe("stream");
    expect(desc?.parameters[0]?.codec?.mode).toBe("strict");
    expect(typeof desc?.parameters[0]?.codec?.create).toBe("function");
    expect(desc?.result?.mode).toBe("strict");
    expect(typeof desc?.result?.create).toBe("function");
  });

  it("validates and registers cleanly in real TypertRegistry (F1 regression)", () => {
    const ctx = new Context();
    const registry = new TypertRegistry(ctx);

    const dispose = registry.remotes.register(TYPERT_REMOTE);
    expect(registry.remotes.get("swarm/roster")?.id).toBe("dsh-agent-swarm#swarm/roster");

    dispose();
    expect(registry.remotes.get("swarm/roster")).toBeUndefined();
  });
});
