import { formatDuration, runTimeline, type AutomationRun, type TimelineRow } from "@deyin/host-core";

/**
 * How a stored run reads to the agent that is debugging it. The creating agent
 * once judged a run that had posted to X "stuck" because all it could see was a
 * 200-character tail of the final text; these are the facts it needed.
 */

/** "2026-09-02T14:03:00Z"-style stamp for run listings. */
export function stamp(ms?: number): string {
  return ms ? new Date(ms).toISOString() : "—";
}

const MAX_TIMELINE_ROWS = 70;
const HEAD_ROWS = 20;
const FINAL_TEXT_CHARS = 3_000;

function statusWord(run: AutomationRun): string {
  return run.outcome ? `${run.status}/${run.outcome}` : run.status;
}

/** One line per run: enough to tell runs apart and spot a failure. */
export function describeRunLine(run: AutomationRun): string {
  const how = run.reason ? `, reason: ${run.reason}` : run.finalText ? `, output: ${run.finalText.trim().slice(0, 200)}` : "";
  return `${run.id} — ${statusWord(run)}, started ${stamp(run.startedAt)}, finished ${stamp(run.finishedAt)}${how}`;
}

function timelineLine(row: TimelineRow, index: number): string {
  const state = row.state === "ok" ? "ok" : row.state === "pending" ? "no result" : row.state.toUpperCase();
  const about = row.summary ? ` ${row.summary}` : "";
  const why = row.detail ? ` — ${row.detail}` : "";
  return `  ${index + 1}. ${row.tool} [${state}]${about}${why}`;
}

/** Long timelines keep their start and end, where setup and the final failure are. */
function timelineLines(rows: TimelineRow[]): string[] {
  if (rows.length <= MAX_TIMELINE_ROWS) return rows.map(timelineLine);
  const tail = MAX_TIMELINE_ROWS - HEAD_ROWS;
  const skipped = rows.length - HEAD_ROWS - tail;
  return [
    ...rows.slice(0, HEAD_ROWS).map(timelineLine),
    `  … ${skipped} more calls …`,
    ...rows.slice(-tail).map((row, i) => timelineLine(row, rows.length - tail + i)),
  ];
}

/** Everything recorded about one run. */
export function describeRunDetail(run: AutomationRun): string {
  const lines: string[] = [];
  const took = run.summary?.durationMs ?? (run.finishedAt !== undefined ? run.finishedAt - run.startedAt : undefined);
  lines.push(`Run ${run.id} — ${statusWord(run)}, started ${stamp(run.startedAt)}, finished ${stamp(run.finishedAt)}${took !== undefined ? ` (${formatDuration(took)})` : ""}`);
  if (run.reason) lines.push(`Reason: ${run.reason}`);
  if (run.blocker) lines.push(`Blocker: ${run.blocker.kind} — ${run.blocker.detail}`);
  if (run.artifacts?.length) lines.push(`Produced: ${run.artifacts.join(", ")}`);

  const summary = run.summary;
  if (summary && summary.steps > 0) {
    const perTool = Object.entries(summary.toolCalls)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name}×${n}`)
      .join(", ");
    lines.push(`Tool calls: ${summary.steps}${summary.toolErrors ? ` (${summary.toolErrors} failed)` : ""}: ${perTool}`);
  } else if (!summary) {
    lines.push("Tool calls: not counted (recorded before run summaries existed).");
  } else {
    lines.push("Tool calls: none.");
  }
  if (summary?.lastError) lines.push(`Last error: ${summary.lastError}`);

  const rows = runTimeline(run.events);
  if (rows.length > 0) {
    lines.push("Timeline:", ...timelineLines(rows));
  }
  const errors = run.events.filter((e) => e.type === "error");
  for (const event of errors) if (event.type === "error") lines.push(`Run error: ${event.message}`);

  const text = (run.finalText ?? "").trim();
  if (text) lines.push("Final output:", text.length > FINAL_TEXT_CHARS ? `${text.slice(0, FINAL_TEXT_CHARS)}… (truncated)` : text);
  else if (run.status !== "running" && run.status !== "queued") lines.push("Final output: none.");
  return lines.join("\n");
}
