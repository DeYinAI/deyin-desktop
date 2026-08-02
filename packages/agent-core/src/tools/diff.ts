import type { ToolDefinition } from "../types.js";
import { asOptionalNumber, asString, truncate } from "./util.js";

const MAX_DIFF_LINES = 200;
/** Max lines each side may feed the LCS DP (prevents O(n·m) memory blowups). */
const MAX_INPUT_LINES = 2_000;

/** Classic O(nm) LCS over lines. Small inputs (diffs are bounded) — fine. */
export function lcsDiff(
  left: string,
  right: string,
): Array<{ type: "context" | "add" | "del"; text: string }> {
  // Cap the DP inputs: two ~20k-line model-supplied blocks would otherwise
  // allocate a ~3 GB matrix and OOM the host process.
  const a = left.split("\n").slice(0, MAX_INPUT_LINES);
  const b = right.split("\n").slice(0, MAX_INPUT_LINES);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: Array<{ type: "context" | "add" | "del"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "context", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "del", text: a[i]! });
      i++;
    } else {
      out.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++]! });
  while (j < m) out.push({ type: "add", text: b[j++]! });
  return out;
}

function render(diff: Array<{ type: "context" | "add" | "del"; text: string }>, cap: number): string {
  const hasChanges = diff.some((l) => l.type !== "context");
  if (!hasChanges) return "(no differences)";
  const lines: string[] = [];
  for (const line of diff) {
    if (lines.length >= cap) {
      lines.push(`... (${diff.length - lines.length} more diff lines)`);
      break;
    }
    if (line.type === "context") lines.push(`  ${line.text}`);
    else if (line.type === "add") lines.push(`+ ${line.text}`);
    else lines.push(`- ${line.text}`);
  }
  return lines.length > 0 ? lines.join("\n") : "(no differences)";
}

/**
 * Line-level LCS diff between two literal texts. Useful when the model wants
 * to preview an edit (old vs new content) before writing it, or to understand
 * what changed between two tool results.
 */
export const diffTextTool: ToolDefinition = {
  name: "diff_text",
  description:
    'Line-level diff of two text blocks (left = before, right = after) using LCS. Prefixes: "  " unchanged, "+ " added, "- " removed. Use to preview an edit before writing it.',
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      left: { type: "string", description: "The original text." },
      right: { type: "string", description: "The new text." },
      max_lines: { type: "number", description: "Cap on diff output lines (default 200)." },
    },
    required: ["left", "right"],
  },
  summarize: (args) => `${String(args.left ?? "").length} → ${String(args.right ?? "").length} chars`,
  async execute(args): Promise<string> {
    const left = asString(args.left, "left");
    const right = asString(args.right, "right");
    const cap = Math.min(Math.max(asOptionalNumber(args.max_lines) ?? MAX_DIFF_LINES, 10), 1000);
    const inputTruncated =
      left.split("\n").length > MAX_INPUT_LINES || right.split("\n").length > MAX_INPUT_LINES;
    const rendered = render(lcsDiff(left, right), cap);
    return truncate(
      inputTruncated ? `${rendered}\n... (input truncated to ${MAX_INPUT_LINES} lines per side)` : rendered,
      30_000,
    );
  },
};
