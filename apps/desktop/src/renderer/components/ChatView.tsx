import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { themeByName, type CodeTheme } from "../code.js";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";
import { Markdown } from "./Markdown.js";
import { TodoRows, countVisibleTodos } from "./TodoChecklist.js";
import { ToolGroup } from "./ToolCall.js";
import { useEntranceAnimation } from "../hooks/useEntranceAnimation.js";
import {
  COLD_PAGE_SIZE,
  groupIntoTurns,
  partitionTurnZones,
  searchTurns,
  summarizeProcess,
  turnPreview,
  type ConversationTurn,
} from "../hooks/turnGrouping.js";
import type { ThreadEvent } from "../threads.js";
import type { AgentTodoStatus } from "../../shared/types.js";

/** Distance from the bottom (px) within which we consider the view "pinned". */
const PIN_THRESHOLD = 64;

export interface ChatCodeDisplay {
  themeLight: string;
  themeDark: string;
  variant: "light" | "dark";
  fontSize: number;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
}

export interface PlanArtifactLive {
  title: string;
  fileName: string;
}

interface ChatViewProps {
  events: ThreadEvent[];
  streamText: string | null;
  streamReasoning: string | null;
  greetingName: string;
  codeDisplay: ChatCodeDisplay;
  onOpenFile: (path: string) => void;
  onUndo: () => void;
  onBuild?: () => void;
  onOpenPlan?: () => void;
  planArtifact?: PlanArtifactLive | null;
  threadKey?: string | null;
  onOpenAgentTerminal?: () => void;
  threadTitles?: Record<string, string>;
  /** Bookmarked turn indices (session-scoped). */
  bookmarks?: number[];
  onToggleBookmark?: (turnIndex: number) => void;
}

/** Session timeline with hot/warm/cold pagination zones. */
export function ChatView(props: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [coldLoaded, setColdLoaded] = useState(COLD_PAGE_SIZE);
  const [navOpen, setNavOpen] = useState(false);
  const [navQuery, setNavQuery] = useState("");
  const [expandedWarm, setExpandedWarm] = useState<Set<number>>(() => new Set());
  const t = useT();

  const turns = useMemo(() => groupIntoTurns(props.events), [props.events]);
  const zones = useMemo(() => partitionTurnZones(turns, coldLoaded), [turns, coldLoaded]);
  const searchHits = useMemo(() => searchTurns(turns, navQuery), [turns, navQuery]);

  const syncPinFromScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = dist <= PIN_THRESHOLD;
    setShowJump(!pinnedRef.current);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    if (behavior === "smooth") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, []);

  const scrollToTurn = useCallback((turnIndex: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const target = el.querySelector(`[data-turn-index="${turnIndex}"]`);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      setNavOpen(false);
    }
  }, []);

  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom("auto");
  }, [props.events, props.streamText, props.streamReasoning, props.planArtifact, scrollToBottom]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) scrollToBottom("auto");
    });
    observer.observe(timeline);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    pinnedRef.current = true;
    setShowJump(false);
    setColdLoaded(COLD_PAGE_SIZE);
    setExpandedWarm(new Set());
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

  const coldRemaining = Math.max(0, turns.length - 100 - coldLoaded);

  return (
    <div className="chat" ref={scrollRef} onScroll={syncPinFromScroll}>
      <div className="chat__nav-bar">
        <button type="button" className="chat__nav-toggle" onClick={() => setNavOpen((v) => !v)} title="Turn navigation">
          <Icon name="list" size={14} />
          <span>{turns.length} turns</span>
        </button>
        {navOpen && (
          <div className="chat__nav-panel" role="dialog" aria-label="Turn navigation">
            <input
              className="chat__nav-search"
              placeholder="Search transcript…"
              value={navQuery}
              onChange={(e) => setNavQuery(e.target.value)}
            />
            <ul className="chat__nav-list">
              {(navQuery ? searchHits.map((i) => turns[i]!) : turns.slice(-20)).map((turn) => (
                <li key={turn.index}>
                  <button type="button" className="chat__nav-item" onClick={() => scrollToTurn(turn.index)}>
                    <span className="chat__nav-num">#{turn.index + 1}</span>
                    <span className="chat__nav-preview">{turnPreview(turn)}</span>
                    {props.bookmarks?.includes(turn.index) && <Icon name="star" size={11} />}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="chat__timeline" ref={timelineRef}>
        {zones.map((zone, zi) => {
          if (zone.zone === "cold" && zone.turns.length === 0 && coldRemaining > 0) {
            return (
              <button
                key={`cold-more-${zi}`}
                type="button"
                className="chat__load-more"
                onClick={() => setColdLoaded((n) => n + COLD_PAGE_SIZE)}
              >
                Load {Math.min(coldRemaining, COLD_PAGE_SIZE)} earlier turns ({coldRemaining} remaining)
              </button>
            );
          }
          return zone.turns.map((turn) => (
            <TurnBlock
              key={turn.index}
              turn={turn}
              zone={zone.zone}
              expanded={zone.zone === "hot" || expandedWarm.has(turn.index)}
              onToggleExpand={() =>
                setExpandedWarm((cur) => {
                  const next = new Set(cur);
                  if (next.has(turn.index)) next.delete(turn.index);
                  else next.add(turn.index);
                  return next;
                })
              }
              codeTheme={codeTheme}
              codeDisplay={props.codeDisplay}
              threadKey={props.threadKey}
              onOpenFile={props.onOpenFile}
              onUndo={props.onUndo}
              onBuild={props.onBuild}
              onOpenPlan={props.onOpenPlan}
              onOpenAgentTerminal={props.onOpenAgentTerminal}
              threadTitles={props.threadTitles}
              bookmarked={props.bookmarks?.includes(turn.index)}
              onToggleBookmark={props.onToggleBookmark ? () => props.onToggleBookmark!(turn.index) : undefined}
            />
          ));
        })}

        {props.streamReasoning !== null && props.streamReasoning.length > 0 && (
          <LiveReasoning text={props.streamReasoning} />
        )}
        {props.streamText !== null && props.streamText.length > 0 && (
          <div className="assistant-text">
            <Markdown text={props.streamText} theme={codeTheme} display={props.codeDisplay} threadId={props.threadKey} />
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
          <button type="button" className="chat__jump-btn" onClick={jumpToLatest} title={t("chat.jumpToLatest")} aria-label={t("chat.jumpToLatest")}>
            <Icon name="arrowDown" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function TurnBlock({
  turn,
  zone,
  expanded,
  onToggleExpand,
  codeTheme,
  codeDisplay,
  threadKey,
  onOpenFile,
  onUndo,
  onBuild,
  onOpenPlan,
  onOpenAgentTerminal,
  threadTitles,
  bookmarked,
  onToggleBookmark,
}: {
  turn: ConversationTurn;
  zone: "hot" | "warm" | "cold";
  expanded: boolean;
  onToggleExpand: () => void;
  codeTheme: CodeTheme;
  codeDisplay: ChatCodeDisplay;
  threadKey?: string | null;
  onOpenFile: (path: string) => void;
  onUndo: () => void;
  onBuild?: () => void;
  onOpenPlan?: () => void;
  onOpenAgentTerminal?: () => void;
  threadTitles?: Record<string, string>;
  bookmarked?: boolean;
  onToggleBookmark?: () => void;
}) {
  const entranceRef = useEntranceAnimation<HTMLDivElement>([turn.index, zone]);

  if (zone === "warm" && !expanded) {
    return (
      <div ref={entranceRef} className="turn-card turn-card--warm" data-turn-index={turn.index}>
        <button type="button" className="turn-card__head" onClick={onToggleExpand}>
          <span className="turn-card__num">Turn {turn.index + 1}</span>
          <span className="turn-card__preview">{turnPreview(turn)}</span>
          <span className="turn-card__meta">{summarizeProcess(turn.process)}</span>
          <Icon name="chevronRight" size={11} />
        </button>
      </div>
    );
  }

  const processTools = turn.process.filter((e): e is Extract<ThreadEvent, { kind: "tool" }> => e.kind === "tool");
  const processOther = turn.process.filter((e) => e.kind !== "tool");

  return (
    <div ref={entranceRef} className={`turn-card turn-card--${zone}`} data-turn-index={turn.index}>
      {onToggleBookmark && (
        <button type="button" className={`turn-card__bookmark ${bookmarked ? "turn-card__bookmark--on" : ""}`} onClick={onToggleBookmark} title="Bookmark turn">
          <Icon name="star" size={12} />
        </button>
      )}
      {turn.user && (
        <EventRow event={turn.user} codeTheme={codeTheme} codeDisplay={codeDisplay} threadKey={threadKey} onOpenFile={onOpenFile} onUndo={onUndo} onBuild={onBuild} onOpenPlan={onOpenPlan} threadTitles={threadTitles} />
      )}
      {processTools.length > 0 && <ToolGroup events={processTools} onOpenAgentTerminal={onOpenAgentTerminal} />}
      {processOther.length > 0 && (
        <div className="turn-card__process">
          {processOther.map((event, i) => (
            <EventRow key={i} event={event} codeTheme={codeTheme} codeDisplay={codeDisplay} threadKey={threadKey} onOpenFile={onOpenFile} onUndo={onUndo} onBuild={onBuild} onOpenPlan={onOpenPlan} threadTitles={threadTitles} />
          ))}
        </div>
      )}
      {turn.assistant && (
        <EventRow event={turn.assistant} codeTheme={codeTheme} codeDisplay={codeDisplay} threadKey={threadKey} onOpenFile={onOpenFile} onUndo={onUndo} onBuild={onBuild} onOpenPlan={onOpenPlan} threadTitles={threadTitles} />
      )}
    </div>
  );
}

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
  threadKey,
  onOpenFile,
  onUndo,
  onBuild,
  onOpenPlan,
  threadTitles,
}: {
  event: ThreadEvent;
  codeTheme: CodeTheme;
  codeDisplay: ChatCodeDisplay;
  threadKey?: string | null;
  onOpenFile: (path: string) => void;
  onUndo: () => void;
  onBuild?: () => void;
  onOpenPlan?: () => void;
  threadTitles?: Record<string, string>;
}) {
  switch (event.kind) {
    case "user":
      return (
        <div className="bubble-row">
          <div className="bubble bubble--user">
            {(event.attachments?.length ?? 0) > 0 || (event.linkedThreadIds?.length ?? 0) > 0 ? (
              <div className="bubble__chips">
                {event.attachments?.map((a) => (
                  <span key={a.path} className="chip chip--attach chip--readonly">
                    <Icon name={a.kind === "folder" ? "folder" : "file"} size={11} />
                    <span>{a.label ?? a.path.split(/[\\/]/).pop()}</span>
                  </span>
                ))}
                {event.linkedThreadIds?.map((id) => (
                  <span key={id} className="chip chip--link chip--readonly">
                    <Icon name="hash" size={11} />
                    <span>{threadTitles?.[id] ?? "Linked thread"}</span>
                  </span>
                ))}
              </div>
            ) : null}
            {event.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="assistant-text">
          <Markdown text={event.text} theme={codeTheme} display={codeDisplay} threadId={threadKey ?? undefined} />
        </div>
      );
    case "reasoning":
      return <ThinkingCard text={event.text} seconds={event.seconds} />;
    case "plan-ready":
      return <PlanFileCard title={event.title} fileName={event.fileName} onBuild={onBuild} onOpenPlan={onOpenPlan} />;
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
    case "error":
      return (
        <div className="activity-line activity-line--error">
          <Icon name="close" size={13} />
          <span>{event.text}</span>
        </div>
      );
    case "evidence-gate":
      return (
        <div className="activity-line activity-line--error evidence-gate">
          <Icon name="shield" size={13} />
          <span>
            <strong>Delivery gate ({event.code})</strong>: {event.message}
          </span>
        </div>
      );
    case "evidence-sign-off":
      return (
        <div className="activity-line evidence-sign-off">
          <Icon name="check" size={13} />
          <span>
            Step <code>{event.stepId}</code> signed off — verified with <code>{event.verificationCommand}</code>
          </span>
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
    case "compaction-notice":
      return (
        <div className="activity-line activity-line--optimization">
          <Icon name="clock" size={13} />
          <span>
            {event.softWarning
              ? "Context approaching limit — compaction may run soon"
              : `Context compacted (${[
                  event.droppedMessages > 0 ? `${event.droppedMessages} messages` : "",
                  event.truncatedToolResults > 0 ? `${event.truncatedToolResults} tool results` : "",
                  event.truncatedToolArgs > 0 ? `${event.truncatedToolArgs} tool args` : "",
                ]
                  .filter(Boolean)
                  .join(", ")})`}
          </span>
        </div>
      );
    default:
      return null;
  }
}

function ThinkingCard({ text, seconds }: { text: string; seconds?: number }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const label = seconds !== undefined && seconds > 0 ? `${t("chat.thoughtFor")} ${seconds}s` : t("chat.thought");
  return (
    <div className="thinking">
      <button type="button" className="thinking__head" onClick={() => setOpen((v) => !v)}>
        <Icon name="brain" size={13} />
        <span>{label}</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={11} />
      </button>
      {open && <div className="thinking__body">{text}</div>}
    </div>
  );
}

function OptimizationCard({ event }: { event: Extract<ThreadEvent, { kind: "optimization" }> }) {
  const tokensSaved = Math.max(0, event.originalInputTokens - event.compressedInputTokens);
  const rows: { label: string; value: string }[] = [];
  if (tokensSaved > 0) {
    const pct = event.originalInputTokens > 0 ? Math.round((1 - event.compressionRatio) * 100) : 0;
    rows.push({ label: "Compression", value: `${tokensSaved.toLocaleString()} tokens (-${pct}%)` });
  }
  if (event.cachedPromptTokens > 0) rows.push({ label: "Prompt cache", value: `${event.cachedPromptTokens.toLocaleString()} tokens` });
  if (event.toolCacheHits > 0) rows.push({ label: "Tool cache hits", value: `${event.toolCacheHits}` });
  if (event.responseCacheHits > 0) rows.push({ label: "Response cache hits", value: `${event.responseCacheHits}` });
  if (event.estimatedCostSavingsUsd > 0) rows.push({ label: "Est. savings", value: `$${event.estimatedCostSavingsUsd.toFixed(4)}` });
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

function PlanFileCard({
  title,
  fileName,
  streaming,
  onBuild,
  onOpenPlan,
}: {
  title?: string;
  fileName?: string;
  streaming?: boolean;
  onBuild?: () => void;
  onOpenPlan?: () => void;
}) {
  const t = useT();
  const name = fileName?.trim() || "plan.md";
  const subtitle = title?.trim() && title.trim() !== name ? title.trim() : t("chat.planFileDesc");
  return (
    <div className={`file-card plan-file-card ${streaming ? "plan-file-card--streaming" : ""}`}>
      <div className="file-card__head">
        <span className="file-card__badge">MD</span>
        <span className="file-card__name" title={subtitle}>{name}</span>
        {streaming ? <span className="plan-file-card__status">{t("chat.planWriting")}</span> : <span className="plan-file-card__status">{t("chat.planReady")}</span>}
        <span className="file-card__actions">
          {onOpenPlan && (
            <button type="button" className="chip chip--small" onClick={onOpenPlan}>{t("chat.openPlan")}</button>
          )}
          {onBuild && !streaming && (
            <button type="button" className="chip chip--small chip--accent" onClick={onBuild}>
              <Icon name="play" size={11} />
              {t("chat.build")}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

function TodoCard({ event }: { event: Extract<ThreadEvent, { kind: "plan" }> }) {
  const [open, setOpen] = useState(true);
  const t = useT();
  const { visible: total, done } = countVisibleTodos(event.steps.map((s) => ({ status: s.status ?? (s.done ? "completed" : "pending") })));
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
        <span className="todo-card__summary">{done}/{total} {t("tasks.completed")}</span>
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

function extBadge(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot === name.length - 1) return "TXT";
  if (dot <= 0) return name.slice(1).toUpperCase().slice(0, 4) || "TXT";
  return name.slice(dot + 1).toUpperCase().slice(0, 4);
}

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
      <div className={`file-card__head ${hasSnippet ? "file-card__head--toggle" : ""}`} onClick={hasSnippet ? () => setOpen((v) => !v) : undefined} title={event.subtitle}>
        <span className="file-card__badge">{extBadge(event.name)}</span>
        <span className="file-card__name">{event.name}</span>
        {(event.adds > 0 || event.dels > 0) && (
          <span className="file-card__changes">
            <span className="adds">+{event.adds}</span>
            <span className="dels">-{event.dels}</span>
          </span>
        )}
        <span className="file-card__actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="chip chip--small" onClick={onUndo}><Icon name="undo" size={11} /> Undo</button>
          <button type="button" className="chip chip--small" onClick={() => onOpenFile(openTarget)}>Open</button>
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
            <button type="button" className="file-card__more" onClick={() => onOpenFile(openTarget)}>… {event.snippetMore} more changed lines</button>
          )}
        </div>
      )}
    </div>
  );
}
