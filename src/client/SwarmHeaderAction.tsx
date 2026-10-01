/**
 * dsh-agent-swarm — 会话标题栏 Swarm 状态动作与弹层组件
 */

import { useState, useEffect, useRef, useMemo } from "react";
import type { SwarmMemberView, SwarmPhase, SwarmRosterFrame } from "../swarm-registry.js";
import type { SwarmClientState } from "./model.js";
import { fallbackTranslate, type SwarmLocaleKey, type SwarmTranslate } from "./locales.js";

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

.dsh-swarm-route {
  font-family: var(--dsw-font-mono, monospace);
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #64748b);
  background: rgba(255, 255, 255, 0.04);
  padding: 1px 6px;
  border-radius: 3px;
  display: inline-flex;
  align-self: flex-start;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
}

.dsh-swarm-group-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-radius: var(--dsw-radius-md, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  font-size: 11px;
  cursor: pointer;
  text-align: left;
  box-sizing: border-box;
}

.dsh-swarm-group-toggle:hover {
  background: var(--dsw-alias-fill-l1, rgba(255, 255, 255, 0.04));
  color: var(--dsw-alias-label-primary, #f1f5f9);
}

.dsh-swarm-group-arrow {
  flex: none;
  font-size: 9px;
  transition: transform 0.12s ease;
}

.dsh-swarm-group-arrow.open {
  transform: rotate(90deg);
}

.dsh-swarm-tabs {
  display: flex;
  gap: 4px;
  padding: 6px 10px;
  overflow-x: auto;
  scrollbar-width: thin;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.06));
  flex: none;
  min-width: 0;
  box-sizing: border-box;
}

.dsh-swarm-tab {
  flex: none;
  max-width: 180px;
  padding: 2px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dsh-swarm-tab.active {
  background: var(--dsw-alias-fill-l2, rgba(255, 255, 255, 0.08));
  color: var(--dsw-alias-label-primary, #f1f5f9);
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
  /* flex 子项默认 min-height:auto 会撑破滚容器，必须归零滚动才生效 */
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* 列表长度定死：超出即滚轮，绝不把弹层继续往下撑 */
  max-height: 360px;
  min-width: 0;
  box-sizing: border-box;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-fill-l3, rgba(255, 255, 255, 0.16)) transparent;
}

.dsh-swarm-list::-webkit-scrollbar {
  width: 6px;
}

.dsh-swarm-list::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-fill-l3, rgba(255, 255, 255, 0.16));
  border-radius: 3px;
}

.dsh-swarm-list::-webkit-scrollbar-track {
  background: transparent;
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

// ───────────────────────── 多批次（同一会话并发的几次调用）─────────────────────────

/** 选中的批次；未选或选中的已不可见时回到最新批次。 */
export function selectBatch(
  batches: readonly SwarmRosterFrame[],
  selectedSwarmId: string | undefined,
): SwarmRosterFrame | undefined {
  return batches.find((batch) => batch.swarmId === selectedSwarmId) ?? batches[batches.length - 1];
}

/**
 * 标题栏徽标：对**全部可见批次**聚合。
 * 有成员在跑时显示 `在跑/总数` 并点亮；全部收场后显示 `已完成/总数`。
 */
export function summarizeBatches(batches: readonly SwarmRosterFrame[]): { badgeText: string; isLive: boolean } {
  let total = 0;
  let active = 0;
  let completed = 0;
  for (const batch of batches) {
    total += batch.total;
    active += batch.activeCount;
    completed += batch.completedCount;
  }
  if (total === 0) return { badgeText: "0", isLive: false };
  if (active > 0) return { badgeText: `${String(active)}/${String(total)}`, isLive: true };
  return { badgeText: `${String(completed)}/${String(total)}`, isLive: false };
}

const EMPTY_BATCHES: readonly SwarmRosterFrame[] = [];

const PHASE_CONFIG: Record<SwarmPhase, { label: SwarmLocaleKey; bg: string; color: string }> = {
  pending: { label: "phase.pending", bg: "rgba(148, 163, 184, 0.15)", color: "#94a3b8" },
  starting: { label: "phase.starting", bg: "rgba(56, 189, 248, 0.15)", color: "#38bdf8" },
  running: { label: "phase.running", bg: "rgba(14, 165, 233, 0.25)", color: "#0ea5e9" },
  retrying: { label: "phase.retrying", bg: "rgba(245, 158, 11, 0.2)", color: "#f59e0b" },
  completed: { label: "phase.completed", bg: "rgba(16, 185, 129, 0.2)", color: "#10b981" },
  failed: { label: "phase.failed", bg: "rgba(239, 68, 68, 0.2)", color: "#ef4444" },
  aborted: { label: "phase.aborted", bg: "rgba(100, 116, 139, 0.2)", color: "#94a3b8" },
};

// ───────────────────────── 成员分组（收纳）─────────────────────────

type SwarmGroupKey = "active" | "failed" | "completed" | "aborted";

interface SwarmGroupDef {
  key: SwarmGroupKey;
  label: SwarmLocaleKey;
  match: (phase: SwarmPhase) => boolean;
}

/** 组序即渲染序：进行中 → 失败 → 已完成 → 已取消。 */
const SWARM_GROUP_DEFS: readonly SwarmGroupDef[] = [
  {
    key: "active",
    label: "group.active",
    match: (p) => p === "pending" || p === "starting" || p === "running" || p === "retrying",
  },
  { key: "failed", label: "group.failed", match: (p) => p === "failed" },
  { key: "completed", label: "group.completed", match: (p) => p === "completed" },
  { key: "aborted", label: "group.aborted", match: (p) => p === "aborted" },
];

/** 默认展开态：需要关注的（进行中/失败）展开，已收场的（完成/取消）收起。 */
const SWARM_GROUP_DEFAULT_OPEN: Record<SwarmGroupKey, boolean> = {
  active: true,
  failed: true,
  completed: false,
  aborted: false,
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
  /**
   * 框架按槽位声明的 `locale` 注入的翻译函数（与官方 jobs 面板同一机制）。
   * 缺省时回落到内置中文字典——接线前的显示效果。
   */
  t?: SwarmTranslate;
}

export function SwarmHeaderAction({ sessionId, useSwarm, watchSwarm, t }: SwarmHeaderActionProps) {
  const tr = t ?? fallbackTranslate;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuShift, setMenuShift] = useState(0);
  // 倒计时基准时钟：仅在存在待重试成员时由 RetryTicker 推进
  const [now, setNow] = useState(() => Date.now());
  const tickerRef = useRef<RetryTicker | null>(null);
  // 分组折叠态：进行中/失败默认展开（需要关注），已完成/已取消默认收起（收纳）。
  // 每组独立开关——成员多时任何一组都可以单独收起来。
  const [openGroups, setOpenGroups] = useState<Record<SwarmGroupKey, boolean>>({
    ...SWARM_GROUP_DEFAULT_OPEN,
  });

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

  // 从 Model 订阅当前会话的可见批次与流失败态
  const view = useSwarm((state) => state.bySession[sessionId]);
  const streamFailure = useSwarm((state) => state.streamFailures[sessionId]);
  const batches = view?.batches ?? EMPTY_BATCHES;

  // 多个可见批次时可切换查看；有新批次出现（最新批次变了）就回到最新。
  const [selectedSwarmId, setSelectedSwarmId] = useState<string | undefined>(undefined);
  const latestSwarmId = batches[batches.length - 1]?.swarmId;
  useEffect(() => {
    setSelectedSwarmId(undefined);
  }, [latestSwarmId]);
  const batch = selectBatch(batches, selectedSwarmId);

  // 换了批次就重置折叠态：旧批次的展开选择不该泄漏到新批次
  const swarmId = batch?.swarmId;
  useEffect(() => {
    setOpenGroups({ ...SWARM_GROUP_DEFAULT_OPEN });
  }, [swarmId]);

  const hasBatch = Boolean(batch && batch.total > 0);
  const { badgeText, isLive } = useMemo(() => summarizeBatches(batches), [batches]);

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


  return (
    <div className="dsh-swarm-root" ref={rootRef}>
      <button
        type="button"
        className={`dsh-swarm-trigger ${isLive ? "active" : ""} ${streamFailure ? "error" : ""}`}
        onClick={() => setOpen(!open)}
        title={streamFailure ? tr("stream.error", { message: streamFailure.message }) : tr("title")}
      >
        <SwarmIcon />
        <span>{tr("trigger.label")}</span>
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
                {tr("title")}
              </span>
              {batch && (
                <span className="dsh-swarm-member-count">
                  {tr("header.members", { count: batch.total })}
                </span>
              )}
            </div>
            {batch?.description ? (
              <div className="dsh-swarm-desc" title={batch.description}>
                {batch.description}
              </div>
            ) : (
              <div className="dsh-swarm-desc">{tr("header.descFallback")}</div>
            )}
            {batch?.routeLabel && (
              <span className="dsh-swarm-route" title={batch.routeLabel}>
                {tr("header.route", { route: batch.routeLabel })}
              </span>
            )}
          </div>

          {batches.length > 1 && (
            <div className="dsh-swarm-tabs" role="tablist">
              {batches.map((candidate, position) => {
                const selected = candidate.swarmId === batch?.swarmId;
                return (
                  <button
                    key={candidate.swarmId}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={`dsh-swarm-tab ${selected ? "active" : ""}`}
                    title={candidate.description}
                    onClick={() => setSelectedSwarmId(candidate.swarmId)}
                  >
                    #{position + 1} {candidate.description}
                    {candidate.activeCount > 0 ? ` · ${String(candidate.activeCount)}/${String(candidate.total)}` : ""}
                  </button>
                );
              })}
            </div>
          )}

          {streamFailure && (
            <div className="dsh-swarm-stream-error" title={streamFailure.message}>
              {tr("stream.error", { message: streamFailure.message })}
            </div>
          )}

          {hasBatch && batch ? (
            <>
              <div className="dsh-swarm-stats">
                <span>{tr("stats.running")}: <strong style={{ color: "#38bdf8" }}>{batch.activeCount}</strong></span>
                <span>{tr("stats.completed")}: <strong style={{ color: "#10b981" }}>{batch.completedCount}</strong></span>
                {batch.failedCount > 0 && (
                  <span>{tr("stats.failed")}: <strong style={{ color: "#ef4444" }}>{batch.failedCount}</strong></span>
                )}
                {batch.abortedCount > 0 && (
                  <span>{tr("stats.aborted")}: <strong style={{ color: "#94a3b8" }}>{batch.abortedCount}</strong></span>
                )}
              </div>

              <div className="dsh-swarm-list">
                {(() => {
                  const renderRow = (m: SwarmMemberView) => {
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
                            {tr(cfg.label)}
                          </span>
                          <span
                            className="dsh-swarm-row-item"
                            title={
                              m.itemChars === undefined
                                ? m.item
                                : tr("item.truncated", { item: m.item, count: m.itemChars })
                            }
                          >
                            {m.item}
                          </span>
                          {m.agentId && (
                            <span className="dsh-swarm-agent-id" title={m.agentId}>
                              {/* 按码点取前 10 个，不劈开代理对（client 不引 host 模块的值，故就地处理） */}
                              {Array.from(m.agentId).slice(0, 10).join("")}
                            </span>
                          )}
                        </div>

                        {m.phase === "retrying" && (
                          <div className="dsh-swarm-detail">
                            {tr("retry.line", { count: m.retryCount })}
                            {secondsLeft > 0 ? <span>{tr("retry.eta", { seconds: secondsLeft })}</span> : null}
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
                  };

                  // 收纳规则：四类成员各自独立成组（进行中/失败/已完成/已取消），
                  // 每组都可单独折叠——成员一多，任何一组都不会把列表无限拉长。
                  return (
                    <>
                      {SWARM_GROUP_DEFS.map((group) => {
                        const members = batch.members.filter((m: SwarmMemberView) => group.match(m.phase));
                        if (members.length === 0) return null;
                        const isOpen = openGroups[group.key];
                        return (
                          <div key={group.key}>
                            <button
                              type="button"
                              className="dsh-swarm-group-toggle"
                              onClick={() =>
                                setOpenGroups((prev) => ({ ...prev, [group.key]: !prev[group.key] }))
                              }
                            >
                              <span className={`dsh-swarm-group-arrow ${isOpen ? "open" : ""}`}>▶</span>
                              {tr("group.count", { label: tr(group.label), count: members.length })}
                            </button>
                            {isOpen && members.map(renderRow)}
                          </div>
                        );
                      })}
                    </>
                  );
                })()}
              </div>
            </>
          ) : (
            <div className="dsh-swarm-empty">
              {tr("empty")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
