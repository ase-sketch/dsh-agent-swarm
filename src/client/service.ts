/**
 * dsh-agent-swarm — 客户端流观察服务
 *
 * 职责：按 sessionId 引用计数管理与 Host 的 Remote Stream 连接。
 */

import type { ClientSwarmModel } from "./model.js";

export interface RemoteCarrierStreamItem<T> {
  generation: number;
  value: T;
  signal: AbortSignal;
  accept?: () => void;
}

export interface RemoteCarrierStream<T> {
  [Symbol.asyncIterator](): AsyncIterator<RemoteCarrierStreamItem<T>>;
  dispose(): Promise<void> | void;
}

export interface RemoteClientFace {
  $stream<T>(options: {
    name: string;
    open: (signal: AbortSignal) => AsyncIterable<T> | Promise<AsyncIterable<T>>;
    ended: (accepted: boolean) => Error;
  }): RemoteCarrierStream<T>;
  swarm?: {
    roster(request: { sessionId?: string }, signal: AbortSignal): AsyncIterable<any>;
  };
}

export class ClientSwarmService {
  private activeStreams = new Map<string, { count: number; dispose: () => void }>();

  constructor(
    private remote: RemoteClientFace,
    private model: ClientSwarmModel,
  ) {}

  watchSwarm(sessionId: string): () => void {
    if (!sessionId) return () => {};
    let entry = this.activeStreams.get(sessionId);
    if (!entry) {
      const stream = this.remote.$stream({
        name: "swarm roster " + sessionId,
        open: (signal: AbortSignal) => {
          if (!this.remote.swarm) {
            throw new Error("remote.swarm namespace is not mounted");
          }
          return this.remote.swarm.roster({ sessionId }, signal);
        },
        ended: (accepted) =>
          new Error(`swarm roster stream for ${sessionId} ended (accepted=${String(accepted)})`),
      });

      let stopped = false;
      (async () => {
        try {
          for await (const item of stream) {
            if (stopped) break;
            const frame = item.value;
            if (frame && frame.type === "roster") {
              this.model.rosterReceived(frame);
              item.accept?.();
            }
          }
        } catch {
          // 流正常结束或被取消
        }
      })();

      const dispose = () => {
        stopped = true;
        try {
          stream.dispose();
        } catch {
          // ignore
        }
      };

      entry = { count: 1, dispose };
      this.activeStreams.set(sessionId, entry);
    } else {
      entry.count++;
    }

    return () => {
      const current = this.activeStreams.get(sessionId);
      if (!current) return;
      current.count--;
      if (current.count <= 0) {
        current.dispose();
        this.activeStreams.delete(sessionId);
      }
    };
  }
}
