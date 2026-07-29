/** Minimal line diff (LCS-based) for the workspace Diff tab. */

export interface DiffLine {
  type: "context" | "add" | "del";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export function computeLineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");

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
