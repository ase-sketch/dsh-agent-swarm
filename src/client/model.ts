/**
 * dsh-agent-swarm — 客户端数据快照模型
 *
 * 维护每个会话当前的 Swarm Roster 状态与流失败态，供 React 组件订阅消费。
 */

import { useSyncExternalStore } from "react";
import type { SwarmRosterFrame } from "../swarm-registry.js";

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

export interface SwarmClientState {
  bySession: Record<string, SwarmRosterFrame | undefined>;
  /** 按会话记录流失败；同一会话有新帧抵达即清除（流已恢复）。 */
  streamFailures: Record<string, SwarmStreamFailure | undefined>;
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

    this.state = {
      ...this.state,
      bySession: {
        ...this.state.bySession,
        [sessionId]: frame,
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
        // 忽略监听者异常
      }
    }
  }
}
