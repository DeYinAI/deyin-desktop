/** Minimal line diff (LCS-based) for the workspace Diff tab. */

export interface DiffLine {
  type: "context" | "add" | "del";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

/**
 * Lines of a file's text. An empty string is an empty file — zero lines — not
 * one blank line: `"".split("\n")` returns [""], which made a brand-new file
 * report a deletion of blank line 1, drawn as a stray red row in the unified
 * view and a lone "1" in an otherwise empty OLD pane in the split view.
 */
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

export function computeLineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  // LCS table (fine for the file sizes a preview handles).
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "context", text: a[i]!, oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ type: "del", text: a[i]!, oldNo: i + 1, newNo: null });
      i++;
    } else {
      out.push({ type: "add", text: b[j]!, oldNo: null, newNo: j + 1 });
      j++;
    }
  }
  while (i < m) {
    out.push({ type: "del", text: a[i]!, oldNo: i + 1, newNo: null });
    i++;
  }
  while (j < n) {
    out.push({ type: "add", text: b[j]!, oldNo: null, newNo: j + 1 });
    j++;
  }
  return out;
}

export interface FileDiff {
  fileName: string;
  before: string;
  after: string;
}

export type SideBySideCellType = "context" | "add" | "del" | "empty";

/** One half of a side-by-side row: a real line, or an empty filler. */
export interface SideBySideCell {
  type: SideBySideCellType;
  text: string;
  /** Line number in that side's file; null for filler cells. */
  no: number | null;
}

export interface SideBySideRow {
  /** Old file (before). */
  left: SideBySideCell;
  /** New file (after). */
  right: SideBySideCell;
}

/**
 * Pairs a line diff into side-by-side rows: old file on the left, new file on
 * the right. `computeLineDiff` walks deletions before additions within each
 * changed block, so dels/adds are collected then zipped line-for-line; the
 * shorter side gets empty filler cells so rows stay level.
 */
export function computeSideBySideDiff(before: string, after: string): SideBySideRow[] {
  const lines = computeLineDiff(before, after);
  const rows: SideBySideRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.type === "context") {
      rows.push({
        left: { type: "context", text: line.text, no: line.oldNo },
        right: { type: "context", text: line.text, no: line.newNo },
      });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.type === "del") dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.type === "add") adds.push(lines[i++]!);
    const count = Math.max(dels.length, adds.length);
    for (let k = 0; k < count; k++) {
      const del = dels[k];
      const add = adds[k];
      rows.push({
        left: del ? { type: "del", text: del.text, no: del.oldNo } : { type: "empty", text: "", no: null },
        right: add ? { type: "add", text: add.text, no: add.newNo } : { type: "empty", text: "", no: null },
      });
    }
  }
  return rows;
}

/** Above this size we skip diff rendering (LCS is quadratic) but keep the card. */
const DIFF_MAX_LINES = 2000;

/** Adds/dels counts for a file card; falls back to a cheap estimate on big files. */
export function diffStats(before: string, after: string): { adds: number; dels: number; renderable: boolean } {
  if (before === "" && after === "") return { adds: 0, dels: 0, renderable: false };
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of b) {
      const left = counts.get(line) ?? 0;
      if (left > 0) {
        common += 1;
        counts.set(line, left - 1);
      }
    }
    return { adds: b.length - common, dels: a.length - common, renderable: false };
  }
  let adds = 0;
  let dels = 0;
  for (const line of computeLineDiff(before, after)) {
    if (line.type === "add") adds += 1;
    else if (line.type === "del") dels += 1;
  }
  return { adds, dels, renderable: true };
}

/** Context lines kept around each changed hunk in a chat-card snippet. */
const SNIPPET_CONTEXT = 2;
/** Total line cap for a chat-card snippet; the rest is summarized as "more". */
const SNIPPET_MAX_LINES = 40;

export interface DiffSnippet {
  lines: DiffLine[];
  /** Changed (add/del) lines that did not fit under the cap. */
  more: number;
}

/**
 * Compact excerpt of a line diff for the chat file card: changed hunks with a
 * couple of context lines each, capped in total length (Cursor-style snippet).
 */
export function diffSnippet(before: string, after: string): DiffSnippet {
  const all = computeLineDiff(before, after);

  // Mark lines to keep: every change plus SNIPPET_CONTEXT lines around it.
  const keep = new Array<boolean>(all.length).fill(false);
  for (let i = 0; i < all.length; i++) {
    if (all[i]!.type === "context") continue;
    for (let j = Math.max(0, i - SNIPPET_CONTEXT); j <= Math.min(all.length - 1, i + SNIPPET_CONTEXT); j++) {
      keep[j] = true;
    }
  }

  const lines: DiffLine[] = [];
  let more = 0;
  for (let i = 0; i < all.length; i++) {
    if (!keep[i]) continue;
    if (lines.length < SNIPPET_MAX_LINES) {
      lines.push(all[i]!);
    } else if (all[i]!.type !== "context") {
      more += 1;
    }
  }
  return { lines, more };
}
