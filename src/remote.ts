/**
 * dsh-agent-swarm — Remote Stream 宿主服务与客户端元数据
 *
 * 职责：
 * 1. 提供 SwarmRemote (TypertRemoteService)，以 @Remote({ mode: "stream" }) 暴露 swarm/roster
 * 2. 导出客户端 $mount 使用的 TYPERT_REMOTE 描述符
 */

import type { Context } from "@deepseek-ai/cordis";
import { TypertRemoteService, Remote } from "@deepseek-ai/dsh-typert-protocol";
import type { SwarmFrame, SwarmRegistry } from "./swarm-registry.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    swarmRemote: SwarmRemote;
  }
}

export interface SwarmRosterRequest {
  sessionId?: string;
}

export class SwarmRemote extends TypertRemoteService {
  private registry: SwarmRegistry;

  constructor(ctx: Context, registry: SwarmRegistry) {
    super(ctx, "swarmRemote", { namespace: "swarm" });
    this.registry = registry;
  }

  getRegistry(): SwarmRegistry {
    return this.registry;
  }

  setRegistry(registry: SwarmRegistry): void {
    this.registry = registry;
  }

  @Remote({ mode: "stream" })
  async *roster(
    request: SwarmRosterRequest,
    signal: AbortSignal,
  ): AsyncIterable<SwarmFrame> {
    yield* this.registry.framesFor(request?.sessionId, signal);
  }
}

export { TYPERT_REMOTE } from "./remote-descriptor.js";
