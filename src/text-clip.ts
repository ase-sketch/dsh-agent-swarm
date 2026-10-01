/**
 * dsh-agent-swarm — 文本截断（纯函数，零 DSH 依赖）
 *
 * 全仓所有"把模型给的文本截成摘要"的地方都走这里（报错回显、Details JSON、子代理 label、面板视图）。
 *
 * 为什么不能直接 `.slice(0, n)`：JS 字符串按 UTF-16 码元计长，BMP 之外的字符（emoji、部分 CJK 扩展字）
 * 由一对代理码元组成。截断点恰好落在一对中间时，会留下一个孤立的高代理（0xD800–0xDBFF），
 * 显示成乱码 ``，经 UTF-8 编码后还可能被替换或拒收。这里保证截断点永远不劈开代理对。
 * 长度口径仍是 UTF-16 码元（与各处上限常量的单位一致），只是必要时少截一个码元。
 */

/** 是否高代理码元（代理对的前半）。 */
function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

/**
 * 取前 max 个码元，但不劈开代理对：若第 max 个码元（截断后的最后一个）是高代理，就少截一个。
 * 未超长时原样返回。
 */
export function sliceCodeUnitsSafely(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  const end = isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

/** 超过 max 码元时安全截断并补省略号；未超长时原样返回（不加标记）。 */
export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${sliceCodeUnitsSafely(text, max)}…`;
}

/**
 * 截断 `JSON.stringify` 的输出：除了不劈开代理对，还不切碎转义序列
 * （`\"`、`\`、`\n`、`\uXXXX` 等）——半个转义会留下悬空的反斜杠或残缺的 `\u00`。
 *
 * 做法：先按码元安全截断，再从头扫描转义序列（JSON.stringify 的输出里，反斜杠只会出现在
 * 字符串内且必然是转义起点，所以从头顺序消费即可正确处理 `\` 这类成对出现的情形），
 * 若最后一个转义序列被截断，就把截断点前移到它的起点。只返回截下的部分，不加标记。
 */
export function sliceJsonTextSafely(json: string, max: number): string {
  const sliced = sliceCodeUnitsSafely(json, max);
  if (sliced.length === json.length) return sliced;
  let index = 0;
  while (index < sliced.length) {
    if (sliced[index] !== "\\") {
      index += 1;
      continue;
    }
    const escapeLength = sliced[index + 1] === "u" ? 6 : 2;
    if (index + escapeLength > sliced.length) return sliced.slice(0, index);
    index += escapeLength;
  }
  return sliced;
}
