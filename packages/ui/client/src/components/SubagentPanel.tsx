import { useEffect, useRef } from "react";
import { themeByName } from "../code.js";
import { Markdown } from "./Markdown.js";
import type { CodeDisplaySettings } from "./panelTypes.js";
import type { ThreadEvent } from "@deyin/contract";

export type SubagentEvent = Extract<ThreadEvent, { kind: "subagent" }>;

/** "security-review" → "Security Review"; keeps already-spaced names intact. */
export function subagentDisplayName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Card/panel status tail: the live activity line, or a terminal summary. */
export function subagentStatusLine(event: SubagentEvent): string {
  if (event.status === "running") return event.line ?? "Starting up";
  if (event.status === "failed") return event.line ?? "Failed";
  return event.line ?? "Completed";
}

interface SubagentPanelProps {
  active: boolean;
  /** Every subagent run in the current thread, oldest first. */
  runs: SubagentEvent[];
  /** Which run the panel is showing; falls back to the newest. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  codeDisplay: CodeDisplaySettings;
  threadId?: string | null;
}

/**
 * Workspace "Agent" tab: the live transcript of one subagent run — its
 * delegation prompt, the activity log as it works, and the report it returns.
 * Clicking a subagent card in chat opens this tab on that run.
 */
export function SubagentPanel(props: SubagentPanelProps) {
  const selected = props.runs.find((r) => r.id === props.selectedId) ?? props.runs[props.runs.length - 1] ?? null;

  if (!selected) {
    return (
      <div className="wspanel__body wspanel__empty">
        No subagent has run in this chat yet. When the agent delegates work, click its subagent in the chat to follow
        along here.
      </div>
    );
  }

  return (
    <div className="subpanel">
      {props.runs.length > 1 && (
        <div className="subpanel__switcher">
          {props.runs.map((run) => (
            <button
              key={run.id}
              className={`subpanel__chip ${run.id === selected.id ? "subpanel__chip--active" : ""} subpanel__chip--${run.status}`}
              onClick={() => props.onSelect(run.id)}
              title={subagentDisplayName(run.name)}
            >
              <StatusDot status={run.status} />
              {subagentDisplayName(run.name)}
            </button>
          ))}
        </div>
      )}

      <div className="subpanel__head">
        <div className="subpanel__title">
          <StatusDot status={selected.status} />
          <span className="subpanel__name">{subagentDisplayName(selected.name)}</span>
          <span className={`subpanel__status subpanel__status--${selected.status}`}>
            {selected.status === "running" ? "Running" : selected.status === "failed" ? "Failed" : "Done"}
          </span>
          {selected.ms !== undefined && <span className="subpanel__duration">{formatDuration(selected.ms)}</span>}
        </div>
        {selected.prompt && <p className="subpanel__prompt">{selected.prompt}</p>}
      </div>

      <ActivityLog
        lines={selected.lines ?? []}
        running={selected.status === "running"}
        active={props.active}
        runId={selected.id}
      />

      {selected.report && (
        <div className="subpanel__section">
          <div className="subpanel__section-label">Report</div>
          <div className="subpanel__report">
            <Markdown
              text={selected.report}
              threadId={props.threadId ?? undefined}
              theme={themeByName(themeName(props.codeDisplay), variant(props.codeDisplay))}
              display={{
                themeLight: props.codeDisplay.themeLight ?? "GitHub Light",
                themeDark: props.codeDisplay.themeDark ?? "GitHub Dark",
                variant: variant(props.codeDisplay),
                fontSize: props.codeDisplay.codeFontSize,
                showLineNumbers: props.codeDisplay.showLineNumbers,
                wrapLongLines: props.codeDisplay.wrapLongLines,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Activity lines, auto-scrolled to the newest while the run is live. */
function ActivityLog({
  lines,
  running,
  active,
  runId,
}: {
  lines: string[];
  running: boolean;
  active: boolean;
  runId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active || !running) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, active, running, runId]);

  return (
    <div className="subpanel__section subpanel__section--grow">
      <div className="subpanel__section-label">Activity</div>
      <div className="subpanel__log" ref={ref}>
        {lines.length === 0 ? (
          <div className="subpanel__log-empty">{running ? "Starting up…" : "No tool activity recorded."}</div>
        ) : (
          lines.map((line, i) => (
            <div className="subpanel__log-row" key={`${runId}-${i}`}>
              <span className="subpanel__log-index">{i + 1}</span>
              <span className="subpanel__log-text">{line}</span>
            </div>
          ))
        )}
        {running && lines.length > 0 && <div className="subpanel__log-row subpanel__log-row--live">working…</div>}
      </div>
    </div>
  );
}

function variant(display: CodeDisplaySettings): "light" | "dark" {
  return display.variant ?? "dark";
}

function themeName(display: CodeDisplaySettings): string {
  return variant(display) === "light" ? (display.themeLight ?? "GitHub Light") : (display.themeDark ?? "GitHub Dark");
}

function StatusDot({ status }: { status: SubagentEvent["status"] }) {
  return <span className={`subpanel__dot subpanel__dot--${status}`} />;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
