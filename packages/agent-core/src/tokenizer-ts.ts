/**
 * Pure-TS token estimation fallback (no native dependency).
 */

const DEFAULT_CHARS_PER_TOKEN = 4;

export function countTokensTs(text: string): number {
  if (!text) return 0;
  const pieces = text
    .replace(/(\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul})/gu, " $1 ")
    .split(/(\s+|[,.:;!?()[\]{}"'`])/u)
    .filter((p) => p.length > 0 && !/^\s+$/.test(p));

  let tokens = 0;
  for (const piece of pieces) {
    if (piece.length <= 1) {
      tokens += 1;
    } else if (/^[a-zA-Z0-9_]+$/.test(piece)) {
      tokens += Math.max(1, Math.ceil(piece.length / DEFAULT_CHARS_PER_TOKEN));
    } else if (/^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+$/u.test(piece)) {
      tokens += piece.length;
    } else {
      tokens += Math.max(1, Math.ceil(piece.length / 3));
    }
  }
  return tokens;
}

export function truncateToTokensTs(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (countTokensTs(text) <= maxTokens) return text;

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (countTokensTs(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}
