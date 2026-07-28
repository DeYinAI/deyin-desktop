import { useEffect, useRef, useState } from "react";
import { themeByName, type CodeTheme } from "../code.js";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";
import { Markdown } from "./Markdown.js";
import type { ThreadEvent } from "../threads.js";

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
      return (
        <div className="plan-card">
          <div className="plan-card__steps">
            {event.steps.map((step, i) => (
              <div className="plan-step" key={i}>
                <span className={`plan-step__box ${step.done ? "plan-step__box--done" : ""}`}>
                  {step.done && <Icon name="check" size={10} />}
                </span>
                <span className={step.done ? "plan-step__text plan-step__text--done" : "plan-step__text"}>
                  {step.text}
                </span>
              </div>
            ))}
          </div>
          {event.badge && (
            <span className="plan-card__badge">
              <Icon name="check" size={12} />
              {event.badge}
            </span>
          )}
        </div>
      );

    case "file":
      return (
        <div className="file-card">
          <span className="file-card__icon">
            <Icon name="globe" size={16} />
          </span>
          <span className="file-card__meta">
            <span className="file-card__name">{event.name}</span>
            <span className="file-card__subtitle">{event.subtitle}</span>
          </span>
          {(event.adds > 0 || event.dels > 0) && (
            <span className="file-card__changes">
              <span>1 file changed</span>
              <span className="adds">+{event.adds}</span>
              <span className="dels">-{event.dels}</span>
              <button className="chip chip--small" onClick={onUndo}>
                <Icon name="undo" size={11} />
                Undo
              </button>
            </span>
          )}
          <button className="btn btn--outline file-card__open" onClick={() => onOpenFile(event.subtitle || event.name)}>
            Open
            <Icon name="chevronDown" size={12} />
          </button>
        </div>
      );

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
