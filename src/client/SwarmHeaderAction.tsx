/**
 * dsh-agent-swarm — 会话标题栏 Swarm 状态动作与弹层组件
 */

import { useState, useEffect, useRef, useMemo } from "react";
import type { SwarmMemberView, SwarmPhase } from "../swarm-registry.js";
import type { SwarmClientState } from "./model.js";

const CSS_TAG_ID = "dsh-agent-swarm/style.css";

const CSS_CONTENT = `
.dsh-swarm-root {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.dsh-swarm-trigger {
  border-radius: var(--dsw-radius-sm, 6px);
  min-height: 28px;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  cursor: pointer;
  background: transparent;
  border: 0;
  align-items: center;
  gap: 5px;
  padding: 3px 6px;
  font-size: 12px;
  line-height: 18px;
  display: inline-flex;
  transition: all 0.15s ease;
}

.dsh-swarm-trigger:hover,
.dsh-swarm-trigger:focus-visible {
  color: var(--dsw-alias-label-primary, #f1f5f9);
  background: var(--dsw-alias-fill-l1, rgba(255, 255, 255, 0.06));
}

.dsh-swarm-trigger.active {
  color: var(--dsw-alias-state-info-primary, #38bdf8);
}

.dsh-swarm-badge {
  padding: 1px 5px;
  border-radius: var(--dsw-radius-xs, 4px);
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  background: var(--dsw-alias-fill-l2, rgba(255, 255, 255, 0.1));
}

.dsh-swarm-badge.live {
  background: color-mix(in srgb, var(--dsw-alias-state-info-primary, #38bdf8) 25%, transparent);
  color: var(--dsw-alias-state-info-primary, #38bdf8);
}

.dsh-swarm-popover {
  z-index: 1000;
  box-sizing: border-box;
  border-radius: var(--dsw-radius-lg, 10px);
  background: var(--dsw-specific-menu, #18181b);
  width: 500px;
  min-width: 360px;
  max-width: min(560px, 100vw - 24px);
  max-height: min(480px, 100vh - 120px);
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(16px));
  box-shadow: var(--dsw-elevation-prominent, 0 10px 25px -5px rgba(0, 0, 0, 0.5));
  border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1));
  display: flex;
  flex-direction: column;
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: auto;
  overflow: hidden;
  animation: dsh-swarm-fadein 0.12s ease-out;
}

@keyframes dsh-swarm-fadein {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

.dsh-swarm-header {
  padding: 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--dsw-alias-fill-l1, rgba(255, 255, 255, 0.02));
  flex: none;
  min-width: 0;
  box-sizing: border-box;
}

.dsh-swarm-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.dsh-swarm-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #f1f5f9);
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  white-space: nowrap;
}

.dsh-swarm-title svg {
  flex: none;
}

.dsh-swarm-member-count {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #64748b);
  flex: none;
  white-space: nowrap;
}

.dsh-swarm-desc {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #64748b);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.dsh-swarm-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 6px 14px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.06));
  background: var(--dsw-alias-fill-l1, rgba(255, 255, 255, 0.01));
  flex: none;
  min-width: 0;
  box-sizing: border-box;
}

.dsh-swarm-stats span {
  white-space: nowrap;
}

.dsh-swarm-list {
  padding: 6px;
  overflow-y: auto;
  overflow-x: hidden;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 360px;
  min-width: 0;
  box-sizing: border-box;
}

.dsh-swarm-row {
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md, 6px);
  background: var(--dsw-alias-fill-l1, rgba(255, 255, 255, 0.03));
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.04));
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: background 0.1s;
  min-width: 0;
  box-sizing: border-box;
}

.dsh-swarm-row:hover {
  background: var(--dsw-alias-fill-l2, rgba(255, 255, 255, 0.06));
}

.dsh-swarm-row-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
}

.dsh-swarm-row-index {
  font-family: var(--dsw-font-mono, monospace);
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #64748b);
  flex: none;
  white-space: nowrap;
}

.dsh-swarm-row-item {
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #f1f5f9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.dsh-swarm-phase-badge {
  padding: 1px 6px;
  border-radius: var(--dsw-radius-xs, 4px);
  font-size: 10px;
  font-weight: 500;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.dsh-swarm-agent-id {
  font-family: var(--dsw-font-mono, monospace);
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #64748b);
  background: rgba(255, 255, 255, 0.04);
  padding: 1px 4px;
  border-radius: 3px;
  flex: none;
  white-space: nowrap;
}

.dsh-swarm-detail {
  font-size: 11px;
  color: var(--dsw-alias-state-warning-primary, #f59e0b);
  padding-left: 20px;
  word-break: break-all;
  overflow-wrap: anywhere;
  min-width: 0;
}

.dsh-swarm-detail.error {
  color: var(--dsw-alias-state-error-primary, #ef4444);
}

.dsh-swarm-empty {
  padding: 32px 16px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary, #64748b);
  font-size: 12px;
  box-sizing: border-box;
}

.dsh-swarm-trigger.error {
  color: var(--dsw-alias-state-error-primary, #ef4444);
}

.dsh-swarm-stream-error {
  padding: 6px 14px;
  font-size: 11px;
  color: var(--dsw-alias-state-error-primary, #ef4444);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 12%, transparent);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.06));
  word-break: break-all;
  overflow-wrap: anywhere;
  flex: none;
  box-sizing: border-box;
}
`;

/**
 * 一次性注入面板样式。
 *
 * 幂等：重复调用只会复用/更新同一个 style 标签。调用点在 apply 期（渲染之前），
 * 组件挂载时再兜底调一次——都不在渲染函数体内，因此不会每次 re-render 都查 DOM。
 */
export function ensureCssInjected(): void {
  if (typeof document === "undefined" || !document.head) return;

  const existing = document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`);
  if (!existing) {
    const style = document.createElement("style");
    style.dataset.plugin = "dsh-agent-swarm";
    style.dataset.pluginCss = CSS_TAG_ID;
    style.textContent = CSS_CONTENT;
    document.head.appendChild(style);
  } else if (existing.textContent !== CSS_CONTENT) {
    existing.textContent = CSS_CONTENT;
  }
}

/**
 * 找出最近一次限流重试的发起时刻。
 *
 * 只有 phase === "retrying" 且带 retryReadyAt 的成员参与计算；没有这类成员时返回 null
 * ——调用方据此决定"要不要保留倒计时定时器"。
 */
export function earliestRetryAt(members: readonly SwarmMemberView[] | undefined): number | null {
  let earliest: number | null = null;
  for (const member of members ?? []) {
    if (member.phase !== "retrying") continue;
    const readyAt = member.retryReadyAt;
    if (typeof readyAt !== "number") continue;
    if (earliest === null || readyAt < earliest) earliest = readyAt;
  }
  return earliest;
}

/** 距发起还剩几秒（向上取整，最少 1）；已到点返回 0，供 UI 决定是否隐藏倒计时。 */
export function retrySecondsLeft(deadline: number, now: number): number {
  const remaining = deadline - now;
  if (remaining <= 0) return 0;
  return Math.max(1, Math.ceil(remaining / 1000));
}

/**
 * 限流退避倒计时用的 1 秒节拍器。
 *
 * 只在"存在尚未到点的重试"期间存在：sync(null) 或截止时刻已过即停止（到点自停），
 * 因此不会留下常驻定时器。抽成独立类是为了让"定时器何时存在"可被断言，
 * 而不是埋在 React effect 里无从观察。
 */
export class RetryTicker {
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly onTick: () => void) {}

  /** 当前是否有 1 秒定时器在跑。 */
  get running(): boolean {
    return this.handle !== null;
  }

  /** 按最近的重试截止时刻同步：需要倒计时就保证在跑，否则立即清理。 */
  sync(deadline: number | null): void {
    if (deadline === null || deadline <= Date.now()) {
      this.stop();
      return;
    }
    if (this.handle !== null) return;
    this.handle = setInterval(() => {
      this.onTick();
      // 到点即自停，避免退避结束后留下常驻定时器
      this.sync(deadline);
    }, 1000);
  }

  /** 幂等清理。 */
  stop(): void {
    if (this.handle === null) return;
    clearInterval(this.handle);
    this.handle = null;
  }
}

const PHASE_CONFIG: Record<SwarmPhase, { label: string; bg: string; color: string }> = {
  pending: { label: "等待中", bg: "rgba(148, 163, 184, 0.15)", color: "#94a3b8" },
  starting: { label: "启动中", bg: "rgba(56, 189, 248, 0.15)", color: "#38bdf8" },
  running: { label: "执行中", bg: "rgba(14, 165, 233, 0.25)", color: "#0ea5e9" },
  retrying: { label: "限流退避", bg: "rgba(245, 158, 11, 0.2)", color: "#f59e0b" },
  completed: { label: "已完成", bg: "rgba(16, 185, 129, 0.2)", color: "#10b981" },
  failed: { label: "失败", bg: "rgba(239, 68, 68, 0.2)", color: "#ef4444" },
  aborted: { label: "取消", bg: "rgba(100, 116, 139, 0.2)", color: "#94a3b8" },
};

function SwarmIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L3 7v10l9 5 9-5V7l-9-5z" />
      <path d="M12 22V12" />
      <path d="M21 7l-9 5-9-5" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
  );
}

export interface SwarmHeaderActionProps {
  sessionId: string;
  useSwarm: <T>(selector: (state: SwarmClientState) => T) => T;
  watchSwarm: (sessionId: string) => () => void;
}

export function SwarmHeaderAction({ sessionId, useSwarm, watchSwarm }: SwarmHeaderActionProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuShift, setMenuShift] = useState(0);
  // 倒计时基准时钟：仅在存在待重试成员时由 RetryTicker 推进
  const [now, setNow] = useState(() => Date.now());
  const tickerRef = useRef<RetryTicker | null>(null);

  // 样式兜底注入：apply 期已注入过一次，这里按挂载再确认一次（不在渲染期查 DOM）
  useEffect(() => {
    ensureCssInjected();
  }, []);

  // 挂载时开启当前会话的流监听
  useEffect(() => {
    return watchSwarm(sessionId);
  }, [sessionId, watchSwarm]);

  // 点击外部关闭弹层
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open]);

  // 视口边界自适应对齐（向官方 jobs 面板 JobListAction 对齐）
  useEffect(() => {
    if (!open) {
      setMenuShift(0);
      return;
    }
    const fit = () => {
      const root = rootRef.current;
      const menu = menuRef.current;
      if (!root || !menu) return;
      const width = menu.offsetWidth;
      if (width === 0) return;
      const anchorLeft = root.getBoundingClientRect().left;
      const VIEWPORT_MARGIN = 12;
      setMenuShift(
        Math.max(
          VIEWPORT_MARGIN - anchorLeft,
          Math.min(0, window.innerWidth - VIEWPORT_MARGIN - width - anchorLeft)
        )
      );
    };
    fit();
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("resize", fit);
    };
  }, [open]);

  // 从 Model 订阅当前会话数据与流失败态
  const batch = useSwarm((state) => state.bySession[sessionId]);
  const streamFailure = useSwarm((state) => state.streamFailures[sessionId]);

  const hasBatch = Boolean(batch && batch.total > 0);
  const isLive = Boolean(batch && batch.activeCount > 0);

  // 最近一次限流重试的发起时刻；没有待重试成员时为 null
  const retryDeadline = useMemo(() => earliestRetryAt(batch?.members), [batch]);

  // 只有存在尚未到点的重试时才让 1 秒定时器活着；否则立即清理（无常驻定时器）
  useEffect(() => {
    let ticker = tickerRef.current;
    if (!ticker) {
      ticker = new RetryTicker(() => setNow(Date.now()));
      tickerRef.current = ticker;
    }
    // 截止时刻变化时对齐一次时钟，避免用陈旧快照渲染出偏大的秒数
    setNow(Date.now());
    ticker.sync(retryDeadline);
    return () => ticker.stop();
  }, [retryDeadline]);

  const badgeText = useMemo(() => {
    if (!batch || batch.total === 0) return "0";
    if (batch.activeCount > 0) return `${batch.activeCount}/${batch.total}`;
    return `${batch.completedCount}/${batch.total}`;
  }, [batch]);

  return (
    <div className="dsh-swarm-root" ref={rootRef}>
      <button
        type="button"
        className={`dsh-swarm-trigger ${isLive ? "active" : ""} ${streamFailure ? "error" : ""}`}
        onClick={() => setOpen(!open)}
        title={streamFailure ? `流连接中断：${streamFailure.message}` : "Swarm 智能体队列"}
      >
        <SwarmIcon />
        <span>Swarm</span>
        <span className={`dsh-swarm-badge ${isLive ? "live" : ""}`}>
          {badgeText}
        </span>
      </button>

      {open && (
        <div
          ref={menuRef}
          className="dsh-swarm-popover"
          style={{ left: menuShift }}
        >
          <div className="dsh-swarm-header">
            <div className="dsh-swarm-title-row">
              <span className="dsh-swarm-title">
                <SwarmIcon />
                Swarm 智能体队列
              </span>
              {batch && (
                <span className="dsh-swarm-member-count">
                  {batch.total} 个成员
                </span>
              )}
            </div>
            {batch?.description ? (
              <div className="dsh-swarm-desc" title={batch.description}>
                {batch.description}
              </div>
            ) : (
              <div className="dsh-swarm-desc">会话级并发调度监控</div>
            )}
          </div>

          {streamFailure && (
            <div className="dsh-swarm-stream-error" title={streamFailure.message}>
              流连接中断：{streamFailure.message}
            </div>
          )}

          {hasBatch && batch ? (
            <>
              <div className="dsh-swarm-stats">
                <span>运行中: <strong style={{ color: "#38bdf8" }}>{batch.activeCount}</strong></span>
                <span>已完成: <strong style={{ color: "#10b981" }}>{batch.completedCount}</strong></span>
                {batch.failedCount > 0 && (
                  <span>失败: <strong style={{ color: "#ef4444" }}>{batch.failedCount}</strong></span>
                )}
                {batch.abortedCount > 0 && (
                  <span>取消: <strong style={{ color: "#94a3b8" }}>{batch.abortedCount}</strong></span>
                )}
              </div>

              <div className="dsh-swarm-list">
                {batch.members.map((m: SwarmMemberView) => {
                  const cfg = PHASE_CONFIG[m.phase] ?? PHASE_CONFIG.pending;
                  const secondsLeft =
                    m.retryReadyAt === undefined ? 0 : retrySecondsLeft(m.retryReadyAt, now);
                  return (
                    <div key={m.index} className="dsh-swarm-row">
                      <div className="dsh-swarm-row-main">
                        <span className="dsh-swarm-row-index">#{m.index}</span>
                        <span
                          className="dsh-swarm-phase-badge"
                          style={{ backgroundColor: cfg.bg, color: cfg.color }}
                        >
                          {cfg.label}
                        </span>
                        <span className="dsh-swarm-row-item" title={m.item}>
                          {m.item}
                        </span>
                        {m.agentId && (
                          <span className="dsh-swarm-agent-id" title={m.agentId}>
                            {m.agentId.slice(0, 10)}
                          </span>
                        )}
                      </div>

                      {m.phase === "retrying" && (
                        <div className="dsh-swarm-detail">
                          第 {m.retryCount} 次限流重试
                          {secondsLeft > 0 ? (
                            <span> · 约 {secondsLeft} 秒后发起</span>
                          ) : null}
                          {m.detail ? <span> ({m.detail})</span> : null}
                        </div>
                      )}

                      {m.phase === "failed" && m.detail && (
                        <div className="dsh-swarm-detail error" title={m.detail}>
                          {m.detail}
                        </div>
                      )}

                      {m.phase === "aborted" && m.detail && (
                        <div className="dsh-swarm-detail" title={m.detail}>
                          {m.detail}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="dsh-swarm-empty">
              当前会话暂无运行中的 Swarm 任务
            </div>
          )}
        </div>
      )}
    </div>
  );
}
