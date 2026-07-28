import { useEffect, useRef, useState } from "react";
import { CodeBlock, splitMessageSegments, themeByName, type CodeTheme } from "../code.js";
import { Icon } from "./Icon.js";
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
  greetingName: string;
  codeDisplay: ChatCodeDisplay;
  onOpenFile: (name: string) => void;
  onUndo: () => void;
}

/** The session timeline: chat bubbles interleaved with agent activity cards. */
export function ChatView(props: ChatViewProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [props.events, props.streamText]);

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
          />
        ))}
        {props.streamText !== null && (
          <div className="assistant-text">
            {props.streamText.length > 0 ? (
              <RichText text={props.streamText} theme={codeTheme} display={props.codeDisplay} />
            ) : (
              <span className="hint">Thinking…</span>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

/** Assistant text with ``` code fences rendered through the themed CodeBlock. */
function RichText({ text, theme, display }: { text: string; theme: CodeTheme; display: ChatCodeDisplay }) {
  return (
    <>
      {splitMessageSegments(text).map((segment, i) =>
        segment.type === "text" ? (
          <span key={i}>{segment.text}</span>
        ) : (
          <CodeBlock
            key={i}
            code={segment.code}
            lang={segment.lang || undefined}
            theme={theme}
            fontSize={display.fontSize}
            showLineNumbers={display.showLineNumbers}
            wrapLongLines={display.wrapLongLines}
          />
        ),
      )}
    </>
  );
}

function EventRow({
  event,
  codeTheme,
  codeDisplay,
  onOpenFile,
  onUndo,
}: {
  event: ThreadEvent;
  codeTheme: CodeTheme;
  codeDisplay: ChatCodeDisplay;
  onOpenFile: (name: string) => void;
  onUndo: () => void;
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
          <RichText text={event.text} theme={codeTheme} display={codeDisplay} />
        </div>
      );

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
          <button className="btn btn--outline file-card__open" onClick={() => onOpenFile(event.name)}>
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
