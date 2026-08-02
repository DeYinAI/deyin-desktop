import { memo, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import { TOOL_RESULT_UI_CAP } from "../../shared/types.js";
import type { ThreadEvent } from "../threads.js";
import {
  isQuietTool,
  isSubagentTool,
  stripAnsi,
  toolDisplayName,
  truncateToolCard,
} from "./toolCallUtils.js";

export { isQuietTool, countRenderedToolNodes } from "./toolCallUtils.js";

const SHELL_PREVIEW_LINES = 10;

export interface ToolCallProps {
  event: Extract<ThreadEvent, { kind: "tool" }>;
  onOpenAgentTerminal?: () => void;
  /** Lazy-load full archived result on expand (cold storage path). */
  loadArchivedResult?: () => Promise<string | undefined>;
  defaultExpanded?: boolean;
}

/** One agent tool call: collapsed by default; auto-expands subagent/shell while running. */
export const ToolCall = memo(function ToolCall({
  event,
  onOpenAgentTerminal,
  loadArchivedResult,
  defaultExpanded = false,
}: ToolCallProps) {
  const running = event.ok === undefined;
  const failed = event.ok === false;
  const isShell = event.name === "bash";
  const isSubagent = isSubagentTool(event.name);
  const hasOutput = event.result !== undefined && event.result.length > 0;
  const shouldAutoExpand = running && (isShell || isSubagent);

  const [open, setOpen] = useState(defaultExpanded || shouldAutoExpand);
  const [expandedOnce, setExpandedOnce] = useState(false);
  const [archivedResult, setArchivedResult] = useState<string | undefined>();
  const [loadingArchive, setLoadingArchive] = useState(false);
  const resultRef = useRef<HTMLPreElement>(null);

  const displayName = toolDisplayName(event.name);
  const resultText = event.result ?? archivedResult;
  const showExpand = hasOutput || !running || loadingArchive;

  useLayoutEffect(() => {
    if (running && isShell && hasOutput) {
      setOpen(true);
      const el = resultRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [running, isShell, hasOutput, event.result]);

  useLayoutEffect(() => {
    if (running && isSubagent) setOpen(true);
  }, [running, isSubagent]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !expandedOnce && loadArchivedResult && !event.result) {
      setExpandedOnce(true);
      setLoadingArchive(true);
      try {
        const loaded = await loadArchivedResult();
        if (loaded) setArchivedResult(loaded);
      } finally {
        setLoadingArchive(false);
      }
    }
  };

  const preview = resultText ? shellPreview(stripAnsi(resultText)) : null;

  return (
    <div
      className={`tool-card ${failed ? "tool-card--failed" : ""} ${running ? "tool-card--running" : ""} ${open ? "tool-card--open" : "tool-card--collapsed"}`}
      data-tool-name={event.name}
    >
      <button type="button" className="tool-card__row" onClick={() => void toggle()} aria-expanded={open}>
        <Icon name={running ? "clock" : failed ? "close" : "check"} size={12} />
        <code className="tool-card__name">{displayName}</code>
        <span className="tool-card__summary">{event.summary}</span>
        {event.denied && <span className="badge badge--muted">denied</span>}
        {isShell && onOpenAgentTerminal && (
          <span
            className="tool-card__open-term"
            title="Open in terminal"
            onClick={(e) => {
              e.stopPropagation();
              onOpenAgentTerminal();
            }}
          >
            <Icon name="terminal" size={11} />
          </span>
        )}
        {showExpand && <Icon name={open ? "chevronDown" : "chevronRight"} size={11} />}
      </button>
      {open && resultText !== undefined && (
        <div className="tool-card__body">
          {loadingArchive && <span className="hint tool-card__loading">Loading…</span>}
          <pre className="tool-card__result" ref={resultRef}>
            {preview && !preview.showAll
              ? truncateToolCard(preview.text, TOOL_RESULT_UI_CAP)
              : truncateToolCard(stripAnsi(resultText), TOOL_RESULT_UI_CAP)}
          </pre>
          {preview && !preview.showAll && (
            <button type="button" className="tool-card__show-all" onClick={() => setOpen(true)}>
              Show all ({preview.totalLines} lines)
            </button>
          )}
        </div>
      )}
    </div>
  );
});

function shellPreview(text: string): { text: string; totalLines: number; showAll: boolean } {
  const lines = text.split("\n");
  if (lines.length <= SHELL_PREVIEW_LINES) {
    return { text, totalLines: lines.length, showAll: true };
  }
  return {
    text: lines.slice(0, SHELL_PREVIEW_LINES).join("\n") + "\n…",
    totalLines: lines.length,
    showAll: false,
  };
}

export interface ToolGroupProps {
  events: Extract<ThreadEvent, { kind: "tool" }>[];
  onOpenAgentTerminal?: () => void;
}

/** Renders tool cards with quiet mode: hides completed research tools behind a badge. */
export const ToolGroup = memo(function ToolGroup({ events, onOpenAgentTerminal }: ToolGroupProps) {
  const [quietExpanded, setQuietExpanded] = useState(false);

  const loud: Extract<ThreadEvent, { kind: "tool" }>[] = [];
  const quiet: Extract<ThreadEvent, { kind: "tool" }>[] = [];

  for (const ev of events) {
    if (isQuietTool(ev.name, ev.ok, ev.denied)) quiet.push(ev);
    else loud.push(ev);
  }

  return (
    <div className="tool-stack">
      {loud.map((event, i) => (
        <ToolCall key={`${event.name}-${i}-${event.summary}`} event={event} onOpenAgentTerminal={onOpenAgentTerminal} />
      ))}
      {quiet.length > 0 && !quietExpanded && (
        <button type="button" className="tool-stack__quiet-badge" onClick={() => setQuietExpanded(true)}>
          <Icon name="eye" size={12} />
          <span>{quiet.length} quiet tool{quiet.length === 1 ? "" : "s"}</span>
          <Icon name="chevronRight" size={11} />
        </button>
      )}
      {quietExpanded &&
        quiet.map((event, i) => (
          <ToolCall key={`q-${event.name}-${i}-${event.summary}`} event={event} onOpenAgentTerminal={onOpenAgentTerminal} />
        ))}
    </div>
  );
});
