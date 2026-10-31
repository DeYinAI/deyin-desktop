import { createHash } from "node:crypto";

/** Stable id from its inputs: equal inputs give equal ids. */
export function key(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}:${part}`);
  return hash.digest("hex").slice(0, 16);
}

/** Maximum words of a human-facing message and of a routing note. */
export const IM_WORDS = 100;
export const NOTE_WORDS = 30;

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
/** Word-like segments across Chinese, English and mixed text, ignoring punctuation. */
export function wordCount(text: string): number {
  let count = 0;
  for (const segment of segmenter.segment(text)) if (segment.isWordLike) count++;
  return count;
}

export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Collapses whitespace and truncates for display previews. */
export const preview = (text: string, max = 160): string => text.replace(/\s+/g, " ").slice(0, max);

/** Fill `{name}` placeholders in one pass, so filled text is not read for placeholders again. */
export const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(values, name) ? values[name]! : match));

/** Slices text by UTF-16 code units so concatenated pages reconstruct the exact string. */
export function textPage(resource: string, text: string, offset: number, limit: number) {
  const end = Math.min(text.length, offset + limit);
  return { resource, offset, total_chars: text.length, next_offset: end < text.length ? end : null, text: text.slice(offset, end) };
}
