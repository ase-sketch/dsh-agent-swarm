/**
 * dsh-agent-swarm — 客户端数据快照模型
 *
 * 维护每个会话当前的 Swarm Roster 状态，供 React 组件订阅消费。
 */

import { useSyncExternalStore } from "react";
import type { SwarmRosterFrame } from "../swarm-registry.js";

export interface SwarmClientState {
  bySession: Record<string, SwarmRosterFrame | undefined>;
}

export class ClientSwarmModel {
  private state: SwarmClientState = { bySession: {} };
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
    this.state = {
      ...this.state,
      bySession: {
        ...this.state.bySession,
        [frame.sessionId]: frame,
      },
    };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 忽略监听者异常
      }
    }
  }

  useSwarm = <T,>(selector: (state: SwarmClientState) => T): T => {
    const snap = useSyncExternalStore(this.subscribe, this.getSnapshot);
    return selector(snap);
  };
}
