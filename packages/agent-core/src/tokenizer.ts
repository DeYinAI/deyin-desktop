/**
 * Fast local token estimation and truncation.
 * Uses native @deyin/native-core when available; otherwise tokenizer-ts fallback.
 */
import { fastCountTokens, fastTruncateToTokens } from "./native.js";
export { countTokensTs, truncateToTokensTs } from "./tokenizer-ts.js";

export function countTokens(text: string): number {
  return fastCountTokens(text);
}

export function truncateToTokens(text: string, maxTokens: number): string {
  return fastTruncateToTokens(text, maxTokens);
}

export class Tokenizer {
  count(text: string): number {
    return countTokens(text);
  }

  truncate(text: string, maxTokens: number): string {
    return truncateToTokens(text, maxTokens);
  }

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
  return DEFAULT;
}

export function estimateMessageTokens(
  messages: { content: string; role?: string; toolCalls?: { name: string; arguments: string }[] }[],
): number {
  let total = 0;
  for (const m of messages) {
    total += countTokens(m.content) + 4;
    if (m.toolCalls) {
      for (const c of m.toolCalls) total += countTokens(c.name) + countTokens(c.arguments) + 4;
    }
  }
  return total;
}
