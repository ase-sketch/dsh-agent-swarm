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
    // 终态**粘性**：落定之后不再改变（与 markSuspended 的终态守卫对称）。
    //
    // 为什么必须如此：批次中断时调度器的 #abandonSuspended 会先把"尚未 ready"的成员
    // 通知成 aborted；而此刻可能仍有在飞的 ctx.subagents.start，它之后才 reject，
    // 宿主 catch 里会再调一次 markSettled("failed")。若允许覆写，这次"后到者"会把
    // 已落定的 aborted 改成 failed，批次又被 endBatch 推导成 failed，与 XML 侧
    // "全员 aborted"的结论重新矛盾——即 2026-10-01 审查 P1-2 的残余时序。
    // 反序同理：先到的终态才是真实发生过的那个结局。
    if (member.phase === "completed" || member.phase === "failed" || member.phase === "aborted") return;
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
    //
    // 前提（中断收敛，WP-B 修复后）：调度器会把批次中断通知给**每一个**还没走到终态的
    // 成员——包括从未启动的排队成员（SwarmAbandonedEvent 的 agentId 可选，缺省即未启动）。
    // 因此正常结束时此处不应再看到 pending/starting/running/retrying：被中断的成员在
    // onAbandoned 里落 aborted，在跑的成员由宿主侧 run.result 回执落终态。
    //
    // 但仍保留 "非全 completed 且无 aborted → failed" 这条兜底，且**不**把残留相位强行
    // 归位成 aborted。为什么：残留相位在两种真实情况下仍可能出现——
    //   ① 批次根本没进调度器（runSwarm 在构造时因 config 非法直接抛出，宿主 finally 仍会
    //      调 endBatch），此时全员仍是 pending；
    //   ② 宿主接线漏挂了 onAbandoned 回调（或被中断时进程刚好结束），终态通知从未送达。
    // 这两种都是"批次没跑成"，推导成 failed 才如实；把它们改写成 aborted 等于把
    // "宿主没收到通知"伪装成"用户主动取消"，正是本次修复要消灭的那类静默失真。
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
