/** 测试辅助：截断结果的完整性判定（不劈开代理对、不切碎 JSON 转义）。 */

/** 是否含孤立代理（TS 的 ES2022 lib 没有 String#isWellFormed，这里用正则等价判断）。 */
export function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/** JSON 文本的末尾是否残留半个转义序列（悬空的反斜杠或不足 4 位的 \u）。 */
export function endsInsideJsonEscape(text: string): boolean {
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "\\") {
      index += 1;
      continue;
    }
    const length = text[index + 1] === "u" ? 6 : 2;
    if (index + length > text.length) return true;
    index += length;
  }
  return false;
}
