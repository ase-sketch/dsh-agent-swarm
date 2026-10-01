/**
 * dsh-agent-swarm — 结构化校验错误 → 可抛出的 Error（纯函数，零 DSH 依赖）
 *
 * 纯函数层（validate.ts）永不抛异常，只返回 {@link SwarmValidationError}；
 * 宿主层在「启动任何子代理之前」把它抛出去，工具调用即失败（DSH 约定：execute 抛错 = 工具失败）。
 * 本文件是"结构化错误如何变成 Error"的唯一出口，宿主层所有拒绝路径都经它抛出。
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
 * 把结构化校验错误包装成可抛出的 Error：
 * name = "SwarmValidationError"、swarmErrorCode、swarmErrorDetails（有则带）。
 */
export function toThrownSwarmError(error: SwarmValidationError): ThrownSwarmError {
  const wrapped = new Error(error.message) as ThrownSwarmError;
  wrapped.name = SWARM_ERROR_NAME;
  wrapped.swarmErrorCode = error.code;
  if (error.details !== undefined) wrapped.swarmErrorDetails = error.details;
  return wrapped;
}
