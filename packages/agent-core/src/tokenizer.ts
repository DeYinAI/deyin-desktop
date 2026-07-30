/**
 * Fast local token estimation and truncation.
 * Uses a cl100k-style heuristic (punctuation-aware) without shipping a vocab blob.
 * Good enough for compaction budgets and compression metrics; not a billing oracle.
 */

const DEFAULT_CHARS_PER_TOKEN = 4;

/** Approximate token count for Latin/CJK-mixed text. */
export function countTokens(text: string): number {
  if (!text) return 0;
  // Split on whitespace and common punctuation boundaries similar to BPE pre-tokenization.
  const pieces = text
    .replace(/(\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul})/gu, " $1 ")
    .split(/(\s+|[,.:;!?()[\]{}"'`])/u)
    .filter((p) => p.length > 0 && !/^\s+$/.test(p));

  let tokens = 0;
  for (const piece of pieces) {
    if (piece.length <= 1) {
      tokens += 1;
    } else if (/^[a-zA-Z0-9_]+$/.test(piece)) {
      // Subword-ish: ~1 token per 4 chars for identifiers.
      tokens += Math.max(1, Math.ceil(piece.length / DEFAULT_CHARS_PER_TOKEN));
    } else if (/^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+$/u.test(piece)) {
      tokens += piece.length; // CJK ~1 char/token
    } else {
      tokens += Math.max(1, Math.ceil(piece.length / 3));
    }
  }
  return tokens;
}

export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (countTokens(text) <= maxTokens) return text;

  // Binary search on character length — faster than tokenizing repeatedly from scratch for huge blobs.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (countTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

export class Tokenizer {
  count(text: string): number {
    return countTokens(text);
  }

  truncate(text: string, maxTokens: number): string {
    return truncateToTokens(text, maxTokens);
  }

  /** Rough encode: returns synthetic token ids (hashes) for tests / debugging. */
  encode(text: string): number[] {
    const pieces = text.split(/(\s+)/).filter(Boolean);
    return pieces.map((p) => {
      let h = 2166136261;
      for (let i = 0; i < p.length; i++) {
        h ^= p.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    });
  }

  decode(tokens: number[]): string {
    return tokens.map((t) => `#${t.toString(16)}`).join(" ");
  }
}

const DEFAULT = new Tokenizer();

export function getTokenizerForModel(_model?: string): Tokenizer {
  // Providers share similar BPE granularity for budgeting; specialize later if needed.
  return DEFAULT;
}

export function estimateMessageTokens(
  messages: { content: string; role?: string; toolCalls?: { name: string; arguments: string }[] }[],
): number {
  let total = 0;
  for (const m of messages) {
    total += countTokens(m.content) + 4; // role/framing overhead
    if (m.toolCalls) {
      for (const c of m.toolCalls) total += countTokens(c.name) + countTokens(c.arguments) + 4;
    }
  }
  return total;
}
