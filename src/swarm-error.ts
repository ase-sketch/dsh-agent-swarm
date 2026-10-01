/**
 * dsh-agent-swarm — 结构化校验错误 → 可抛出的 Error（纯函数，零 DSH 依赖）
 *
 * 纯函数层（validate.ts）永不抛异常，只返回 {@link SwarmValidationError}；
 * 宿主层在「启动任何子代理之前」把它抛出去，工具调用即失败（DSH 约定：execute 抛错 = 工具失败）。
 * 本文件是"结构化错误如何变成 Error"的唯一出口，宿主层所有拒绝路径都经它抛出。
 *
 * ── 为什么 code 与 details 必须写进 message ──
 *
 * DSH 把 execute 抛出的异常转成工具结果时，模型看得到的**只有** `Error: ${message}`
 * （@deepseek-ai/dsh-tools 的 toolErrorResult；附带的 info 只在 HarnessError 时含 {name, code}，
 * 且 info 本身也不进模型上下文）。挂在 Error 上的自定义字段对模型完全不可见——
 * 于是 MODEL_AMBIGUOUS 的候选、MODEL_NOT_ALLOWED 的白名单、DUPLICATE_PROMPTS 的碰撞片段
 * 这些专为"让模型自纠"准备的信息，此前一个字都到不了模型。
 * 因此 message 统一渲染为：`[CODE] 人可读说明` + 换行 + `Details: <紧凑 JSON>`（有 details 时）。
 * 自定义字段仍然保留，供日志与测试按 code 判定。
 */

import type { SwarmErrorCode, SwarmValidationError } from "./types.js";

/** 抛出的错误对象带回的机器可读字段（日志与测试按 code 判定用）。 */
export interface SwarmErrorFields {
  swarmErrorCode: SwarmErrorCode;
  swarmErrorDetails?: Record<string, unknown>;
}

export type ThrownSwarmError = Error & SwarmErrorFields;

/** 抛出错误的 name；测试与日志据此区分"校验拒绝"与"运行期故障"。 */
export const SWARM_ERROR_NAME = "SwarmValidationError";

/**
 * Details 段（JSON）的最大码元数，超出即截断并注明原长。
 *
 * validate.ts 已对各自回显的模型文本封顶（单段 120 码元、路由清单 20 条），正常 details 远小于此；
 * 这一层是总量兜底：哪怕将来某个 details 忘了封顶，也不会用一条报错挤爆模型上下文。
 */
export const ERROR_DETAILS_MAX_CHARS = 1200;

/** 模型可见的报错文本：`[CODE] message`，有 details 时另起一行附紧凑 JSON（总长封顶）。 */
export function formatSwarmErrorMessage(error: SwarmValidationError): string {
  const head = `[${error.code}] ${error.message}`;
  if (error.details === undefined) return head;
  let json: string;
  try {
    json = JSON.stringify(error.details);
  } catch {
    // 不可序列化（循环引用、BigInt）：宁可少给 details，也不让报错本身变成另一个异常。
    return head;
  }
  if (json.length > ERROR_DETAILS_MAX_CHARS) {
    json = `${json.slice(0, ERROR_DETAILS_MAX_CHARS)}…(truncated, ${String(json.length)} chars total)`;
  }
  return `${head}\nDetails: ${json}`;
}

/**
 * 把结构化校验错误包装成可抛出的 Error：
 * message = {@link formatSwarmErrorMessage}（模型唯一看得到的部分）；
 * name = "SwarmValidationError"、swarmErrorCode、swarmErrorDetails（有则带，供日志与测试）。
 */
export function toThrownSwarmError(error: SwarmValidationError): ThrownSwarmError {
  const wrapped = new Error(formatSwarmErrorMessage(error)) as ThrownSwarmError;
  wrapped.name = SWARM_ERROR_NAME;
  wrapped.swarmErrorCode = error.code;
  if (error.details !== undefined) wrapped.swarmErrorDetails = error.details;
  return wrapped;
}
