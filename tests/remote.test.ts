
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
    expect(desc?.parameters[0]?.codec?.typeSymbol).toBe("dsh-agent-swarm/types#SwarmRosterRequest");
    expect(typeof desc?.parameters[0]?.codec?.create).toBe("function");
    expect(desc?.result?.mode).toBe("strict");
    expect(typeof desc?.result?.create).toBe("function");
  });

  /**
   * 回归：result 的 typeSymbol 必须与 framesFor 的实际产出（SwarmFrame 联合体）对齐。
   *
   * 缺陷成因：旧声明写的是 SwarmRosterFrame，而流里跑的每一项是
   * opened / roster / closed 的联合体，只有 roster 分支带 members 与计数。
   * 今天 codec 由 passSchema 透传所以不崩，但一旦宿主启用按 typeSymbol 生成/校验的
   * 强类型 codec，opened / closed 就会因"不是 roster"而被判失败。
   */
  it("result typeSymbol 指向帧联合体 SwarmFrame，而非 roster 单一帧", () => {
    const desc = TYPERT_REMOTE.descriptors[0];
    const result = desc?.result as { typeSymbol?: string } | undefined;

    expect(result?.typeSymbol).toBe("dsh-agent-swarm/types#SwarmFrame");
    // 旧的漂移声明不得复活
    expect(result?.typeSymbol).not.toBe("dsh-agent-swarm/types#SwarmRosterFrame");

    // 声明名必须真的存在于运行时导出的帧类型上（防止改名后声明悬空）
    const declared = String(result?.typeSymbol).split("#")[1] as keyof typeof import("../src/swarm-registry.js");
    expect(declared).toBe("SwarmFrame");
  });

  /**
   * 协议面：连接一个**已结束**的批次时，roster 方法的流里必须出现 closed 帧。
   *
   * 任何以 frame.type === "closed" 作为结束信号的客户端都依赖这一条；
   * 服务端方法 framesFor 的回归见 tests/swarm-registry.test.ts。
   */
  it("roster stream：连接已结束批次时发出 closed 帧", async () => {
    const ctx = new Context();
    const registry = new SwarmRegistry();
    const remote = new SwarmRemote(ctx, registry);

    const swarmId = registry.beginBatch("sess-closed", "已结束", [{ index: 1, item: "A" }]);
    registry.markSettled(swarmId, 1, "completed");
    registry.endBatch(swarmId);

    const ac = new AbortController();
    const frames: any[] = [];
    for await (const frame of remote.roster({ sessionId: "sess-closed" }, ac.signal)) {
      frames.push(frame);
      if (frame.type === "closed") break;
    }
    ac.abort();

    expect(frames.map((f) => f.type)).toEqual(["opened", "roster", "closed"]);
    expect(frames.every((f) => f.swarmId === swarmId)).toBe(true);
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
