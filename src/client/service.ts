/**
 * dsh-agent-swarm — 客户端流观察服务
 *
 * 职责：按 sessionId 引用计数管理与 Host 的 Remote Stream 连接。
 *
 * 不变式（2026-10-01 审查 P2 修复）：
 * 1. 流异常终止必须可见——错误写进 model 的失败态（供面板渲染）并带上下文告警，
 *    绝不再 `catch {}` 静默吞掉。
 * 2. 流终止后必须可重建——失效条目从 activeStreams 摘除，下一次 watchSwarm 开新流，
 *    不会让面板永久停在被截断的旧帧上。
 * 3. 用户主动取消（引用计数归零）不算异常，不产生误报。
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

/** 单会话流条目：引用计数 + 幂等停止开关。 */
interface StreamEntry {
  /** 当前订阅者数量。 */
  count: number;
  /** 幂等停止：置位后消费循环退出、底层 carrier 只释放一次、不再上报异常。 */
  stop: () => void;
}

export class ClientSwarmService {
  private activeStreams = new Map<string, StreamEntry>();

  constructor(
    private remote: RemoteClientFace,
    private model: ClientSwarmModel,
  ) {}

  /**
   * 订阅指定会话的 roster 流。
   *
   * 箭头属性（而非原型方法）是刻意的：引用在实例生命周期内稳定，
   * 槽位注入属性因此可以只构造一次，避免组件 useEffect 依赖抖动导致订阅/退订来回摆。
   */
  watchSwarm = (sessionId: string): (() => void) => {
    if (!sessionId) return () => {};

    const existing = this.activeStreams.get(sessionId);
    if (existing) {
      existing.count += 1;
      return this.release(sessionId, existing);
    }

    const entry = this.openStream(sessionId);
    this.activeStreams.set(sessionId, entry);
    return this.release(sessionId, entry);
  };

  /**
   * 生成引用计数释放器。
   *
   * 释放器只作用于自己捕获的那一条流：流异常后被摘除、随后重建时，
   * 旧订阅者迟到的 unsub 不会误停新流。
   */
  private release(sessionId: string, entry: StreamEntry): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.count -= 1;
      if (entry.count > 0) return;
      if (this.activeStreams.get(sessionId) === entry) {
        this.activeStreams.delete(sessionId);
      }
      entry.stop();
    };
  }

  private openStream(sessionId: string): StreamEntry {
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
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      try {
        stream.dispose();
      } catch {
        // ignore
      }
    };
    const entry: StreamEntry = { count: 1, stop };

    void (async () => {
      try {
        for await (const item of stream) {
          if (stopped) break;
          const frame = item.value;
          if (frame && frame.type === "roster") {
            this.model.rosterReceived(frame);
            item.accept?.();
          }
        }
      } catch (error) {
        // 只有"非主动取消"才是异常：主动取消已在 stop() 里置位，不应误报
        if (!stopped) this.onStreamTerminated(sessionId, entry, error);
        return;
      }
      // 正常跑完迭代器同样意味着流已死：只要不是我们主动取消的，就必须顶到可见处
      if (!stopped) this.onStreamTerminated(sessionId, entry, undefined);
    })();

    return entry;
  }

  /**
   * 流终止收口：把失败顶到可见处，并摘除失效条目以允许重建。
   *
   * 先用 model 承载错误（面板据此渲染），再用 console.warn 兜底——面板未挂载时
   * model 状态无人渲染，日志是唯一出口。两者都不是"静默"。
   */
  private onStreamTerminated(sessionId: string, entry: StreamEntry, error: unknown): void {
    // 先摘表：只要条目还在，后续 watchSwarm 就会复用到这条已经死掉的流
    if (this.activeStreams.get(sessionId) === entry) {
      this.activeStreams.delete(sessionId);
    }

    const message =
      error === undefined
        ? "stream ended without an error"
        : error instanceof Error
          ? error.message
          : String(error);

    this.model.streamFailed(sessionId, message);
    // 只在确实有错误对象时把它作为附加参数（否则 Node 会把 undefined 也打出来，日志里多一个噪音 "undefined"）
    if (error === undefined) {
      console.warn(`[agent-swarm] roster stream for session ${sessionId} terminated: ${message}`);
    } else {
      console.warn(`[agent-swarm] roster stream for session ${sessionId} terminated: ${message}`, error);
    }

    entry.stop();
  }
}
