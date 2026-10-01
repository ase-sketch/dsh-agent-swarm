/**
 * dsh-agent-swarm — 面板字典（中英双语，键集合必须一致）
 *
 * 接线方式与官方 jobs 面板一致：槽位注册时声明 `locale: SWARM_LOCALE_NAMESPACE`，
 * 框架据此把绑定到该命名空间的 `t` 注入给槽位组件（`t(key, params)`，占位符写作 `{name}`）。
 * 组件拿不到 `t` 时（旧宿主、单测）回落到 {@link fallbackTranslate}（中文字典）——
 * 即接线前的显示效果，不会因为缺 `t` 而显示键名。
 */

/** 本插件的字典命名空间（slot 选项的 `locale` 与 `ctx.locale.register` 共用）。 */
export const SWARM_LOCALE_NAMESPACE = "agentSwarm";

/** 简体中文（键集合的权威来源）。 */
export const zh = {
  "title": "Swarm 智能体队列",
  "trigger.label": "Swarm",
  "stream.error": "流连接中断：{message}",
  "header.members": "{count} 个成员",
  "header.descFallback": "会话级并发调度监控",
  "header.route": "模型: {route}",
  "empty": "当前会话暂无运行中的 Swarm 任务",
  "stats.running": "运行中",
  "stats.completed": "已完成",
  "stats.failed": "失败",
  "stats.aborted": "取消",
  "phase.pending": "等待中",
  "phase.starting": "启动中",
  "phase.running": "执行中",
  "phase.retrying": "限流退避",
  "phase.completed": "已完成",
  "phase.failed": "失败",
  "phase.aborted": "取消",
  "group.active": "进行中",
  "group.failed": "失败",
  "group.completed": "已完成",
  "group.aborted": "已取消",
  "group.count": "{label} {count} 个成员",
  "retry.line": "第 {count} 次限流重试",
  "retry.eta": " · 约 {seconds} 秒后发起",
  "item.truncated": "{item}（原文 {count} 字符）",
} as const;

export type SwarmLocaleKey = keyof typeof zh;

/** English. */
export const en: Record<SwarmLocaleKey, string> = {
  "title": "Swarm Agent Queue",
  "trigger.label": "Swarm",
  "stream.error": "Stream disconnected: {message}",
  "header.members": "{count} members",
  "header.descFallback": "Session-level parallel dispatch monitor",
  "header.route": "Model: {route}",
  "empty": "No Swarm tasks in the current session",
  "stats.running": "Running",
  "stats.completed": "Completed",
  "stats.failed": "Failed",
  "stats.aborted": "Cancelled",
  "phase.pending": "Pending",
  "phase.starting": "Starting",
  "phase.running": "Running",
  "phase.retrying": "Rate-limited",
  "phase.completed": "Completed",
  "phase.failed": "Failed",
  "phase.aborted": "Cancelled",
  "group.active": "In progress",
  "group.failed": "Failed",
  "group.completed": "Completed",
  "group.aborted": "Cancelled",
  "group.count": "{label} · {count} members",
  "retry.line": "Rate-limit retry #{count}",
  "retry.eta": " · retrying in ~{seconds}s",
  "item.truncated": "{item} ({count} chars in full)",
};

/** 槽位注册用的完整字典表（每个内置语言一份）。 */
export const SWARM_DICTIONARIES: Record<"zh" | "en", Record<SwarmLocaleKey, string>> = { zh, en };

/** 框架注入的翻译函数形状（与 DSH Translate 兼容的最小子集）。 */
export type SwarmTranslate = (key: SwarmLocaleKey, params?: Record<string, string | number>) => string;

/** 以 `{name}` 占位符做插值；未提供的占位符原样保留（便于发现漏传）。 */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/** 由一份字典构造翻译函数（回落与测试用）。 */
export function translatorFor(dict: Record<SwarmLocaleKey, string>): SwarmTranslate {
  return (key, params) => interpolate(dict[key] ?? key, params);
}

/** 缺省翻译：中文字典（框架没注入 `t` 时使用）。 */
export const fallbackTranslate: SwarmTranslate = translatorFor(zh);
