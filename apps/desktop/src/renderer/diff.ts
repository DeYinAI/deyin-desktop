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
