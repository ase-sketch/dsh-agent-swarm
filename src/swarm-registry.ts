/**
 * dsh-agent-swarm — Swarm 状态注册表与合帧事件流（纯逻辑，零 DSH 运行时依赖）
 *
 * 职责：
 * 1. 维护 sessionId -> swarmId -> SwarmBatch 的内存状态（面板的数据源；XML 才是成员状态的权威）
 * 2. 管理成员生命周期七态（pending / starting / running / retrying / completed / failed / aborted）
 * 3. 对下游 Remote stream 提供按会话唤醒、100ms 合帧的增量帧生成器（opened / roster / closed 三帧）
 *
 * 资源边界（2026-10-01 第三轮）：
 * - 只有**本会话**的变化才唤醒该会话的流（此前任何会话的变化都会唤醒全部订阅者）；
 * - 每次唤醒只重发**版本变化了**的批次（此前每次唤醒都重发全量）；
 * - 成员视图里的 item / detail 截断成显示摘要（此前每帧携带全部原文：128 个 10KB item 单帧 1.29MB）；
 * - 会话数与每会话批次数都有上限；淘汰只淘汰**已结束**的批次，运行中的批次永不淘汰。
 *
 * 可见性（并发批次）：同一会话里，一个批次保持可见，直到它**结束之后**又有新批次开始。
 * 于是同一条消息里并发发起的多个批次作为一组同时可见，下一次调用开始时整组换下。
 * roster 帧携带当前可见集合（visibleSwarmIds），客户端据此清理已不可见的批次。
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
  /** item 的显示摘要（超过 {@link MEMBER_VIEW_ITEM_MAX_CHARS} 时截断并补 `…`）。 */
  item: string;
  /** item 原文长度；仅在 item 被截断时出现。 */
  itemChars?: number;
  agentId?: string;
  phase: SwarmPhase;
  retryCount: number;
  retryReadyAt?: number;
  startedAt?: number;
  settledAt?: number;
  /** 状态说明的显示摘要（超过 {@link MEMBER_VIEW_DETAIL_MAX_CHARS} 时截断）。 */
  detail?: string;
}

export interface SwarmBatch {
  swarmId: string;
  sessionId: string;
  description: string;
  /** 批次生效路由的展示标签（如 "deepseek/deepseek-chat"）；读不到时缺省，UI 留空不猜。 */
  routeLabel?: string;
  total: number;
  status: "running" | "completed" | "failed" | "aborted";
  startedAt: number;
  endedAt?: number;
  members: Map<number, SwarmMemberView>;
  /** 每次可观测变化 +1；流据此只重发变化了的批次。 */
  version: number;
  /** 开批次时的全局序号（单调递增，与墙钟无关，判定先后不受同毫秒影响）。 */
  beginSeq: number;
  /** 收批次时的全局序号；未结束为 undefined。 */
  endSeq?: number;
}

export interface SwarmOpenedFrame {
  type: "opened";
  swarmId: string;
  sessionId: string;
  description: string;
  routeLabel?: string;
  total: number;
  at: number;
}

export interface SwarmRosterFrame {
  type: "roster";
  swarmId: string;
  sessionId: string;
  description: string;
  routeLabel?: string;
  total: number;
  activeCount: number;
  completedCount: number;
  failedCount: number;
  abortedCount: number;
  members: SwarmMemberView[];
  /**
   * 发出本帧时该会话的可见批次（按开批次先后，最后一个最新）。
   * 客户端据此清理已不可见的批次；缺省（旧帧/单独构造的帧）时客户端只按 swarmId 增量合并。
   */
  visibleSwarmIds?: string[];
  at: number;
}

export interface SwarmClosedFrame {
  type: "closed";
  swarmId: string;
  sessionId: string;
  at: number;
}

export type SwarmFrame = SwarmOpenedFrame | SwarmRosterFrame | SwarmClosedFrame;

/** 成员视图里 item 摘要的最大码元数。 */
export const MEMBER_VIEW_ITEM_MAX_CHARS = 200;
/** 成员视图里 detail 摘要的最大码元数。 */
export const MEMBER_VIEW_DETAIL_MAX_CHARS = 500;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ───────────────────────── 唤醒与合帧原语 ─────────────────────────
//
// 来源：OutputWaiter 与 sleepWithSignal 的结构对应 @deepseek-ai/dsh-api-job-controller@0.2.0-rc.2
// lib/index.js 的 OutputWaiter / sleep（MIT，Copyright (c) 2026 DeepSeek），即 DSH 官方
// "有变化就 wake、合窗后重发"的推流骨架。登记见 THIRD-PARTY-NOTICES.md。

/** 唤醒标志等待器：两次 wait 之间的 wake 绝不丢失。 */
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

/** 合帧窗口：睡 ms 毫秒，或在 signal abort 时立即返回。 */
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

// ───────────────────────── 注册表 ─────────────────────────

export interface SwarmRegistryOptions {
  /** 合帧窗口，默认 100ms */
  flushMs?: number;
  /** 每会话保留的最大批次数，默认 10（软上限：只淘汰已结束的批次） */
  maxRetainedBatches?: number;
  /** 保留的最大会话数，默认 64（按最近活跃淘汰；有运行中批次的会话不淘汰） */
  maxRetainedSessions?: number;
}

/** 变化监听器：参数是发生变化的会话。 */
export type SwarmRegistryListener = (sessionId: string) => void;

const TERMINAL_PHASES: ReadonlySet<SwarmPhase> = new Set(["completed", "failed", "aborted"]);

function isTerminal(phase: SwarmPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/** 单条流对某个批次的发送进度。 */
interface AnnouncedBatch {
  /** 最近一次发出 roster 时的批次版本。 */
  version: number;
  /** 是否已发出 closed。 */
  closed: boolean;
}

/** 单条流的发送状态（每次 framesFor 调用各持一份）。 */
interface StreamCursor {
  announced: Map<string, AnnouncedBatch>;
  /** 上次发帧时的可见集合（序列化），用于发现"有批次退出可见集合"。 */
  visibleKey: string;
}

/** 单个会话同时可见的批次数上限（只保留最新的这么多个）。 */
export const MAX_VISIBLE_BATCHES = 8;

export class SwarmRegistry {
  private readonly batches = new Map<string, SwarmBatch>();
  /** 会话 → 批次 id（开批次先后）。Map 的迭代顺序即会话最近活跃先后（开批次时移到末尾）。 */
  private readonly sessionBatches = new Map<string, string[]>();
  /** 全部批次 id（开批次先后），供不指定会话的读取使用。 */
  private readonly allBatchIds: string[] = [];
  private readonly listeners = new Set<SwarmRegistryListener>();
  private readonly flushMs: number;
  private readonly maxRetainedBatches: number;
  private readonly maxRetainedSessions: number;
  /** 全局单调序号：开批次与收批次各取一次，用于判定"先后"而不依赖墙钟。 */
  private seq = 0;

  constructor(options: SwarmRegistryOptions = {}) {
    this.flushMs = options.flushMs ?? 100;
    this.maxRetainedBatches = options.maxRetainedBatches ?? 10;
    this.maxRetainedSessions = options.maxRetainedSessions ?? 64;
  }

  private notify(sessionId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId);
      } catch {
        // 监听者自身的异常不得影响状态推进与其它监听者（流消费方各自处理自己的失败）。
      }
    }
  }

  /** 订阅变化；监听器收到发生变化的会话 id。返回退订函数。 */
  subscribe(listener: SwarmRegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 一次可观测变化：批次版本 +1 并通知该会话。 */
  private touch(batch: SwarmBatch): void {
    batch.version += 1;
    this.notify(batch.sessionId);
  }

  /** 取成员；批次或成员不存在时返回 undefined（迟到的回调对已淘汰批次一律静默）。 */
  private memberOf(swarmId: string, index: number): { batch: SwarmBatch; member: SwarmMemberView } | undefined {
    const batch = this.batches.get(swarmId);
    const member = batch?.members.get(index);
    return batch !== undefined && member !== undefined ? { batch, member } : undefined;
  }

  beginBatch(
    sessionId: string,
    description: string,
    specs: readonly { index: number; item: string }[],
    now = Date.now(),
    routeLabel?: string,
  ): string {
    const swarmId = `swarm-${String(now)}-${Math.random().toString(36).slice(2, 8)}`;
    const members = new Map<number, SwarmMemberView>();
    for (const spec of specs) {
      const item = clip(spec.item, MEMBER_VIEW_ITEM_MAX_CHARS);
      members.set(spec.index, {
        index: spec.index,
        item,
        ...(item === spec.item ? {} : { itemChars: spec.item.length }),
        phase: "pending",
        retryCount: 0,
      });
    }

    this.seq += 1;
    const batch: SwarmBatch = {
      swarmId,
      sessionId,
      description,
      ...(routeLabel === undefined ? {} : { routeLabel }),
      total: specs.length,
      status: "running",
      startedAt: now,
      members,
      version: 0,
      beginSeq: this.seq,
    };

    this.batches.set(swarmId, batch);
    this.allBatchIds.push(swarmId);

    // 会话移到最近活跃的末尾（Map 迭代顺序即 LRU 顺序）。
    const ids = this.sessionBatches.get(sessionId) ?? [];
    this.sessionBatches.delete(sessionId);
    ids.push(swarmId);
    this.sessionBatches.set(sessionId, ids);
    this.enforceSessionBatchCap(ids, swarmId);
    this.enforceSessionCap(sessionId);

    this.touch(batch);
    return swarmId;
  }

  /**
   * 每会话批次数上限（软上限）：从最旧的**已结束**批次开始淘汰；全是运行中的批次时不淘汰。
   * 运行中的批次一旦被淘汰，它之后的每次相位更新都会静默落空，面板会把它永远停在中途。
   */
  private enforceSessionBatchCap(ids: string[], keep: string): void {
    while (ids.length > this.maxRetainedBatches) {
      const victim = ids.findIndex((id) => id !== keep && this.batches.get(id)?.endedAt !== undefined);
      if (victim < 0) return;
      const [removed] = ids.splice(victim, 1);
      if (removed !== undefined) this.forget(removed);
    }
  }

  /** 会话数上限：从最久未活跃的会话开始整会话淘汰；有运行中批次的会话与当前会话跳过。 */
  private enforceSessionCap(current: string): void {
    if (this.sessionBatches.size <= this.maxRetainedSessions) return;
    for (const [sessionId, ids] of this.sessionBatches) {
      if (this.sessionBatches.size <= this.maxRetainedSessions) return;
      if (sessionId === current) continue;
      if (ids.some((id) => this.batches.get(id)?.endedAt === undefined)) continue;
      for (const id of ids) this.forget(id);
      this.sessionBatches.delete(sessionId);
    }
  }

  private forget(swarmId: string): void {
    this.batches.delete(swarmId);
    const index = this.allBatchIds.indexOf(swarmId);
    if (index >= 0) this.allBatchIds.splice(index, 1);
  }

  markStarting(swarmId: string, index: number): void {
    const found = this.memberOf(swarmId, index);
    if (!found || isTerminal(found.member.phase)) return;
    found.member.phase = "starting";
    this.touch(found.batch);
  }

  setAgentId(swarmId: string, index: number, agentId: string): void {
    const found = this.memberOf(swarmId, index);
    if (!found) return;
    found.member.agentId = agentId;
    this.touch(found.batch);
  }

  markReady(swarmId: string, index: number, now = Date.now()): void {
    const found = this.memberOf(swarmId, index);
    if (!found || isTerminal(found.member.phase)) return;
    found.member.phase = "running";
    if (found.member.startedAt === undefined) {
      found.member.startedAt = now;
    }
    this.touch(found.batch);
  }

  markSuspended(
    swarmId: string,
    index: number,
    retryCount: number,
    retryReadyAt: number,
    detail?: string,
  ): void {
    const found = this.memberOf(swarmId, index);
    if (!found || isTerminal(found.member.phase)) return;
    found.member.phase = "retrying";
    found.member.retryCount = retryCount;
    found.member.retryReadyAt = retryReadyAt;
    if (detail !== undefined) {
      found.member.detail = clip(detail, MEMBER_VIEW_DETAIL_MAX_CHARS);
    }
    this.touch(found.batch);
  }

  markSettled(
    swarmId: string,
    index: number,
    outcome: "completed" | "failed" | "aborted",
    detail?: string,
    now = Date.now(),
  ): void {
    const found = this.memberOf(swarmId, index);
    if (!found) return;
    // 终态**粘性**：落定之后不再改变（与 markSuspended 的终态守卫对称）。
    //
    // 为什么必须如此：批次中断时调度器的 #abandonSuspended 会先把"尚未 ready"的成员
    // 通知成 aborted；而此刻可能仍有在飞的 ctx.subagents.start，它之后才 reject，
    // 宿主 catch 里会再调一次 markSettled("failed")。若允许覆写，这次"后到者"会把
    // 已落定的 aborted 改成 failed，批次又被 endBatch 推导成 failed，与 XML 侧
    // "全员 aborted"的结论重新矛盾——即 2026-10-01 审查 P1-2 的残余时序。
    // 反序同理：先到的终态才是真实发生过的那个结局。
    if (isTerminal(found.member.phase)) return;
    found.member.phase = outcome;
    found.member.settledAt = now;
    if (detail !== undefined) {
      found.member.detail = clip(detail, MEMBER_VIEW_DETAIL_MAX_CHARS);
    }
    this.touch(found.batch);
  }

  endBatch(swarmId: string, now = Date.now()): void {
    const batch = this.batches.get(swarmId);
    if (!batch) return;
    batch.endedAt = now;
    this.seq += 1;
    batch.endSeq = this.seq;

    // 根据成员状态推导批次最终状态
    //
    // 前提（中断收敛，WP-B 修复后）：调度器会把批次中断通知给**每一个**还没走到终态的
    // 成员——包括从未启动的排队成员（SwarmAbandonedEvent 的 agentId 可选，缺省即未启动）。
    // 因此正常结束时此处不应再看到 pending/starting/running/retrying：被中断的成员在
    // onAbandoned 里落 aborted，在跑的成员由宿主侧 run.result 回执落终态。
    //
    // 但仍保留 "非全 completed 且无 aborted → failed" 这条兜底，且**不**把残留相位强行
    // 归位成 aborted。为什么：残留相位在两种真实情况下仍可能出现——
    //   ① 批次根本没进调度器（调度器构造期因 config 非法直接抛出，宿主 finally 仍会
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

    this.touch(batch);
  }

  getBatch(swarmId: string): SwarmBatch | undefined {
    return this.batches.get(swarmId);
  }

  /** 最新批次（指定会话内，或不指定会话时全局）。 */
  getLatestBatch(sessionId?: string): SwarmBatch | undefined {
    const ids = this.batchIdsOf(sessionId);
    const lastId = ids[ids.length - 1];
    return lastId === undefined ? undefined : this.batches.get(lastId);
  }

  /**
   * 当前可见批次（开批次先后，最后一个最新），最多 {@link MAX_VISIBLE_BATCHES} 个。
   *
   * 可见 = 未结束，或结束于最新批次开始**之后**（即与最新批次有时间重叠）。
   * 结束之后才有新批次开始的旧批次视为"被取代"，不再可见。
   */
  visibleBatches(sessionId?: string): SwarmBatch[] {
    const batches: SwarmBatch[] = [];
    for (const id of this.batchIdsOf(sessionId)) {
      const batch = this.batches.get(id);
      if (batch) batches.push(batch);
    }
    const latest = batches[batches.length - 1];
    if (latest === undefined) return [];
    const visible = batches.filter((batch) => batch.endSeq === undefined || batch.endSeq > latest.beginSeq);
    return visible.slice(-MAX_VISIBLE_BATCHES);
  }

  /** 空串与 undefined 同义：不限会话。 */
  private batchIdsOf(sessionId: string | undefined): readonly string[] {
    if (!sessionId) return this.allBatchIds;
    return this.sessionBatches.get(sessionId) ?? [];
  }

  toRosterFrame(batch: SwarmBatch, now = Date.now(), visibleSwarmIds?: readonly string[]): SwarmRosterFrame {
    const membersArray = Array.from(batch.members.values(), (member) => ({ ...member })).sort(
      (a, b) => a.index - b.index,
    );
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
      ...(batch.routeLabel === undefined ? {} : { routeLabel: batch.routeLabel }),
      total: batch.total,
      activeCount,
      completedCount,
      failedCount,
      abortedCount,
      members: membersArray,
      ...(visibleSwarmIds === undefined ? {} : { visibleSwarmIds: [...visibleSwarmIds] }),
      at: now,
    };
  }

  /**
   * 某会话（或不指定会话时全局）的帧流：连接时先给当前可见批次的全量，之后每次**本会话**有变化，
   * 合窗 flushMs 后只发变化了的部分。
   *
   * 每个批次的帧序：opened → roster（之后每次版本变化再发 roster）→ closed（结束后恰好一次）。
   * 批次退出可见集合时若还没发过 closed（且已结束），先补发 closed 再遗忘它。
   */
  async *framesFor(
    sessionId: string | undefined,
    signal: AbortSignal,
    flushMs = this.flushMs,
  ): AsyncIterable<SwarmFrame> {
    signal.throwIfAborted();
    const scope = sessionId ? sessionId : undefined;
    const waiter = new OutputWaiter();
    const unsubscribe = this.subscribe((changed) => {
      // 只被本会话的变化唤醒（对齐官方推流骨架的按会话过滤）；不限会话的流对任何变化都醒。
      if (scope === undefined || changed === scope) waiter.wake();
    });
    const cursor: StreamCursor = { announced: new Map(), visibleKey: "" };

    try {
      yield* this.diffFrames(scope, cursor);
      while (true) {
        await waiter.wait(signal);
        if (flushMs > 0) {
          await sleepWithSignal(flushMs, signal);
        }
        if (signal.aborted) return;
        yield* this.diffFrames(scope, cursor);
      }
    } finally {
      unsubscribe();
    }
  }

  /** 相对 cursor 记录的已发送状态，产出本次需要补发的帧，并推进 cursor。 */
  private *diffFrames(sessionId: string | undefined, cursor: StreamCursor): Generator<SwarmFrame> {
    const visible = this.visibleBatches(sessionId);
    const visibleIds = visible.map((batch) => batch.swarmId);
    const visibleKey = visibleIds.join("\n");
    const membershipChanged = visibleKey !== cursor.visibleKey;
    cursor.visibleKey = visibleKey;
    const visibleSet = new Set(visibleIds);

    // ① 退出可见集合的批次：补发尚未发出的 closed，然后遗忘。
    for (const [swarmId, seen] of cursor.announced) {
      if (visibleSet.has(swarmId)) continue;
      const batch = this.batches.get(swarmId);
      if (!seen.closed && batch?.endedAt !== undefined) yield closedFrameOf(batch);
      cursor.announced.delete(swarmId);
    }

    // ② 可见批次：新出现的发 opened + roster（已结束则补 closed）；已知的只在版本变化时重发 roster。
    //    可见集合变化时，最新批次的 roster 无论版本是否变化都重发一次——它携带新的 visibleSwarmIds，
    //    客户端据此清理退出的批次。
    const newest = visible[visible.length - 1];
    for (const batch of visible) {
      const seen = cursor.announced.get(batch.swarmId);
      if (seen === undefined) {
        yield openedFrameOf(batch);
        yield this.toRosterFrame(batch, Date.now(), visibleIds);
        const entry: AnnouncedBatch = { version: batch.version, closed: false };
        cursor.announced.set(batch.swarmId, entry);
        if (batch.endedAt !== undefined) {
          yield closedFrameOf(batch);
          entry.closed = true;
        }
        continue;
      }
      if (seen.version !== batch.version || (membershipChanged && batch === newest)) {
        yield this.toRosterFrame(batch, Date.now(), visibleIds);
        seen.version = batch.version;
      }
      if (batch.endedAt !== undefined && !seen.closed) {
        yield closedFrameOf(batch);
        seen.closed = true;
      }
    }
  }
}

function openedFrameOf(batch: SwarmBatch): SwarmOpenedFrame {
  return {
    type: "opened",
    swarmId: batch.swarmId,
    sessionId: batch.sessionId,
    description: batch.description,
    ...(batch.routeLabel === undefined ? {} : { routeLabel: batch.routeLabel }),
    total: batch.total,
    at: batch.startedAt,
  };
}

function closedFrameOf(batch: SwarmBatch): SwarmClosedFrame {
  return {
    type: "closed",
    swarmId: batch.swarmId,
    sessionId: batch.sessionId,
    at: batch.endedAt ?? batch.startedAt,
  };
}
