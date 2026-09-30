/**
 * dsh-agent-swarm — Swarm 状态注册表与合帧事件流
 *
 * 职责：
 * 1. 维护 sessionId -> swarmId -> SwarmBatch 的内存状态
 * 2. 管理成员生命周期七态（pending / starting / running / retrying / completed / failed / aborted）
 * 3. 对下游 Remote stream 提供 100ms 合帧的全量 Roster 生成器（opened / roster / closed 三帧）
 * 4. 纯逻辑实现，零 DSH 运行时依赖，完全可独立单测
 */

export type SwarmPhase =
  | "pending"
  | "starting"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "aborted";

export interface SwarmMemberView {
  index: number;
  item: string;
  agentId?: string;
  phase: SwarmPhase;
  retryCount: number;
  retryReadyAt?: number;
  startedAt?: number;
  settledAt?: number;
  detail?: string;
}

export interface SwarmBatch {
  swarmId: string;
  sessionId: string;
  description: string;
  total: number;
  status: "running" | "completed" | "failed" | "aborted";
  startedAt: number;
  endedAt?: number;
  members: Map<number, SwarmMemberView>;
}

export interface SwarmOpenedFrame {
  type: "opened";
  swarmId: string;
  sessionId: string;
  description: string;
  total: number;
  at: number;
}

export interface SwarmRosterFrame {
  type: "roster";
  swarmId: string;
  sessionId: string;
  description: string;
  total: number;
  activeCount: number;
  completedCount: number;
  failedCount: number;
  abortedCount: number;
  members: SwarmMemberView[];
  at: number;
}

export interface SwarmClosedFrame {
  type: "closed";
  swarmId: string;
  sessionId: string;
  at: number;
}

export type SwarmFrame = SwarmOpenedFrame | SwarmRosterFrame | SwarmClosedFrame;

/** 唤醒标志等待器：wait 之间的 wake 绝不丢失（照抄 DSH 官方实现）。 */
export class OutputWaiter {
  private dirty = false;
  private resolver?: () => void;

  wake(): void {
    this.dirty = true;
    this.resolver?.();
  }

  wait(signal: AbortSignal): Promise<void> {
    if (this.dirty || signal.aborted) {
      this.dirty = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = () => {
        signal.removeEventListener("abort", finish);
        if (this.resolver === finish) this.resolver = undefined;
        this.dirty = false;
        resolve();
      };
      this.resolver = finish;
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}

export function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", finish);
      resolve();
    }, ms);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
  });
}

export interface SwarmRegistryOptions {
  /** 合帧窗口，默认 100ms */
  flushMs?: number;
  /** 每会话保留的最大批次数，默认 10 */
  maxRetainedBatches?: number;
}

export class SwarmRegistry {
  private batches = new Map<string, SwarmBatch>();
  private sessionBatches = new Map<string, string[]>();
  private allBatchIds: string[] = [];
  private listeners = new Set<() => void>();
  private flushMs: number;
  private maxRetainedBatches: number;

  constructor(options: SwarmRegistryOptions = {}) {
    this.flushMs = options.flushMs ?? 100;
    this.maxRetainedBatches = options.maxRetainedBatches ?? 10;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 忽略监听者抛出的异常
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  beginBatch(
    sessionId: string,
    description: string,
    specs: readonly { index: number; item: string }[],
    now = Date.now(),
  ): string {
    const swarmId = `swarm-${String(now)}-${Math.random().toString(36).slice(2, 8)}`;
    const members = new Map<number, SwarmMemberView>();
    for (const spec of specs) {
      members.set(spec.index, {
        index: spec.index,
        item: spec.item,
        phase: "pending",
        retryCount: 0,
      });
    }

    const batch: SwarmBatch = {
      swarmId,
      sessionId,
      description,
      total: specs.length,
      status: "running",
      startedAt: now,
      members,
    };

    this.batches.set(swarmId, batch);
    this.allBatchIds.push(swarmId);

    const sBatches = this.sessionBatches.get(sessionId) ?? [];
    sBatches.push(swarmId);
    if (sBatches.length > this.maxRetainedBatches) {
      const removedId = sBatches.shift();
      if (removedId !== undefined && removedId !== swarmId) {
        this.batches.delete(removedId);
        const allIdx = this.allBatchIds.indexOf(removedId);
        if (allIdx >= 0) this.allBatchIds.splice(allIdx, 1);
      }
    }
    this.sessionBatches.set(sessionId, sBatches);

    this.notify();
    return swarmId;
  }

  markStarting(swarmId: string, index: number): void {
    const batch = this.batches.get(swarmId);
    if (!batch) return;
    const member = batch.members.get(index);
    if (!member) return;
    if (member.phase === "completed" || member.phase === "failed" || member.phase === "aborted") return;
    member.phase = "starting";
    this.notify();
  }

  setAgentId(swarmId: string, index: number, agentId: string): void {
    const batch = this.batches.get(swarmId);
    if (!batch) return;
    const member = batch.members.get(index);
    if (!member) return;
    member.agentId = agentId;
    this.notify();
  }

  markReady(swarmId: string, index: number, now = Date.now()): void {
    const batch = this.batches.get(swarmId);
    if (!batch) return;
    const member = batch.members.get(index);
    if (!member) return;
    if (member.phase === "completed" || member.phase === "failed" || member.phase === "aborted") return;
    member.phase = "running";
    if (member.startedAt === undefined) {
      member.startedAt = now;
    }
    this.notify();
  }

  markSuspended(
    swarmId: string,
    index: number,
    retryCount: number,
    retryReadyAt: number,
    detail?: string,
  ): void {
    const batch = this.batches.get(swarmId);
    if (!batch) return;
    const member = batch.members.get(index);
    if (!member) return;
    if (member.phase === "completed" || member.phase === "failed" || member.phase === "aborted") return;
    member.phase = "retrying";
    member.retryCount = retryCount;
    member.retryReadyAt = retryReadyAt;
    if (detail !== undefined) {
      member.detail = detail;
    }
    this.notify();
  }

  markSettled(
    swarmId: string,
    index: number,
    outcome: "completed" | "failed" | "aborted",
    detail?: string,
    now = Date.now(),
  ): void {
    const batch = this.batches.get(swarmId);
    if (!batch) return;
    const member = batch.members.get(index);
    if (!member) return;
    member.phase = outcome;
    member.settledAt = now;
    if (detail !== undefined) {
      member.detail = detail;
    }
    this.notify();
  }

  endBatch(swarmId: string, now = Date.now()): void {
    const batch = this.batches.get(swarmId);
    if (!batch) return;
    batch.endedAt = now;

    // 根据成员状态推导批次最终状态
    let hasFailed = false;
    let hasAborted = false;
    let allCompleted = true;
    for (const m of batch.members.values()) {
      if (m.phase === "failed") hasFailed = true;
      if (m.phase === "aborted") hasAborted = true;
      if (m.phase !== "completed") allCompleted = false;
    }

    if (allCompleted) {
      batch.status = "completed";
    } else if (hasAborted && !hasFailed) {
      batch.status = "aborted";
    } else {
      batch.status = "failed";
    }

    this.notify();
  }

  getBatch(swarmId: string): SwarmBatch | undefined {
    return this.batches.get(swarmId);
  }

  getLatestBatch(sessionId?: string): SwarmBatch | undefined {
    if (sessionId) {
      const ids = this.sessionBatches.get(sessionId);
      if (ids && ids.length > 0) {
        const lastId = ids[ids.length - 1];
        if (lastId) return this.batches.get(lastId);
      }
      return undefined;
    }
    if (this.allBatchIds.length > 0) {
      const lastId = this.allBatchIds[this.allBatchIds.length - 1];
      if (lastId) return this.batches.get(lastId);
    }
    return undefined;
  }

  toRosterFrame(batch: SwarmBatch, now = Date.now()): SwarmRosterFrame {
    const membersArray = Array.from(batch.members.values()).sort((a, b) => a.index - b.index);
    let activeCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    let abortedCount = 0;

    for (const m of membersArray) {
      if (m.phase === "starting" || m.phase === "running" || m.phase === "retrying") {
        activeCount++;
      } else if (m.phase === "completed") {
        completedCount++;
      } else if (m.phase === "failed") {
        failedCount++;
      } else if (m.phase === "aborted") {
        abortedCount++;
      }
    }

    return {
      type: "roster",
      swarmId: batch.swarmId,
      sessionId: batch.sessionId,
      description: batch.description,
      total: batch.total,
      activeCount,
      completedCount,
      failedCount,
      abortedCount,
      members: membersArray,
      at: now,
    };
  }

  async *framesFor(
    sessionId: string | undefined,
    signal: AbortSignal,
    flushMs = this.flushMs,
  ): AsyncIterable<SwarmFrame> {
    signal.throwIfAborted();
    const waiter = new OutputWaiter();
    const unsubscribe = this.subscribe(() => {
      waiter.wake();
    });

    try {
      let currentBatch = this.getLatestBatch(sessionId);
      let lastSwarmId: string | undefined = currentBatch?.swarmId;
      let lastEndedAt: number | undefined = currentBatch?.endedAt;

      if (currentBatch) {
        yield {
          type: "opened",
          swarmId: currentBatch.swarmId,
          sessionId: currentBatch.sessionId,
          description: currentBatch.description,
          total: currentBatch.total,
          at: currentBatch.startedAt,
        };
        yield this.toRosterFrame(currentBatch);
      }

      while (true) {
        await waiter.wait(signal);
        if (flushMs > 0) {
          await sleepWithSignal(flushMs, signal);
        }
        if (signal.aborted) return;

        const latest = this.getLatestBatch(sessionId);
        if (!latest) continue;

        // 若出现了新的批次
        if (latest.swarmId !== lastSwarmId) {
          lastSwarmId = latest.swarmId;
          lastEndedAt = undefined;
          yield {
            type: "opened",
            swarmId: latest.swarmId,
            sessionId: latest.sessionId,
            description: latest.description,
            total: latest.total,
            at: latest.startedAt,
          };
          yield this.toRosterFrame(latest);
        } else {
          // 同一波更新，重发全量 roster
          yield this.toRosterFrame(latest);
        }

        // 若批次已结束且尚未发出 closed 帧
        if (latest.endedAt !== undefined && lastEndedAt === undefined) {
          lastEndedAt = latest.endedAt;
          yield {
            type: "closed",
            swarmId: latest.swarmId,
            sessionId: latest.sessionId,
            at: latest.endedAt,
          };
        }
      }
    } finally {
      unsubscribe();
    }
  }
}
