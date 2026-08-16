import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { themeByName, type CodeTheme } from "../code.js";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";
import { Markdown } from "./Markdown.js";
import { TodoRows, countVisibleTodos } from "./TodoChecklist.js";
import type { ThreadEvent } from "../threads.js";
import { TOOL_RESULT_UI_CAP, type AgentTodoStatus } from "../../shared/types.js";

/** Distance from the bottom (px) within which we consider the view "pinned". */
const PIN_THRESHOLD = 64;

export interface ChatCodeDisplay {
  themeLight: string;
  themeDark: string;
  /** The interface variant currently active (resolves "system"). */
  variant: "light" | "dark";
  fontSize: number;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
}

/** Live plan artifact while Plan mode is writing the document (markdown stays in the Plan tab). */
export interface PlanArtifactLive {
  title: string;
  fileName: string;
}

interface ChatViewProps {
  events: ThreadEvent[];
  streamText: string | null;
  /** Model reasoning streamed for the in-flight step (rendered above the text). */
  streamReasoning: string | null;
  greetingName: string;
  codeDisplay: ChatCodeDisplay;
  onOpenFile: (path: string) => void;
  onUndo: (name: string) => void;
  /** Plan-ready card actions (plan mode). */
  onBuild?: () => void;
  onOpenPlan?: () => void;
  /** Plan awaiting approval: shows Revise/Edit/Build inline on the plan card (Cursor-style, no modal). */
  pendingPlan?: { title: string; overview?: string; filePath?: string } | null;
  onRevisePlan?: () => void;
  onEditPlan?: () => void;
  /** In-flight plan file card; full markdown streams only in the Plan tab. */
  planArtifact?: PlanArtifactLive | null;
  /** Active thread id — switching threads resets scroll to the bottom, pinned. */
  threadKey?: string | null;
  /** threadId -> title map for rendering #-linked thread chips in user bubbles. */
  threadTitles?: Record<string, string>;
  /** Open the Agent terminal tab for the current thread (bash tool cards). */
  onOpenAgentTerminal?: () => void;
}

/** The session timeline: chat bubbles interleaved with agent activity cards. */
export function ChatView(props: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const t = useT();

  const syncPinFromScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = dist <= PIN_THRESHOLD;
    pinnedRef.current = pinned;
    setShowJump(!pinned);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  // Follow new content only while pinned. Instant scroll keeps the resulting
  // scroll event reading as "at bottom", so we don't unpin ourselves.
  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom("auto");
  }, [props.events, props.streamText, props.streamReasoning, props.planArtifact, scrollToBottom]);

  // Stay pinned across async reflows (code highlight, expanding cards, images).
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) scrollToBottom("auto");
    });
    observer.observe(timeline);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  // Thread switches always land at the bottom, pinned.
  useLayoutEffect(() => {
    pinnedRef.current = true;
    setShowJump(false);
    scrollToBottom("auto");
  }, [props.threadKey, scrollToBottom]);

  const jumpToLatest = () => {
    pinnedRef.current = true;
    setShowJump(false);
    scrollToBottom("smooth");
  };

  const codeTheme = themeByName(
    props.codeDisplay.variant === "light" ? props.codeDisplay.themeLight : props.codeDisplay.themeDark,
    props.codeDisplay.variant,
  );

  if (props.events.length === 0 && props.streamText === null) {
    return (
      <div className="chat chat--empty" ref={scrollRef}>
        <div className="greeting">
          {props.greetingName}, <span className="muted">what are we building?</span>
        </div>
      </div>
    );
  }

  return (
    <div className="chat" ref={scrollRef} onScroll={syncPinFromScroll}>
      <div className="chat__timeline" ref={timelineRef}>
        {groupTimelineEvents(props.events).map((group, i) =>
          group.kind === "tools" ? (
            <div key={i} className="tool-stack">
              {group.events.map((event, j) => (
                <ToolCard key={j} event={event} onOpenAgentTerminal={props.onOpenAgentTerminal} />
              ))}
            </div>
          ) : (
            <EventRow
              key={i}
              event={group.event}
              codeTheme={codeTheme}
              codeDisplay={props.codeDisplay}
              onOpenFile={props.onOpenFile}
              onUndo={props.onUndo}
              onBuild={props.onBuild}
              onOpenPlan={props.onOpenPlan}
              onRevisePlan={props.onRevisePlan}
              onEditPlan={props.onEditPlan}
              planPending={Boolean(props.pendingPlan) && isLastPlanReady(props.events, group.event)}
              threadTitles={props.threadTitles}
            />
          ),
        )}
        {props.streamReasoning !== null && props.streamReasoning.length > 0 && (
          <LiveReasoning text={props.streamReasoning} />
        )}
        {props.streamText !== null && props.streamText.length > 0 && (
          <div className="assistant-text">
            <Markdown text={props.streamText} theme={codeTheme} display={props.codeDisplay} />
          </div>
        )}
        {props.streamText !== null &&
          props.streamText.length === 0 &&
          (props.streamReasoning ?? "").length === 0 &&
          !props.planArtifact && (
            <div className="assistant-text">
              <span className="hint">{t("chat.thinking")}</span>
            </div>
          )}
        {props.planArtifact && (
          <PlanFileCard
            title={props.planArtifact.title}
            fileName={props.planArtifact.fileName}
            streaming
            onOpenPlan={props.onOpenPlan}
          />
        )}
      </div>
      {showJump && (
        <div className="chat__jump">
          <button
            type="button"
            className="chat__jump-btn"
            onClick={jumpToLatest}
            title={t("chat.jumpToLatest")}
            aria-label={t("chat.jumpToLatest")}
          >
            <Icon name="arrowDown" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

type TimelineGroup =
  | { kind: "tools"; events: Extract<ThreadEvent, { kind: "tool" }>[] }
  | { kind: "single"; event: ThreadEvent };

/** Collapse consecutive tool events into one stack so shell runs read as one activity block. */
function groupTimelineEvents(events: ThreadEvent[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  for (const event of events) {
    if (event.kind === "tool") {
      const last = groups[groups.length - 1];
      if (last?.kind === "tools") {
        last.events.push(event);
      } else {
        groups.push({ kind: "tools", events: [event] });
      }
    } else {
      groups.push({ kind: "single", event });
    }
  }
  return groups;
}

/** Reasoning stream of the current step: expanded while it arrives. */
function LiveReasoning({ text }: { text: string }) {
  const t = useT();
  return (
    <div className="thinking thinking--live">
      <div className="thinking__head">
        <Icon name="brain" size={13} />
        <span>{t("chat.thinking")}</span>
      </div>
      <div className="thinking__body">{text}</div>
    </div>
  );
}

function EventRow({
  event,
  codeTheme,
  codeDisplay,
  onOpenFile,
  onUndo,
  onBuild,
  onOpenPlan,
  onRevisePlan,
  onEditPlan,
  planPending,
  threadTitles,
}: {
  event: ThreadEvent;
  codeTheme: CodeTheme;
  codeDisplay: ChatCodeDisplay;
  onOpenFile: (path: string) => void;
  onUndo: (name: string) => void;
  onBuild?: () => void;
  onOpenPlan?: () => void;
  onRevisePlan?: () => void;
  onEditPlan?: () => void;
  /** True when this card is the plan awaiting user approval. */
  planPending?: boolean;
  /** threadId -> title map for #-linked thread chips in user bubbles. */
  threadTitles?: Record<string, string>;
}) {
  switch (event.kind) {
    case "user": {
      const chips: string[] = (event.attachments ?? []).map((a) => `@${a.label ?? a.path}`);
      for (const id of event.linkedThreadIds ?? []) {
        chips.push(`# ${threadTitles?.[id] ?? "thread"}`);
      }
      return (
        <div className="bubble-row">
          <div className="bubble bubble--user">
            {chips.length > 0 && (
              <div className="bubble__chips">
                {chips.map((chip, i) => (
                  <span key={i} className="chip chip--small">{chip}</span>
                ))}
              </div>
            )}
            {event.text}
          </div>
        </div>
      );
    }

    case "assistant":
      return (
        <div className="assistant-text">
          <Markdown text={event.text} theme={codeTheme} display={codeDisplay} />
        </div>
      );

    case "reasoning":
      return <ThinkingCard text={event.text} seconds={event.seconds} />;

    case "plan-ready":
      return (
        <PlanFileCard
          title={event.title}
          fileName={event.fileName}
          onBuild={onBuild}
          onOpenPlan={onOpenPlan}
          pending={planPending}
          onRevise={onRevisePlan}
          onEdit={onEditPlan}
        />
      );

    case "plan":
      return <TodoCard event={event} />;

    case "file":
      return <FileCard event={event} codeDisplay={codeDisplay} onOpenFile={onOpenFile} onUndo={onUndo} />;

    case "model-switch":
      return (
        <div className="divider-note">
          <span className="divider-note__line" />
          <span className="divider-note__label">
            <Icon name="swap" size={12} />
            Model switched {event.from} → {event.to}
          </span>
          <span className="divider-note__line" />
        </div>
      );

    case "skill":
      return (
        <div className="activity-line">
          <Icon name="sparkles" size={13} />
          <span>Ran skill</span>
          <code>{event.name}</code>
        </div>
      );

    case "tool":
      return <ToolCard event={event} />;

    case "error":
      return (
        <div className="activity-line activity-line--error">
          <Icon name="close" size={13} />
          <span>{event.text}</span>
        </div>
      );

    case "thought":
      return (
        <div className="activity-line">
          <Icon name="clock" size={13} />
          <span>{event.label}</span>
        </div>
      );

    case "worked":
      return (
        <div className="worked-line">
          <span>Worked for {event.seconds} s</span>
          <Icon name="chevronRight" size={12} />
        </div>
      );

    case "optimization":
      return <OptimizationCard event={event} />;

    case "evidence-gate":
      return (
        <div className="activity-line activity-line--error">
          <Icon name="shield" size={13} />
          <span title={event.message}>Delivery gate ({event.code}) — step not verifiable yet</span>
        </div>
      );

    case "evidence-sign-off":
      return (
        <div className="activity-line">
          <Icon name="check" size={13} />
          <span>
            Step signed off (<code>{event.stepId}</code>) — verified with <code>{event.verificationCommand}</code>
          </span>
        </div>
      );

    case "compaction-notice":
      return (
        <div className="activity-line">
          <Icon name="clock" size={13} />
          <span>{event.softWarning ? "Context over 50% — compaction may run soon" : "Context compacted for this run"}</span>
        </div>
      );

    default:
      return null;
  }
}

/** Collapsed reasoning block: "Thought for Ns", expandable to the full text. */
function ThinkingCard({ text, seconds }: { text: string; seconds?: number }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const label =
    seconds !== undefined && seconds > 0 ? `${t("chat.thoughtFor")} ${seconds}s` : t("chat.thought");
  return (
    <div className="thinking">
      <button className="thinking__head" onClick={() => setOpen((v) => !v)}>
        <Icon name="brain" size={13} />
        <span>{label}</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={11} />
      </button>
      {open && <div className="thinking__body">{text}</div>}
    </div>
  );
}

/** Per-run token-optimization summary: compression ratio, prompt-cache + tool/response cache hits. */
function OptimizationCard({ event }: { event: Extract<ThreadEvent, { kind: "optimization" }> }) {
  const tokensSaved = Math.max(0, event.originalInputTokens - event.compressedInputTokens);
  const rows: { label: string; value: string }[] = [];
  if (tokensSaved > 0) {
    const pct = event.originalInputTokens > 0
      ? Math.round((1 - event.compressionRatio) * 100)
      : 0;
    rows.push({ label: "Compression", value: `${tokensSaved.toLocaleString()} tokens (-${pct}%)` });
  }
  if (event.cachedPromptTokens > 0) rows.push({ label: "Prompt cache", value: `${event.cachedPromptTokens.toLocaleString()} tokens` });
  if (event.toolCacheHits > 0) rows.push({ label: "Tool cache hits", value: `${event.toolCacheHits}` });
  if (event.responseCacheHits > 0) rows.push({ label: "Response cache hits", value: `${event.responseCacheHits}` });
  if (event.estimatedCostSavingsUsd > 0) {
    rows.push({
      label: "Est. savings",
      value: `$${event.estimatedCostSavingsUsd.toFixed(4)}`,
    });
  }
  if (rows.length === 0) return null;
  return (
    <div className="activity-line activity-line--optimization">
      <Icon name="sparkles" size={13} />
      <span className="optimization-card__title">Optimization</span>
      <span className="optimization-card__rows">
        {rows.map((r) => (
          <span key={r.label} className="optimization-card__row">
            <span className="optimization-card__row-label">{r.label}</span>
            <span className="optimization-card__row-value">{r.value}</span>
          </span>
        ))}
      </span>
    </div>
  );
}

/** True when `event` is the newest plan-ready card in the timeline. */
function isLastPlanReady(events: ThreadEvent[], event: ThreadEvent): boolean {
  if (event.kind !== "plan-ready") return false;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === "plan-ready") return events[i] === event;
  }
  return false;
}

/** Cursor-style plan artifact: file card in chat; full markdown only in the Plan tab. */
function PlanFileCard({
  title,
  fileName,
  streaming,
  onBuild,
  onOpenPlan,
  pending,
  onRevise,
  onEdit,
}: {
  title?: string;
  fileName?: string;
  streaming?: boolean;
  onBuild?: () => void;
  onOpenPlan?: () => void;
  /** Plan is awaiting approval — show Revise/Edit/Build inline instead of a modal. */
  pending?: boolean;
  onRevise?: () => void;
  onEdit?: () => void;
}) {
  const t = useT();
  const name = fileName?.trim() || "plan.md";
  const subtitle = title?.trim() && title.trim() !== name ? title.trim() : t("chat.planFileDesc");
  return (
    <div className={`file-card plan-file-card ${streaming ? "plan-file-card--streaming" : ""}`}>
      <div className="file-card__head">
        <span className="file-card__badge">MD</span>
        <span className="file-card__name" title={subtitle}>
          {name}
        </span>
        {streaming ? (
          <span className="plan-file-card__status">{t("chat.planWriting")}</span>
        ) : (
          <span className="plan-file-card__status">{t("chat.planReady")}</span>
        )}
        <span className="file-card__actions">
          {onOpenPlan && (
            <button type="button" className="chip chip--small" onClick={onOpenPlan}>
              {t("chat.openPlan")}
            </button>
          )}
          {onBuild && !streaming && (
            <button type="button" className="chip chip--small chip--accent" onClick={onBuild}>
              <Icon name="play" size={11} />
              {t("chat.build")}
            </button>
          )}
        </span>
      </div>
      {pending && !streaming && (
        <div className="plan-file-card__pending">
          <span className="plan-file-card__hint">{t("chat.planReadyDesc")}</span>
          <span className="file-card__actions">
            {onRevise && (
              <button type="button" className="chip chip--small" onClick={onRevise}>
                {t("chat.revise")}
              </button>
            )}
            {onEdit && (
              <button type="button" className="chip chip--small" onClick={onEdit}>
                {t("chat.editPlan")}
              </button>
            )}
            {onBuild && (
              <button type="button" className="chip chip--small chip--accent" onClick={onBuild}>
                <Icon name="play" size={11} />
                {t("chat.build")}
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

/** Cursor-style todo checklist: collapsible "todo_write N/M completed" header
 *  over circular status rows. Updated in place as the agent reports progress. */
function TodoCard({ event }: { event: Extract<ThreadEvent, { kind: "plan" }> }) {
  const [open, setOpen] = useState(true);
  const t = useT();
  // Match TaskList's semantics: cancelled steps are excluded from the total and
  // the done count, so the progress bar doesn't show "3/3" when one step was
  // cancelled while TaskList shows "2/3".
  const { visible: total, done } = countVisibleTodos(
    event.steps.map((s) => ({
      status: s.status ?? (s.done ? "completed" : "pending"),
    })),
  );
  const allDone = total > 0 && done === total;
  const items = event.steps.map((step, i) => ({
    id: `step-${i}`,
    content: step.text,
    status: (step.status ?? (step.done ? "completed" : "pending")) as AgentTodoStatus,
  }));
  return (
    <div className="todo-card">
      <button type="button" className="todo-card__head" onClick={() => setOpen((v) => !v)}>
        <span className={`todo-card__status ${allDone ? "todo-card__status--done" : ""}`}>
          <Icon name={allDone ? "check" : "clock"} size={11} />
        </span>
        <code className="todo-card__name">todo_write</code>
        <span className="todo-card__summary">
          {done}/{total} {t("tasks.completed")}
        </span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={11} className="todo-card__chevron" />
      </button>
      {open && (
        <div className="todo-card__steps">
          <TodoRows items={items} />
        </div>
      )}
      {event.badge && (
        <span className="todo-card__badge">
          <Icon name="check" size={12} />
          {event.badge}
        </span>
      )}
    </div>
  );
}

/** File extension badge label ("TS", "CSS", …) for the chat file card. */
function extBadge(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot === name.length - 1) return "TXT"; // trailing dot, no extension
  if (dot <= 0) {
    // Dotfile (`.gitignore`, `.env`): badge with the stem so "ENV" / "GIT" is
    // more informative than a generic "TXT".
    return name.slice(1).toUpperCase().slice(0, 4) || "TXT";
  }
  return name.slice(dot + 1).toUpperCase().slice(0, 4);
}

/** One file mutation: Cursor-style header (badge, name, +adds -dels, actions)
 *  over a collapsible color-coded diff snippet. */
function FileCard({
  event,
  codeDisplay,
  onOpenFile,
  onUndo,
}: {
  event: Extract<ThreadEvent, { kind: "file" }>;
  codeDisplay: ChatCodeDisplay;
  onOpenFile: (path: string) => void;
  onUndo: (name: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const snippet = event.snippet ?? [];
  const hasSnippet = snippet.length > 0;
  const openTarget = event.subtitle || event.name;
  return (
    <div className="file-card">
      <div
        className={`file-card__head ${hasSnippet ? "file-card__head--toggle" : ""}`}
        onClick={hasSnippet ? () => setOpen((v) => !v) : undefined}
        title={event.subtitle}
      >
        <span className="file-card__badge">{extBadge(event.name)}</span>
        <span className="file-card__name">{event.name}</span>
        {(event.adds > 0 || event.dels > 0) && (
          <span className="file-card__changes">
            <span className="adds">+{event.adds}</span>
            <span className="dels">-{event.dels}</span>
          </span>
        )}
        <span className="file-card__actions" onClick={(e) => e.stopPropagation()}>
          <button className="chip chip--small" title="Restore the previous content of this file" onClick={() => onUndo(event.name)}>
            <Icon name="undo" size={11} />
            Undo
          </button>
          <button className="chip chip--small" onClick={() => onOpenFile(openTarget)}>
            Open
          </button>
        </span>
        {hasSnippet && <Icon name={open ? "chevronDown" : "chevronRight"} size={11} className="file-card__chevron" />}
      </div>
      {hasSnippet && open && (
        <div className="file-card__diff" style={{ fontSize: codeDisplay.fontSize }}>
          <table className="diff-table">
            <tbody>
              {snippet.map((line, i) => (
                <tr key={i} className={`diff-row diff-row--${line.type}`}>
                  {codeDisplay.showLineNumbers && <td className="diff-no">{line.oldNo ?? ""}</td>}
                  {codeDisplay.showLineNumbers && <td className="diff-no">{line.newNo ?? ""}</td>}
                  <td className="diff-sign">{line.type === "add" ? "+" : line.type === "del" ? "-" : ""}</td>
                  <td className="diff-text">{line.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(event.snippetMore ?? 0) > 0 && (
            <button className="file-card__more" onClick={() => onOpenFile(openTarget)}>
              … {event.snippetMore} more changed lines
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Strip ANSI CSI / OSC sequences so streamed shell output is readable in chat. */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "");
}

/** One agent tool call: status line expanding to the (truncated) result. */
function ToolCard({
  event,
  onOpenAgentTerminal,
}: {
  event: Extract<ThreadEvent, { kind: "tool" }>;
  onOpenAgentTerminal?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const resultRef = useRef<HTMLPreElement>(null);
  // ok undefined means still running (result may already be streaming).
  const running = event.ok === undefined;
  const failed = event.ok === false;
  const displayName = toolDisplayName(event.name);
  const isShell = event.name === "bash";
  const hasOutput = event.result !== undefined && event.result.length > 0;

  // Auto-expand and follow output while a shell command streams.
  useLayoutEffect(() => {
    if (running && isShell && hasOutput) {
      setOpen(true);
      const el = resultRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [running, isShell, hasOutput, event.result]);

  return (
    <div className={`tool-card ${failed ? "tool-card--failed" : ""} ${running ? "tool-card--running" : ""}`}>
      <button className="tool-card__row" onClick={() => setOpen((v) => !v)}>
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
        {(hasOutput || !running) && event.result !== undefined && (
          <Icon name={open ? "chevronDown" : "chevronRight"} size={11} />
        )}
      </button>
      {open && event.result !== undefined && (
        <pre className="tool-card__result" ref={resultRef}>
          {truncateToolCard(stripAnsi(event.result), TOOL_RESULT_UI_CAP)}
        </pre>
      )}
    </div>
  );
}

/** Show the real shell on Windows (tool is named bash but runs cmd.exe). */
function toolDisplayName(name: string): string {
  if (name === "bash" && typeof navigator !== "undefined" && /win/i.test(navigator.platform)) {
    return "cmd";
  }
  return name;
}

/** Tail truncate so the card matches streaming / tool-end UI caps. */
function truncateToolCard(text: string, max: number): string {
  return text.length > max ? `… (truncated)\n${text.slice(-max)}` : text;
}
