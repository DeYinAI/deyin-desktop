import { useEffect, useRef, useState } from "react";
import { themeByName, type CodeTheme } from "../code.js";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";
import { Markdown } from "./Markdown.js";
import { TodoRows, countVisibleTodos } from "./TodoChecklist.js";
import type { ThreadEvent } from "../threads.js";
import type { AgentTodoStatus } from "../../shared/types.js";

export interface ChatCodeDisplay {
  themeLight: string;
  themeDark: string;
  /** The interface variant currently active (resolves "system"). */
  variant: "light" | "dark";
  fontSize: number;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
}

interface ChatViewProps {
  events: ThreadEvent[];
  streamText: string | null;
  /** Model reasoning streamed for the in-flight step (rendered above the text). */
  streamReasoning: string | null;
  greetingName: string;
  codeDisplay: ChatCodeDisplay;
  onOpenFile: (path: string) => void;
  onUndo: () => void;
  /** Plan-ready card actions (plan mode). */
  onBuild?: () => void;
  onOpenPlan?: () => void;
}

/** The session timeline: chat bubbles interleaved with agent activity cards. */
export function ChatView(props: ChatViewProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [props.events, props.streamText, props.streamReasoning]);

  const codeTheme = themeByName(
    props.codeDisplay.variant === "light" ? props.codeDisplay.themeLight : props.codeDisplay.themeDark,
    props.codeDisplay.variant,
  );

  if (props.events.length === 0 && props.streamText === null) {
    return (
      <div className="chat chat--empty">
        <div className="greeting">
          {props.greetingName}, <span className="muted">what are we building?</span>
        </div>
      </div>
    );
  }

  return (
    <div className="chat">
      <div className="chat__timeline">
        {props.events.map((event, i) => (
          <EventRow
            key={i}
            event={event}
            codeTheme={codeTheme}
            codeDisplay={props.codeDisplay}
            onOpenFile={props.onOpenFile}
            onUndo={props.onUndo}
            onBuild={props.onBuild}
            onOpenPlan={props.onOpenPlan}
          />
        ))}
        {props.streamReasoning !== null && props.streamReasoning.length > 0 && (
          <LiveReasoning text={props.streamReasoning} />
        )}
        {props.streamText !== null && (
          <div className="assistant-text">
            {props.streamText.length > 0 ? (
              <Markdown text={props.streamText} theme={codeTheme} display={props.codeDisplay} />
            ) : (
              (props.streamReasoning ?? "").length === 0 && <span className="hint">{t("chat.thinking")}</span>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
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
}: {
  event: ThreadEvent;
  codeTheme: CodeTheme;
  codeDisplay: ChatCodeDisplay;
  onOpenFile: (path: string) => void;
  onUndo: () => void;
  onBuild?: () => void;
  onOpenPlan?: () => void;
}) {
  switch (event.kind) {
    case "user":
      return (
        <div className="bubble-row">
          <div className="bubble bubble--user">{event.text}</div>
        </div>
      );

    case "assistant":
      return (
        <div className="assistant-text">
          <Markdown text={event.text} theme={codeTheme} display={codeDisplay} />
        </div>
      );

    case "reasoning":
      return <ThinkingCard text={event.text} seconds={event.seconds} />;

    case "plan-ready":
      return <PlanReadyCard onBuild={onBuild} onOpenPlan={onOpenPlan} />;

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

/** Plan-mode completion card: review the plan, then hand it to agent mode. */
function PlanReadyCard({ onBuild, onOpenPlan }: { onBuild?: () => void; onOpenPlan?: () => void }) {
  const t = useT();
  return (
    <div className="plan-ready">
      <span className="plan-ready__icon">
        <Icon name="route" size={15} />
      </span>
      <span className="plan-ready__meta">
        <span className="plan-ready__title">{t("chat.planReady")}</span>
        <span className="plan-ready__desc">{t("chat.planReadyDesc")}</span>
      </span>
      {onOpenPlan && (
        <button className="btn btn--outline" onClick={onOpenPlan}>
          {t("chat.openPlan")}
        </button>
      )}
      {onBuild && (
        <button className="btn" onClick={onBuild}>
          <Icon name="play" size={12} />
          {t("chat.build")}
        </button>
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
  onUndo: () => void;
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
          <button className="chip chip--small" onClick={onUndo}>
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

/** One agent tool call: status line expanding to the (truncated) result. */
function ToolCard({ event }: { event: Extract<ThreadEvent, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const running = event.ok === undefined && event.result === undefined;
  const failed = event.ok === false;
  return (
    <div className={`tool-card ${failed ? "tool-card--failed" : ""}`}>
      <button className="tool-card__row" onClick={() => setOpen((v) => !v)}>
        <Icon name={running ? "clock" : failed ? "close" : "check"} size={12} />
        <code className="tool-card__name">{event.name}</code>
        <span className="tool-card__summary">{event.summary}</span>
        {event.denied && <span className="badge badge--muted">denied</span>}
        {event.result !== undefined && <Icon name={open ? "chevronDown" : "chevronRight"} size={11} />}
      </button>
      {open && event.result !== undefined && <pre className="tool-card__result">{truncate(event.result, 4000)}</pre>}
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}
