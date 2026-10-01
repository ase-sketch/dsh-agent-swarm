/**
 * dsh-agent-swarm — 客户端数据快照模型
 *
 * 维护每个会话当前**可见批次**的 roster 快照与流失败态，供 React 组件订阅消费。
 *
 * 一个会话可能同时有多个可见批次（同一条消息里并发发起的几次 agent_swarm）：
 * host 半的 roster 帧携带 visibleSwarmIds（该会话当前可见集合），模型据此按 swarmId 合并、
 * 按开批次先后排序，并清理已退出可见集合的批次。
 */

import { useSyncExternalStore } from "react";
import type { SwarmRosterFrame } from "../swarm-registry.js";

/**
 * 不带 visibleSwarmIds 的帧（旧帧）合并时，单会话最多保留的批次数。
 * 与 host 半 swarm-registry.ts 的 MAX_VISIBLE_BATCHES 取同一个值；这里刻意不 import 它——
 * client 半对 host 模块只允许**类型**引用（见 ARCHITECTURE「依赖方向」），值引用会把整个
 * registry 打进客户端 bundle。
 */
const MAX_KEPT_BATCHES = 8;

/**
 * 单会话流失败快照。
 *
 * 存在的意义就是"可见"：流异常终止时不再被静默吞掉，面板可以据此渲染错误，
 * 而不是停在被截断的旧帧上假装一切正常。
 */
export interface SwarmStreamFailure {
  /** 失败原因（异常的 message，或流非主动结束的描述）。 */
  message: string;
  /** 记录时刻（毫秒时间戳）。 */
  at: number;
}

/** 单会话视图：当前可见批次，按开批次先后排列，最后一个最新。 */
export interface SwarmSessionView {
  batches: SwarmRosterFrame[];
}

export interface SwarmClientState {
  bySession: Record<string, SwarmSessionView | undefined>;
  /** 按会话记录流失败；同一会话有新帧抵达即清除（流已恢复）。 */
  streamFailures: Record<string, SwarmStreamFailure | undefined>;
}

/** 视图里最新的批次（没有批次时为 undefined）。 */
export function latestBatchOf(view: SwarmSessionView | undefined): SwarmRosterFrame | undefined {
  return view?.batches[view.batches.length - 1];
}

/**
 * 把一帧 roster 合并进已有批次列表（纯函数）。
 *
 * - 帧带 visibleSwarmIds：以它为准排序并裁剪——退出可见集合的批次被移除，
 *   尚未收到帧的可见批次暂缺（它自己的帧随后就到）；
 * - 帧不带（旧帧或单独构造的帧）：按 swarmId 原位替换或追加，最多保留 MAX_KEPT_BATCHES 个。
 */
export function mergeRosterFrame(
  batches: readonly SwarmRosterFrame[],
  frame: SwarmRosterFrame,
): SwarmRosterFrame[] {
  if (frame.visibleSwarmIds !== undefined) {
    const byId = new Map(batches.map((batch) => [batch.swarmId, batch] as const));
    byId.set(frame.swarmId, frame);
    const merged: SwarmRosterFrame[] = [];
    for (const swarmId of frame.visibleSwarmIds) {
      const batch = byId.get(swarmId);
      if (batch !== undefined) merged.push(batch);
    }
    return merged;
  }
  const index = batches.findIndex((batch) => batch.swarmId === frame.swarmId);
  const merged = index >= 0 ? batches.map((batch, i) => (i === index ? frame : batch)) : [...batches, frame];
  return merged.slice(-MAX_KEPT_BATCHES);
}

export class ClientSwarmModel {
  private state: SwarmClientState = { bySession: {}, streamFailures: {} };
  private listeners = new Set<() => void>();

  getSnapshot = (): SwarmClientState => {
    return this.state;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  rosterReceived(frame: SwarmRosterFrame): void {
    if (!frame.sessionId) return;
    const sessionId = frame.sessionId;

    // 流恢复：清掉该会话的失败标记，否则面板会一直挂着已经过期的错误
    const streamFailures = { ...this.state.streamFailures };
    if (streamFailures[sessionId] !== undefined) delete streamFailures[sessionId];

    const previous = this.state.bySession[sessionId]?.batches ?? [];
    this.state = {
      ...this.state,
      bySession: {
        ...this.state.bySession,
        [sessionId]: { batches: mergeRosterFrame(previous, frame) },
      },
      streamFailures,
    };
    this.emit();
  }

  /** 记录一次流失败（异常终止或非主动结束），供面板显示。 */
  streamFailed(sessionId: string, message: string): void {
    if (!sessionId) return;
    this.state = {
      ...this.state,
      streamFailures: {
        ...this.state.streamFailures,
        [sessionId]: { message, at: Date.now() },
      },
    };
    this.emit();
  }

  useSwarm = <T,>(selector: (state: SwarmClientState) => T): T => {
    const snap = useSyncExternalStore(this.subscribe, this.getSnapshot);
    return selector(snap);
  };

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 监听者自身的异常不得阻断其它监听者（React 订阅方各自处理渲染错误）。
      }
    }
  }
}
