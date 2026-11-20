import type { AgentUiEvent } from "./types.js";

/**
 * Reading a stored run back: the tool calls in order, and how long it took.
 * Browser-safe and shared, so the Automations view and the agent's own
 * `automation_runs` tool describe a run in exactly the same terms.
 */

/** One tool call in a run, paired up from its start and end events. */
export interface TimelineRow {
  id: string;
  tool: string;
  /** What the call was about ("click ref e12"); empty when the run did not say. */
  summary: string;
  /** `pending` means the run ended (or the history was trimmed) before a result arrived. */
  state: "ok" | "error" | "denied" | "pending";
  /** The failure text for a failed call; empty for a call that worked. */
  detail: string;
}

const SUMMARY_CHARS = 90;
const DETAIL_CHARS = 200;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The tool calls of a run, in order. A result whose start was trimmed away still gets a row. */
export function runTimeline(events: readonly AgentUiEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const byCall = new Map<string, TimelineRow>();
  for (const event of events) {
    if (event.type === "tool-start") {
      const row: TimelineRow = { id: event.callId, tool: event.name, summary: clip(event.summary, SUMMARY_CHARS), state: "pending", detail: "" };
      byCall.set(event.callId, row);
      rows.push(row);
    } else if (event.type === "tool-end") {
      let row = byCall.get(event.callId);
      if (!row) {
        row = { id: event.callId, tool: event.name, summary: "", state: "pending", detail: "" };
        byCall.set(event.callId, row);
        rows.push(row);
      }
      row.state = event.denied ? "denied" : event.ok ? "ok" : "error";
      row.detail = event.ok ? "" : clip(event.result, DETAIL_CHARS);
    }
  }
  return rows;
}

/** "45s", "3m 20s", "1h 5m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
