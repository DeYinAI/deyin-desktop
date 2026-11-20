import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { themeByName, type CodeTheme } from "../code.js";
import { writeClipboardText } from "../clipboard.js";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";
import { Logo } from "./Logo.js";
import { Markdown } from "./Markdown.js";
import { MessageActions } from "./MessageActions.js";
import { RunActivity, type ActivityItem } from "./RunActivity.js";
import { subagentDisplayName, subagentStatusLine } from "./SubagentPanel.js";
import { TodoRows, countVisibleTodos } from "./TodoChecklist.js";
import { Callout, CodeTag, FlatCard, SectionLabel, SeverityBadge } from "./ui/index.js";
import type { ThreadEvent } from "../threads.js";
import { extractHtmlPageFromMarkdownLoose } from "../htmlPage.js";
import { InlineHtmlPagePreview } from "./InlineHtmlPagePreview.js";
import { STEP_LIMIT_LABEL, TOOL_RESULT_UI_CAP, type AgentTodoStatus } from "@deyin/contract";
import { describeEvidenceGate, describeRunStats } from "@deyin/host-core/shared";
import { formatTokens } from "../formatTokens.js";
import { readPin } from "../chatPin.js";
export {
  ConductorWorkflowCard,
  ConductorStageProgressCard,
  ConductorWatchdogAlertCard,
  ConductorReviewMergeCard,
} from "./ConductorModeCards.js";
import { ConductorReviewMergeCard, ConductorStageProgressCard } from "./ConductorModeCards.js";


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
  /** Opening slice of the plan as it streams in. */
  preview?: string;
}

interface ChatViewProps {
  events: ThreadEvent[];
  streamText: string | null;
  /** Model reasoning streamed for the in-flight step (rendered above the text). */
  streamReasoning: string | null;
  greetingName: string;
  /** What an empty conversation shows in place of the project hero (a Bot's, for instance). */
  emptyState?: ReactNode;
  codeDisplay: ChatCodeDisplay;
  onOpenFile: (path: string) => void;
  /** Open a workspace path in the right-hand Files panel (markdown file refs). */
  onOpenWorkspaceFile?: (path: string) => void;
  workspaceRoot?: string | null;
  homeDir?: string | null;
  onUndo: (path: string, checkpointId: string) => void;
  onRevertRun?: (checkpointId: string) => void;
  onEditMessage?: (eventIndex: number) => void;
  agentRunning?: boolean;
  reverting?: boolean;
  /** Plan-ready card actions (plan mode). */
  onBuild?: () => void;
  onOpenPlan?: () => void;
  /** Page-ready card: open the Preview panel. */
  onOpenPreview?: () => void;
  /** Plan written but not built yet and no gate on screen: the card offers Build. */
  canBuildPlan?: boolean;
  /** Full plan markdown of the active thread — enables Copy on the newest plan card. */
  planMarkdown?: string | null;
  /** In-flight plan file card; full markdown streams only in the Plan tab. */
  planArtifact?: PlanArtifactLive | null;
  /** Active thread id — switching threads resets scroll to the bottom, pinned. */
  threadKey?: string | null;
  /** threadId -> title map for rendering #-linked thread chips in user bubbles. */
  threadTitles?: Record<string, string>;
  /** Open the Agent terminal tab for the current thread (bash tool cards). */
  onOpenAgentTerminal?: () => void;
  /** Open the workspace Agent panel on a subagent run (subagent cards). */
  onOpenSubagent?: (id: string) => void;
  /** Continue button on the step-limit divider: resume the run. */
  onContinue?: () => void;
  /** Fork the thread at a timeline event index (assistant messages). */
  onForkAtEvent?: (eventIndex: number) => void;
  /** Optional message feedback (telemetry / analytics). `removed` marks a retraction. */
  onMessageFeedback?: (eventIndex: number, rating: "up" | "down", removed?: boolean) => void;
}

/** The session timeline: chat bubbles interleaved with agent activity cards. */
export function ChatView(props: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  /** `scrollTop` at the last scroll, so a scroll event can tell the person moving up from the layout changing. */
  const lastTopRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [messageFeedback, setMessageFeedback] = useState<Record<number, "up" | "down">>({});
  const t = useT();

  useEffect(() => {
    setMessageFeedback({});
  }, [props.threadKey]);

  const syncPinFromScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pinned = readPin(pinnedRef.current, lastTopRef.current, { top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight });
    lastTopRef.current = el.scrollTop;
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
      lastTopRef.current = el.scrollTop;
    }
  }, []);

  // Follow new content only while pinned. Instant scroll keeps the resulting
  // scroll event reading as "at bottom", so we don't unpin ourselves.
  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom("auto");
  }, [props.events, props.streamText, props.streamReasoning, props.planArtifact, scrollToBottom]);

  // Stay pinned across async reflows (code highlight, expanding cards, images) and when the viewport itself gets
  // shorter or taller (a permission card above the composer): the newest message must stay in view.
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    const viewport = scrollRef.current;
    if (!timeline) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) scrollToBottom("auto");
    });
    observer.observe(timeline);
    if (viewport) observer.observe(viewport);
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

  // Grouping walks the entire timeline, and ChatView re-renders for reasons that
  // have nothing to do with the timeline — most of all every keystroke in the
  // composer, whose `input` state lives in the root component. Memoising on the
  // events keeps typing O(1) in the length of the conversation instead of O(n).
  //
  // Every hook must run before the empty-state early return below — the
  // empty↔populated transition (New Chat) changes which branch renders, and a
  // hook skipped by the early return crashes the tree (React error #300).
  const groups = useMemo(() => groupTimelineEvents(props.events), [props.events]);

  // Branch forks the chat below a settled answer, so only the newest assistant
  // text in a closed turn can own it. Older answers keep the control, dimmed, so the
  // row's shape stays stable while the reason explains itself.
  const lastAssistantIndex = useMemo(() => {
    for (let i = props.events.length - 1; i >= 0; i--) {
      if (props.events[i]!.kind === "assistant") return i;
    }
    return -1;
  }, [props.events]);
  const turnClosed = props.agentRunning !== true && props.streamText === null;

  if (props.events.length === 0 && props.streamText === null) {
    return (
      <div className="chat chat--empty" ref={scrollRef}>
        {props.emptyState ?? (
          <div className="empty-hero">
            <span className="empty-hero__logo" aria-hidden>
              <Logo size={44} />
            </span>
            <div className="greeting">
              <span className="muted">{props.greetingName}, </span>what are we building?
            </div>
            <div className="empty-hero__quick-actions">
              {props.onBuild && (
                <button
                  type="button"
                  className="empty-hero__chip"
                  onClick={props.onBuild}
                >
                  <Icon name="bolt" size={13} />
                  <span>Build mode</span>
                </button>
              )}
              {props.onOpenPlan && (
                <button
                  type="button"
                  className="empty-hero__chip"
                  onClick={props.onOpenPlan}
                >
                  <Icon name="route" size={13} />
                  <span>Plan mode</span>
                </button>
              )}
              {props.onOpenAgentTerminal && (
                <button
                  type="button"
                  className="empty-hero__chip"
                  onClick={props.onOpenAgentTerminal}
                >
                  <Icon name="terminal" size={13} />
                  <span>Terminal</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="chat" ref={scrollRef} onScroll={syncPinFromScroll}>
      <div className="chat__timeline" ref={timelineRef}>
        <div className="chat__start">{t("chat.historyStart")}</div>
        {groups.map((group, i) =>
          group.kind === "activity" ? (
            <ActivityBlock
              key={i}
              items={group.items as ActivityItem[]}
              live={props.agentRunning === true && i === groups.length - 1}
              onOpenAgentTerminal={props.onOpenAgentTerminal}
              onOpenFile={props.onOpenFile}
              onUndo={props.onUndo}
              agentRunning={props.agentRunning}
              reverting={props.reverting}
              codeDisplay={props.codeDisplay}
            />
          ) : (
            <EventRow
              key={i}
              event={group.event}
              eventIndex={group.eventIndex}
              codeTheme={codeTheme}
              codeDisplay={props.codeDisplay}
              onOpenFile={props.onOpenFile}
              onOpenWorkspaceFile={props.onOpenWorkspaceFile}
              workspaceRoot={props.workspaceRoot}
              homeDir={props.homeDir}
              onUndo={props.onUndo}
              onRevertRun={props.onRevertRun}
              onEditMessage={props.onEditMessage}
              agentRunning={props.agentRunning}
              reverting={props.reverting}
              onBuild={props.onBuild}
              onOpenPlan={props.onOpenPlan}
              onOpenPreview={props.onOpenPreview}
              planLatest={isLastPlanReady(props.events, group.event)}
              canBuildPlan={props.canBuildPlan}
              planMarkdown={props.planMarkdown}
              threadTitles={props.threadTitles}
              threadId={props.threadKey}
              onOpenSubagent={props.onOpenSubagent}
 onContinue={props.onContinue}
              messageFeedback={messageFeedback[group.eventIndex]}
              onForkAtEvent={props.onForkAtEvent}
              forkUnavailableReason={
                group.eventIndex === lastAssistantIndex && turnClosed
                  ? undefined
                  : t("chat.forkUnavailable")
              }
              onMessageFeedback={(rating) => {
                // A second click on the same rating retracts it, so the row
                // toggles like the harness rather than locking a choice in.
                const removed = messageFeedback[group.eventIndex] === rating;
                setMessageFeedback((cur) => {
                  if (!removed) return { ...cur, [group.eventIndex]: rating };
                  const { [group.eventIndex]: _retracted, ...rest } = cur;
                  return rest;
                });
                props.onMessageFeedback?.(group.eventIndex, rating, removed);
              }}
            />
          ),
        )}
        {props.streamReasoning !== null && props.streamReasoning.length > 0 && (
          <LiveReasoning text={props.streamReasoning} />
        )}
        {props.streamText !== null && props.streamText.length > 0 && (
          <AssistantMessage
            text={props.streamText}
            codeTheme={codeTheme}
            codeDisplay={props.codeDisplay}
            threadId={props.threadKey}
            workspaceRoot={props.workspaceRoot}
            homeDir={props.homeDir}
            onOpenWorkspaceFile={props.onOpenWorkspaceFile}
            streaming
          />
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
          <PlanCard
            title={props.planArtifact.title}
            fileName={props.planArtifact.fileName}
            preview={props.planArtifact.preview}
            streaming
            onOpenPlan={props.onOpenPlan}
            codeTheme={codeTheme}
            codeDisplay={props.codeDisplay}
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
  | { kind: "activity"; items: ThreadEvent[] }
  | { kind: "single"; event: ThreadEvent; eventIndex: number };

const ACTIVITY_EVENT_KINDS = new Set<ThreadEvent["kind"]>(["reasoning", "tool", "file"]);

function isActivityEvent(event: ThreadEvent): boolean {
  return ACTIVITY_EVENT_KINDS.has(event.kind);
}

/** Collapse consecutive reasoning/tool/file events into one activity block. */
function groupTimelineEvents(events: ThreadEvent[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (isActivityEvent(event)) {
      const last = groups[groups.length - 1];
      if (last?.kind === "activity") last.items.push(event);
      else groups.push({ kind: "activity", items: [event] });
    } else {
      groups.push({ kind: "single", event, eventIndex: i });
    }
  }
  return groups;
}

/** One agent step block: the fold + compact step list, with full cards on expand. */
function ActivityBlock({
  items,
  live,
  onOpenAgentTerminal,
  onOpenFile,
  onUndo,
  agentRunning,
  reverting,
  codeDisplay,
}: {
  items: ActivityItem[];
  live: boolean;
  onOpenAgentTerminal?: () => void;
  onOpenFile: (path: string) => void;
  onUndo: (path: string, checkpointId: string) => void;
  agentRunning?: boolean;
  reverting?: boolean;
  codeDisplay: ChatCodeDisplay;
}) {
  const renderDetail = (item: ActivityItem) => {
    switch (item.kind) {
      case "reasoning":
        return <div className="thinking__body">{item.text}</div>;
      case "file":
        return (
          <FileCard
            event={item}
            codeDisplay={codeDisplay}
            onOpenFile={onOpenFile}
            onUndo={onUndo}
            agentRunning={agentRunning}
            reverting={reverting}
          />
        );
      case "tool":
        return <StepIoCard event={item} onOpenAgentTerminal={onOpenAgentTerminal} />;
      default: {
        const unreachable: never = item;
        return unreachable;
      }
    }
  };
  return (
    <div className="activity-block">
      <RunActivity items={items} live={live} renderDetail={renderDetail} />
    </div>
  );
}

/**
 * Reasoning stream of the current step.
 *
 * While the model is thinking the text is shown live (that is the whole point of
 * a thinking visual — the user watches the model reason). When the reasoning
 * stream ends the block collapses back to a one-line `Thought · Ns` disclosure so
 * a long session stays readable, exactly like a finished reasoning part.
 */
function LiveReasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const sinceRef = useRef(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - sinceRef.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const label = elapsed > 0 ? `Thinking · ${elapsed}s` : "Thinking";
  return (
    <div className="thinking thinking--live">
      <StatusLine icon="brain" label={label} onClick={() => setOpen((v) => !v)} open={open} />
      {open && (
        <div className="thinking__body">
          <StreamingText text={text} />
        </div>
      )}
    </div>
  );
}

/** Reasoned prose with a cursor-trimmed tail so the block never re-wraps whole. */
function StreamingText({ text }: { text: string }) {
  return (
    <span className="thinking__text">
      {text}
      <span className="stream-caret" aria-hidden />
    </span>
  );
}

function EventRow({
  event,
  eventIndex,
  codeTheme,
  codeDisplay,
  onOpenFile,
  onOpenWorkspaceFile,
  workspaceRoot,
  homeDir,
  onUndo,
  onRevertRun,
  onEditMessage,
  agentRunning,
  reverting,
  onBuild,
  onOpenPlan,
  onOpenPreview,
  planLatest,
  canBuildPlan,
  planMarkdown,
  threadTitles,
  threadId,
  onOpenSubagent,
 onContinue,
  messageFeedback,
  onForkAtEvent,
  forkUnavailableReason,
  onMessageFeedback,
}: {
  event: ThreadEvent;
  eventIndex: number;
  codeTheme: CodeTheme;
  codeDisplay: ChatCodeDisplay;
  onOpenFile: (path: string) => void;
  onOpenWorkspaceFile?: (path: string) => void;
  workspaceRoot?: string | null;
  homeDir?: string | null;
  onUndo: (path: string, checkpointId: string) => void;
  onRevertRun?: (checkpointId: string) => void;
  onEditMessage?: (eventIndex: number) => void;
  agentRunning?: boolean;
  reverting?: boolean;
  onBuild?: () => void;
  onOpenPlan?: () => void;
  onOpenPreview?: () => void;
  /** True when this is the newest plan card in the timeline (owns Copy/Build). */
  planLatest?: boolean;
  /** The newest plan is written but not built yet. */
  canBuildPlan?: boolean;
  /** Full plan markdown of the thread (newest plan card only). */
  planMarkdown?: string | null;
  /** threadId -> title map for #-linked thread chips in user bubbles. */
  threadTitles?: Record<string, string>;
  /** Active thread id — inline visualization/image embeds read from its store. */
  threadId?: string | null;
  /** Open the workspace Agent panel on this subagent run. */
  onOpenSubagent?: (id: string) => void;
 /** Resume the run from a step-limit stop. */
 onContinue?: () => void;
  messageFeedback?: "up" | "down";
  onForkAtEvent?: (eventIndex: number) => void;
  /** Set when Branch cannot run from this message; keeps the control visible but inert. */
  forkUnavailableReason?: string;
  onMessageFeedback?: (rating: "up" | "down") => void;
}) {
 const t = useT();
  switch (event.kind) {
    case "user": {
      const chips: string[] = (event.attachments ?? []).map((a) => `@${a.label ?? a.path}`);
      for (const id of event.linkedThreadIds ?? []) {
        chips.push(`# ${threadTitles?.[id] ?? "thread"}`);
      }
      return (
        <div className="bubble-row bubble-row--user">
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
          {event.text.trim().length > 0 && (
            <MessageActions
              text={event.text}
              onEdit={
                onEditMessage !== undefined && !agentRunning
                  ? () => onEditMessage(eventIndex)
                  : undefined
              }
            />
          )}
        </div>
      );
    }

    case "assistant":
      return (
        <AssistantMessage
          text={event.text}
          codeTheme={codeTheme}
          codeDisplay={codeDisplay}
          threadId={threadId}
          workspaceRoot={workspaceRoot}
          homeDir={homeDir}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          onOpenPreview={onOpenPreview}
          feedback={messageFeedback}
          onFork={onForkAtEvent ? () => onForkAtEvent(eventIndex) : undefined}
          forkUnavailableReason={forkUnavailableReason}
          onFeedback={onMessageFeedback}
        />
      );

    case "reasoning":
      return <ThinkingCard text={event.text} seconds={event.seconds} />;

    case "plan-ready":
      return (
        <PlanCard
          title={event.title}
          fileName={event.fileName}
          preview={event.preview}
          fullText={planLatest ? planMarkdown : null}
          canBuild={planLatest && canBuildPlan}
          onBuild={onBuild}
          onOpenPlan={onOpenPlan}
          codeTheme={codeTheme}
          codeDisplay={codeDisplay}
        />
      );

    case "page-ready":
      return (
        <PageCard
          title={event.title}
          fileName={event.fileName}
          preview={event.preview}
          onOpenPreview={onOpenPreview}
        />
      );

    case "plan":
      return <TodoCard event={event} />;

    case "file":
      return (
        <FileCard
          event={event}
          codeDisplay={codeDisplay}
          onOpenFile={onOpenFile}
          onUndo={onUndo}
          agentRunning={agentRunning}
          reverting={reverting}
        />
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

    case "goal-set":
      return (
        <div className="divider-note">
          <span className="divider-note__line" />
          <span className="divider-note__label">
            <Icon name="flag" size={12} />
            {event.text === null
              ? "Goal cleared"
              : `${event.replaced ? "Goal updated" : "Goal set"} — ${event.text}`}
          </span>
          <span className="divider-note__line" />
        </div>
      );

    case "goal-status":
      return (
        <div className="divider-note divider-note--status">
          <span className="divider-note__line" />
          <span className="divider-note__label">
            <Icon name="flag" size={12} />
            {event.text}
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

    case "tool": {
      if (event.name === "merge_conductor_diff" && event.result) {
        return (
          <ConductorReviewMergeCard
            workflowName="External Bot Pipeline"
            branchName={event.summary?.replace(/^merge bot branch\s*/i, "").trim() || "conductor/worktree"}
            stagesCompleted={1}
            totalStages={1}
            diffSummary={event.result}
            onMerge={async (branch) => {
              if (window.deyin?.conductorWorkflows?.merge) {
                await window.deyin.conductorWorkflows.merge(workspaceRoot || "", branch);
              }
            }}
          />
        );
      }
      if (event.name === "delegate_external_bot") {
        const stageProgress: any = {
          stageId: event.startedAt ? String(event.startedAt) : "conductor-run",
          stageName: event.summary || "Delegate to External Bot",
          agentId: "external-bot",
          status: event.result ? (event.ok === false ? "failed" : "completed") : "running",
          elapsedMs: event.durationMs ?? 0,
          heartbeatCount: 1,
          linesProduced: event.result ? event.result.split("\n").length : 0,
          outputSummary: event.result,
          error: event.ok === false ? event.result : undefined,
        };
        return (
          <ConductorStageProgressCard
            stage={stageProgress}
            onNudge={(id) => window.deyin?.externalAgents?.nudge(id, "Progress check")}
            onAbort={(id) => window.deyin?.externalAgents?.abort(id)}
            onViewLogs={(id) => window.deyin?.externalAgents?.logs(id, 50)}
          />
        );
      }
      return <ToolCard event={event} />;
    }

    case "subagent":
      return <SubagentCard event={event} onOpen={onOpenSubagent} />;

    case "error":
      return (
        <div className="activity-line activity-line--error">
          <Icon name="close" size={13} />
          <span>{event.text}</span>
        </div>
      );

    case "thought":
      if (event.label === STEP_LIMIT_LABEL) {
        return (
        <div className="divider-note">
          <span className="divider-note__line" />
          <span className="divider-note__label">
            <Icon name="clock" size={12} />
            {t("chat.stepLimit")}
            {onContinue && (
              <button type="button" className="chip chip--small chip--accent" onClick={onContinue}>
                <Icon name="play" size={11} />
                {t("chat.continue")}
              </button>
            )}
            {event.revertable && event.checkpointId && onRevertRun && !agentRunning && (
              <button
                type="button"
                className="chip chip--small"
                disabled={reverting}
                onClick={() => onRevertRun(event.checkpointId!)}
              >
                <Icon name="undo" size={11} />
                {reverting ? t("chat.revertInProgress") : t("chat.revertRun")}
              </button>
            )}
          </span>
          <span className="divider-note__line" />
        </div>
        );
      }
      if (event.label === "Run stopped" && event.revertable && event.checkpointId && onRevertRun) {
        return (
          <div className="divider-note">
            <span className="divider-note__line" />
            <span className="divider-note__label">
              <Icon name="clock" size={12} />
              {event.label}
              {!agentRunning && (
                <button
                  type="button"
                  className="chip chip--small"
                  disabled={reverting}
                  onClick={() => onRevertRun(event.checkpointId!)}
                >
                  <Icon name="undo" size={11} />
                  {reverting ? t("chat.revertInProgress") : t("chat.revertRun")}
                </button>
              )}
            </span>
            <span className="divider-note__line" />
          </div>
        );
      }
      return <StatusLine icon={statusIconForLabel(event.label)} label={event.label} />;

    case "worked":
      return (
        <StatusLine
          icon="bolt"
          label={`Worked on it · ${event.actions ?? 1} action${(event.actions ?? 1) === 1 ? "" : "s"}`}
        />
      );

    case "optimization":
      return <OptimizationCard event={event} />;

    case "run-stats":
      return <StatusLine icon="chart" label={describeRunStats(event)} />;

    case "evidence-gate": {
      // The gate channel also carries the loop's "keep going" nudges; only real
      // delivery-mode gates get the red treatment.
      const gate = describeEvidenceGate(event.code, event.message);
      return (
        <div className={gate.tone === "error" ? "activity-line activity-line--error" : "activity-line"}>
          <Icon name={gate.tone === "error" ? "shield" : "refresh"} size={13} />
          <span title={event.message}>{gate.text}</span>
        </div>
      );
    }

    case "evidence-sign-off":
      return (
        <div className="activity-line">
          <Icon name="check" size={13} />
          <span>
            Step signed off (<code>{event.stepId}</code>) — verified with <code>{event.verificationCommand}</code>
          </span>
        </div>
      );

    case "compaction-notice": {
      const parts: string[] = [];
      if (event.droppedMessages > 0) parts.push(`${event.droppedMessages} messages summarized`);
      if (event.truncatedToolResults > 0) parts.push(`${event.truncatedToolResults} tool results shortened`);
      if (event.truncatedToolArgs > 0) parts.push(`${event.truncatedToolArgs} tool args trimmed`);
      const verb = event.compaction === "fold" ? "Context folded" : "Context pruned";
      return (
        <details className="activity-line activity-line--compaction">
          <summary>
            <Icon name="clock" size={13} />
            <span>
              {verb} — {formatTokens(event.reclaimedTokens)} tokens reclaimed
              {parts.length > 0 ? ` (${parts.join(", ")})` : ""}
            </span>
          </summary>
          {event.summary ? <pre className="activity-line__summary">{event.summary}</pre> : null}
        </details>
      );
    }

    default:
      return null;
  }
}

/** Assistant bubble with its action row: copy, feedback, fork-from-here. */
function AssistantMessage({
  text,
  codeTheme,
  codeDisplay,
  threadId,
  workspaceRoot,
  homeDir,
  onOpenWorkspaceFile,
  onOpenPreview,
  streaming = false,
  feedback,
  onFork,
  forkUnavailableReason,
  onFeedback,
}: {
  text: string;
  codeTheme: CodeTheme;
  codeDisplay: ChatCodeDisplay;
  threadId?: string | null;
  workspaceRoot?: string | null;
  homeDir?: string | null;
  onOpenWorkspaceFile?: (path: string) => void;
  onOpenPreview?: () => void;
  streaming?: boolean;
  feedback?: "up" | "down";
  onFork?: () => void;
  /** Why Branch cannot run here; keeps the control visible but inert. */
  forkUnavailableReason?: string;
  onFeedback?: (rating: "up" | "down") => void;
}) {
  const showActions = !streaming && text.trim().length > 0;
  const htmlPage = !streaming ? extractHtmlPageFromMarkdownLoose(text) : null;

  return (
    <div className={`assistant-message${streaming ? " assistant-message--streaming" : ""}`}>
      {htmlPage && <InlineHtmlPagePreview html={htmlPage} onOpenPreview={onOpenPreview} />}
      <div className="assistant-text">
        <Markdown
          text={text}
          theme={codeTheme}
          display={codeDisplay}
          threadId={threadId}
          workspaceRoot={workspaceRoot}
          homeDir={homeDir}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
        />
        {streaming && <span className="stream-caret" aria-hidden />}
      </div>
      {showActions && (
        <MessageActions
          text={text}
          feedback={feedback}
          onFeedback={onFeedback}
          onFork={onFork}
          forkUnavailableReason={forkUnavailableReason}
        />
      )}
    </div>
  );
}


/** Muted timeline status (Thought · 3s, Created 6 tasks, Worked on it · 1 action). */
function StatusLine({
  icon,
  label,
  onClick,
  open,
}: {
  icon: string;
  label: string;
  onClick?: () => void;
  open?: boolean;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={`activity-summary__row status-line${onClick ? " status-line--clickable" : ""}`}
      onClick={onClick}
    >
      <Icon name={icon} size={12} className="activity-summary__icon" />
      <span className="activity-summary__label">{label}</span>
      {onClick && <Icon name={open ? "chevronDown" : "chevronRight"} size={10} className="activity-summary__chevron" />}
    </Tag>
  );
}

function statusIconForLabel(label: string): string {
  // Before the "finished|failed" check below: a retry reason can say "the provider finished it".
  if (/— retrying in \d+s \(\d+\/\d+\)$/.test(label)) return "refresh";
  if (/created \d+ task/i.test(label)) return "list";
  if (/worked on it/i.test(label)) return "bolt";
  if (/run stopped|step limit|compacted/i.test(label)) return "clock";
  if (/finished|failed/i.test(label)) return "check";
  return "clock";
}

/** Collapsed reasoning block: minimal "Thought · Ns" disclosure row. */
function ThinkingCard({ text, seconds }: { text: string; seconds?: number }) {
  const [open, setOpen] = useState(false);
  const label = seconds !== undefined && seconds > 0 ? `Thought · ${seconds}s` : "Thought";
  return (
    <div className="thinking">
      <StatusLine icon="brain" label={label} onClick={() => setOpen((v) => !v)} open={open} />
      {open && <div className="thinking__body">{text}</div>}
    </div>
  );
}

/** Per-run token-optimization summary — collapsed by default. */
function OptimizationCard({ event }: { event: Extract<ThreadEvent, { kind: "optimization" }> }) {
  const [open, setOpen] = useState(false);
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
    <div className="optimization-card">
      <button type="button" className="optimization-card__head" onClick={() => setOpen((v) => !v)}>
        <Icon name="sparkles" size={12} />
        <span>Optimization</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={11} />
      </button>
      {open && (
        <div className="optimization-card__rows">
          {rows.map((r) => (
            <div key={r.label} className="optimization-card__row">
              <span className="optimization-card__row-label">{r.label}</span>
              <span className="optimization-card__row-value">{r.value}</span>
            </div>
          ))}
        </div>
      )}
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

/** Plan artifact in chat: a preview card that opens the full document in the Plan
 *  panel. The body shows the opening of the plan under a fade, so the timeline
 *  stays skimmable while the whole plan is one click away. */
function PlanCard({
  title,
  fileName,
  preview,
  fullText,
  streaming,
  canBuild,
  onOpenPlan,
  onBuild,
  codeTheme,
  codeDisplay,
}: {
  title?: string;
  fileName?: string;
  /** Opening slice of the plan markdown, rendered under the title. */
  preview?: string;
  /** Whole plan document — enables Copy when the chat still holds it. */
  fullText?: string | null;
  streaming?: boolean;
  /** Plan is written but not built yet: offer Build on the card itself. */
  canBuild?: boolean;
  onOpenPlan?: () => void;
  onBuild?: () => void;
  codeTheme: CodeTheme;
  codeDisplay: ChatCodeDisplay;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const name = fileName?.trim() || "plan.md";
  const heading = title?.trim() && title.trim() !== name ? title.trim() : name;
  const body = preview?.trim() ?? "";
  const copyText = (fullText ?? preview ?? "").trim();

  const copy = () => {
    if (!copyText) return;
    void writeClipboardText(copyText).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  const open = () => onOpenPlan?.();

  return (
    <FlatCard className={`plan-card${streaming ? " plan-card--streaming" : ""}${onOpenPlan ? " plan-card--clickable" : ""}`}>
      <div
        role={onOpenPlan ? "button" : undefined}
        tabIndex={onOpenPlan ? 0 : undefined}
        title={onOpenPlan ? t("chat.openPlan") : undefined}
        onClick={onOpenPlan ? open : undefined}
        onKeyDown={
          onOpenPlan
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  open();
                }
              }
            : undefined
        }
      >
      <div className="plan-card__head">
        <Icon name="sparkles" size={13} className="plan-card__glyph" />
        <span className="plan-card__kind">{t("chat.plan")}</span>
        <span className="plan-card__status">
          {streaming ? t("chat.planWriting") : t("chat.planReady")}
        </span>
        <span className="plan-card__actions" onClick={(e) => e.stopPropagation()}>
          {copyText && !streaming && (
            <button
              type="button"
              className="plan-card__iconbtn"
              onClick={copy}
              aria-label={t("chat.copyPlan")}
              title={copied ? t("chat.copied") : t("chat.copyPlan")}
            >
              <Icon name={copied ? "check" : "copy"} size={12} />
            </button>
          )}
          {onOpenPlan && (
            <button
              type="button"
              className="plan-card__iconbtn"
              onClick={open}
              aria-label={t("chat.openPlan")}
              title={t("chat.openPlan")}
            >
              <Icon name="panel" size={12} />
            </button>
          )}
        </span>
      </div>

      <div className="plan-card__body">
        <div className="plan-card__title">{heading}</div>
        {body ? (
          <div className="plan-card__preview" aria-hidden>
            <Markdown text={body} theme={codeTheme} display={codeDisplay} />
          </div>
        ) : (
          <div className="plan-card__hint">{t("chat.planFileDesc")}</div>
        )}
      </div>

      <div className="plan-card__foot" onClick={(e) => e.stopPropagation()}>
        <span className="plan-card__file">{name}</span>
        <span className="plan-card__foot-actions">
          {onOpenPlan && (
            <button type="button" className="chip chip--small" onClick={open}>
              {t("chat.openPlan")}
            </button>
          )}
          {canBuild && onBuild && !streaming && (
            <button type="button" className="chip chip--small chip--accent" onClick={onBuild}>
              <Icon name="play" size={11} />
              {t("chat.build")}
            </button>
          )}
        </span>
      </div>
      </div>
    </FlatCard>
  );
}

/** Page artifact in chat: opens the full one-page website in the Preview panel. */
function PageCard({
  title,
  fileName,
  preview,
  onOpenPreview,
}: {
  title?: string;
  fileName?: string;
  preview?: string;
  onOpenPreview?: () => void;
}) {
  const t = useT();
  const name = fileName?.trim() || "page.html";
  const heading = title?.trim() && title.trim() !== name ? title.trim() : name;
  const body = preview?.trim() ?? "";
  const open = () => onOpenPreview?.();

  return (
    <FlatCard className={`plan-card page-card${onOpenPreview ? " plan-card--clickable" : ""}`}>
      <div
        role={onOpenPreview ? "button" : undefined}
        tabIndex={onOpenPreview ? 0 : undefined}
        title={onOpenPreview ? t("chat.openPreview") : undefined}
        onClick={onOpenPreview ? open : undefined}
        onKeyDown={
          onOpenPreview
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  open();
                }
              }
            : undefined
        }
      >
        <div className="plan-card__head">
          <Icon name="layout" size={13} className="plan-card__glyph" />
          <span className="plan-card__kind">{t("chat.page")}</span>
          <span className="plan-card__status">{t("chat.pageReady")}</span>
          <span className="plan-card__actions" onClick={(e) => e.stopPropagation()}>
            {onOpenPreview && (
              <button
                type="button"
                className="plan-card__iconbtn"
                onClick={open}
                aria-label={t("chat.openPreview")}
                title={t("chat.openPreview")}
              >
                <Icon name="panel" size={12} />
              </button>
            )}
          </span>
        </div>

        <div className="plan-card__body">
          <div className="plan-card__title">{heading}</div>
          {body ? (
            <div className="plan-card__preview page-card__preview">{body}</div>
          ) : (
            <div className="plan-card__hint">{t("chat.pageFileDesc")}</div>
          )}
        </div>

        <div className="plan-card__foot" onClick={(e) => e.stopPropagation()}>
          <span className="plan-card__file">{name}</span>
          <span className="plan-card__foot-actions">
            {onOpenPreview && (
              <button type="button" className="chip chip--small" onClick={open}>
                {t("chat.openPreview")}
              </button>
            )}
          </span>
        </div>
      </div>
    </FlatCard>
  );
}

/** Task list created by todo_write — collapsible checklist in a HYRAX card. */
function TodoCard({ event }: { event: Extract<ThreadEvent, { kind: "plan" }> }) {
  const [open, setOpen] = useState(true);
  const t = useT();
  const { visible: total, done } = countVisibleTodos(
    event.steps.map((s) => ({
      status: s.status ?? (s.done ? "completed" : "pending"),
    })),
  );
  const items = event.steps.map((step, i) => ({
    id: `step-${i}`,
    content: step.text,
    status: (step.status ?? (step.done ? "completed" : "pending")) as AgentTodoStatus,
  }));
  return (
    <FlatCard>
      <button type="button" className="todo-card__head" onClick={() => setOpen((v) => !v)}>
        <SectionLabel trailing={`${done}/${total} ${t("tasks.completed")}`}>
          <code className="todo-card__name">todo_write</code>
        </SectionLabel>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={11} className="todo-card__chevron" />
      </button>
      {open && (
        <div className="todo-card__steps">
          <TodoRows items={items} />
        </div>
      )}
    </FlatCard>
  );
}

/** Compact a path for display: ~/… when under /home/user or C:\Users\user. */
function formatDisplayPath(path: string): string {
  const unix = path.match(/^\/home\/[^/]+(\/.*)?$/);
  if (unix) return `~${unix[1] ?? ""}`;
  const win = path.match(/^[A-Za-z]:\\Users\\[^\\]+(\\.*)?$/);
  if (win) return `~${(win[1] ?? "").replace(/\\/g, "/")}`;
  return path;
}

/** Expanded step body: an IN / OUT card — the command or arguments in, the result out. */
function StepIoCard({
  event,
  onOpenAgentTerminal,
}: {
  event: Extract<ThreadEvent, { kind: "tool" }>;
  onOpenAgentTerminal?: () => void;
}) {
  const outRef = useRef<HTMLPreElement>(null);
  const running = event.ok === undefined;
  const isShell = event.name === "bash";
  const exitCode = isShell ? shellExitCode(event.result, !running) : undefined;
  const failed = event.ok === false || event.denied === true || (exitCode !== undefined && exitCode !== 0);
  const output =
    event.result === undefined ? "" : isShell ? stripExitNote(stripAnsi(event.result)) : stripAnsi(event.result);
  const cwd = event.cwd ? formatDisplayPath(event.cwd) : undefined;
  const showOut = running || output.length > 0;

  useLayoutEffect(() => {
    const el = outRef.current;
    if (running && el) el.scrollTop = el.scrollHeight;
  }, [running, output]);

  return (
    <div className={`io-card${failed ? " io-card--failed" : ""}`}>
      <div className="io-card__section">
        <span className="io-card__label">IN</span>
        <pre className="io-card__text">{event.summary || `(${event.name})`}</pre>
      </div>
      {showOut && (
        <>
          <div className="io-card__divider" />
          <div className="io-card__section">
            <span className="io-card__label">OUT</span>
            <pre className={`io-card__text${failed ? " io-card__text--error" : ""}`} ref={outRef}>
              {output.length > 0 ? truncateToolCard(output, TOOL_RESULT_UI_CAP) : "Running…"}
            </pre>
          </div>
        </>
      )}
      {(cwd || exitCode !== undefined || event.durationMs !== undefined || event.denied) && (
        <div className="io-card__meta">
          {cwd && <span className="io-card__cwd">{cwd}</span>}
          {event.denied && <span>denied</span>}
          {exitCode !== undefined && exitCode !== 0 && <span className="io-card__exit">exit {exitCode}</span>}
          {event.durationMs !== undefined && !running && <span>{formatDuration(event.durationMs)}</span>}
          {isShell && onOpenAgentTerminal && (
            <button type="button" className="io-card__term" title="Open in terminal" onClick={onOpenAgentTerminal}>
              <Icon name="terminal" size={11} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** One file mutation: icon, path, diff stats, and Review action. */
function FileCard({
  event,
  onOpenFile,
  onUndo,
  agentRunning,
  reverting,
}: {
  event: Extract<ThreadEvent, { kind: "file" }>;
  codeDisplay: ChatCodeDisplay;
  onOpenFile: (path: string) => void;
  onUndo: (path: string, checkpointId: string) => void;
  agentRunning?: boolean;
  reverting?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const snippet = event.snippet ?? [];
  const hasSnippet = snippet.length > 0;
  const openTarget = event.subtitle || event.name;
  const displayPath = event.subtitle ? `./${event.name}` : event.name;
  const isNew = event.adds > 0 && event.dels === 0;
  return (
    <FlatCard className="file-card">
      <div className="file-card__head">
        <span className={`file-card__icon ${isNew ? "file-card__icon--add" : "file-card__icon--edit"}`}>
          <Icon name={isNew ? "plus" : "pencil"} size={10} />
        </span>
        <button
          type="button"
          className={`file-card__path${hasSnippet ? " file-card__path--toggle" : ""}`}
          onClick={hasSnippet ? () => setOpen((v) => !v) : undefined}
          title={openTarget}
        >
          <span className="file-card__name">{displayPath}</span>
          {hasSnippet && <Icon name={open ? "chevronDown" : "chevronRight"} size={11} className="file-card__chevron" />}
        </button>
        {(event.adds > 0 || event.dels > 0) && (
          <span className="file-card__changes">
            {event.adds > 0 && <span className="adds">+{event.adds}</span>}
            {event.dels > 0 && <span className="dels">-{event.dels}</span>}
          </span>
        )}
        <button type="button" className="file-card__review" onClick={() => onOpenFile(openTarget)}>
          Review
        </button>
        {event.checkpointId && !agentRunning && (
          <button
            type="button"
            className="file-card__review"
            disabled={reverting}
            onClick={() => onUndo(openTarget, event.checkpointId!)}
            title={t("chat.undoFile")}
          >
            {reverting ? t("chat.revertInProgress") : t("chat.undoFile")}
          </button>
        )}
      </div>
      {hasSnippet && open && (
        <div className="file-card__diff">
          <table className="diff-table">
            <tbody>
              {snippet.map((line, i) => (
                <tr key={i} className={`diff-row diff-row--${line.type}`}>
                  <td className="diff-sign">{line.type === "add" ? "+" : line.type === "del" ? "-" : ""}</td>
                  <td className="diff-text">{line.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(event.snippetMore ?? 0) > 0 && (
            <button type="button" className="file-card__more" onClick={() => onOpenFile(openTarget)}>
              … {event.snippetMore} more changed lines
            </button>
          )}
        </div>
      )}
    </FlatCard>
  );
}

/** Strip ANSI CSI / OSC sequences so streamed shell output is readable in chat. */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "");
}

/** Trailing non-zero exit note appended by the bash tool / agent shell. */
const EXIT_NOTE_RE = /(?:^|\n)\(exit code (\d+)\)\s*$/;

/** Exit code of a finished shell call, undefined when zero or not a shell note. */
function shellExitCode(result: string | undefined, finished: boolean): number | undefined {
  if (!finished || result === undefined) return undefined;
  const code = Number(EXIT_NOTE_RE.exec(result)?.[1]);
  return Number.isFinite(code) ? code : undefined;
}

/** Drop the trailing "(exit code N)" note — it renders as a header badge instead. */
function stripExitNote(result: string): string {
  return result.replace(EXIT_NOTE_RE, "").replace(/\n+$/, "");
}

/** Subagent run card: avatar + name + status, task line with L-connector. */
function SubagentCard({
  event,
  onOpen,
}: {
  event: Extract<ThreadEvent, { kind: "subagent" }>;
  onOpen?: (id: string) => void;
}) {
  const running = event.status === "running";
  const failed = event.status === "failed";
  const done = event.status === "done";
  const statusLabel = running ? "In Progress" : failed ? "Failed" : done ? "Completed" : "Queued";
  const taskLine = subagentStatusLine(event);
  return (
    <button
      type="button"
      className={`subagent-card ${failed ? "subagent-card--failed" : ""} ${running ? "subagent-card--running" : ""}`}
      onClick={() => onOpen?.(event.id)}
      disabled={!onOpen}
      title={onOpen ? "Open this subagent in the Agent panel" : undefined}
    >
      <div className="subagent-card__header">
        <span className={`subagent-card__avatar ${running ? "subagent-card__avatar--live" : ""}`}>
          <Icon name={running ? "sparkles" : failed ? "close" : "check"} size={12} />
        </span>
        <span className="subagent-card__name">{subagentDisplayName(event.name)}</span>
        <span className={`subagent-card__status ${running ? "subagent-card__status--live" : done ? "subagent-card__status--done" : ""}`}>
          {statusLabel}
        </span>
      </div>
      {taskLine && (
        <div className="subagent-card__task">
          <span className="subagent-card__connector" aria-hidden />
          <span className="subagent-card__line">{taskLine}</span>
        </div>
      )}
    </button>
  );
}

/** Human-friendly duration: ms under a second, one decimal in seconds after. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** One agent tool call: status line expanding to the (truncated) result. */
function ToolCard({
  event,
  compact = false,
}: {
  event: Extract<ThreadEvent, { kind: "tool" }>;
  onOpenAgentTerminal?: () => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const resultRef = useRef<HTMLPreElement>(null);
  const wasRunningRef = useRef(false);
  const running = event.ok === undefined;
  const isShell = event.name === "bash";
  const hasOutput = event.result !== undefined && event.result.length > 0;
  const exitCode = isShell ? shellExitCode(event.result, !running) : undefined;
  const failed = event.ok === false || (exitCode !== undefined && exitCode !== 0);
  const displayName = toolDisplayName(event.name);
  const displayResult =
    event.result === undefined ? undefined : isShell ? stripExitNote(stripAnsi(event.result)) : stripAnsi(event.result);

  useLayoutEffect(() => {
    if (running && isShell && hasOutput) {
      setOpen(true);
      const el = resultRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    } else if (wasRunningRef.current && !running && isShell) {
      setOpen(false);
    }
    wasRunningRef.current = running;
  }, [running, isShell, hasOutput, event.result]);

  return (
    <div
      className={`tool-card ${open ? "tool-card--open" : ""} ${compact ? "tool-card--compact" : ""} ${failed ? "tool-card--failed" : ""} ${running ? "tool-card--running" : ""}`}
    >
      <button type="button" className="tool-card__row" onClick={() => setOpen((v) => !v)}>
        {!compact && <Icon name={running ? "clock" : failed ? "close" : "check"} size={12} />}
        <CodeTag>{displayName}</CodeTag>
        <span className="tool-card__summary">{event.summary}</span>
        {event.denied && <SeverityBadge level="low">denied</SeverityBadge>}
        {event.durationMs !== undefined && !compact && (
          <span className="tool-card__duration">{formatDuration(event.durationMs)}</span>
        )}
        {(hasOutput || !running) && event.result !== undefined && (
          <Icon name={open ? "chevronDown" : "chevronRight"} size={11} />
        )}
      </button>
      {open && displayResult !== undefined && displayResult.length > 0 && (
        <Callout mono className="tool-card__result-callout">
          <pre className="tool-card__result" ref={resultRef}>
            {truncateToolCard(displayResult, TOOL_RESULT_UI_CAP)}
          </pre>
        </Callout>
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
