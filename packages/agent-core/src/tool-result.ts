/**
 * Bounding what a tool result costs on the wire.
 *
 * Two mechanisms, both applied in `toolResult` as the message is appended:
 *
 *  - **Deduplication.** Re-reading a file the model already read returns the
 *    same bytes at full token price, and nothing tells the model it already has
 *    them. Fingerprinting every raw result and replacing repeats with a pointer
 *    both shrinks the wire copy and teaches the model that re-reading is not
 *    free. The full text stays in the session log and the UI.
 *
 *  - **Head/tail snipping.** A single `slice(0, cap)` throws away the end of the
 *    output, which for a build or a test run is exactly where the failure is.
 *    Keeping both ends with a marker between them costs the same tokens and
 *    keeps the useful part.
 */

import { createHash } from "crypto";

/** How much of each end of an oversized result to keep, per tool. */
export interface SnipHint {
  headChars: number;
  tailChars: number;
}

/**
 * Absolute ceiling on one provider-visible tool result, whatever the hint says.
 * A single result larger than this crowds out the rest of the transcript.
 */
export const HARD_TOOL_RESULT_CAP = 50_000;

/**
 * Failure output is dense and rarely re-derivable, so a result that looks like
 * one keeps at least this share of its budget as tail.
 */
const FAILURE_TAIL_SHARE = 1 / 3;

const FAILURE_RE = /\b(error|panic|fatal|exception|traceback|assertion failed)\b[:\s]/i;

/**
 * Default hints by tool. Reads are front-loaded (the top of a file is its
 * imports and signatures); command output is not (the command echoes at the
 * head, the failure lands at the tail); listings are almost pure head.
 */
const DEFAULT_HINTS: Record<string, SnipHint> = {
  read: { headChars: 12_000, tailChars: 2_000 },
  web_fetch: { headChars: 12_000, tailChars: 2_000 },
  bash: { headChars: 8_000, tailChars: 8_000 },
  grep: { headChars: 10_000, tailChars: 1_000 },
  glob: { headChars: 10_000, tailChars: 1_000 },
  ls: { headChars: 10_000, tailChars: 1_000 },
  file_tree: { headChars: 10_000, tailChars: 1_000 },
};

/** Anything unrecognised keeps both ends equally — we cannot guess the shape. */
const FALLBACK_HINT: SnipHint = { headChars: 8_000, tailChars: 8_000 };

export function snipHintFor(toolName: string, override?: SnipHint): SnipHint {
  if (override) return override;
  const exact = DEFAULT_HINTS[toolName];
  if (exact) return exact;
  // MCP tools arrive as `mcp__<server>__<tool>`; treat them as command output.
  return FALLBACK_HINT;
}

/**
 * Cut an oversized result down to head + marker + tail.
 *
 * The marker names the `tool_call_id` so the model can page the full result back
 * with `read_session_context` instead of re-running the tool.
 */
export function snipToolResult(
  content: string,
  toolName: string,
  toolCallId: string,
  override?: SnipHint,
): string {
  if (content.length <= HARD_TOOL_RESULT_CAP) return content;

  const hint = snipHintFor(toolName, override);
  let head = hint.headChars;
  let tail = hint.tailChars;

  // Bias toward the tail when the body reads like a failure: the stack trace and
  // the summary line are both at the end.
  if (FAILURE_RE.test(content)) {
    tail = Math.max(tail, Math.floor(HARD_TOOL_RESULT_CAP * FAILURE_TAIL_SHARE));
  }

  // Scale the hint down if it does not fit the hard cap, leaving room for the
  // marker itself.
  const marker = snipMarker(toolName, toolCallId, content.length, head + tail);
  const budget = HARD_TOOL_RESULT_CAP - marker.length;
  if (head + tail > budget) {
    const scale = budget / (head + tail);
    head = Math.max(512, Math.floor(head * scale));
    tail = Math.max(512, budget - head);
  }

  const realMarker = snipMarker(toolName, toolCallId, content.length, head + tail);
  return content.slice(0, head) + realMarker + content.slice(content.length - tail);
}

function snipMarker(toolName: string, toolCallId: string, total: number, kept: number): string {
  const dropped = Math.max(0, total - kept);
  return (
    `\n\n… [${toolName} output snipped: ${dropped} of ${total} characters removed from the middle. ` +
    `Both ends are shown. Re-read the source with a narrower range, or page the full result with ` +
    `read_session_context (tool_call_id=${toolCallId}), if you need what is missing.] …\n\n`
  );
}

/**
 * Per-run store of result fingerprints, so an identical result is sent once.
 *
 * Keyed on the raw pre-snip content: two calls that produced the same bytes are
 * the same result even if one of them would have been snipped differently.
 */
export class ResultDeduper {
  private readonly seen = new Map<string, string>();
  private elided = 0;

  /** How many results this run replaced with a pointer. */
  get elidedCount(): number {
    return this.elided;
  }

  /**
   * Returns the pointer text when this exact result has already been sent under
   * a different call id, or null when it is new.
   */
  check(raw: string, toolCallId: string): string | null {
    // Short results are not worth a pointer — the pointer costs about as much.
    if (raw.length < 512) return null;
    const fingerprint = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);
    const previous = this.seen.get(fingerprint);
    if (previous === undefined) {
      this.seen.set(fingerprint, toolCallId);
      return null;
    }
    if (previous === toolCallId) return null;
    this.elided += 1;
    return (
      `[duplicate tool result omitted — byte-for-byte identical to the result of tool_call_id=${previous}, ` +
      `which is already in this conversation. Scroll up rather than re-running this call.]`
    );
  }
}
