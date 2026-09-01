/**
 * Event-sourced agent state with incremental event application.
 *
 * - Agent emits facts, UI renders them
 * - Per-tab state preservation (background tabs keep streaming)
 * - Stream-only updates skip full re-render (useSyncExternalStore)
 * - Text/reasoning deltas batched via requestAnimationFrame
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AgentEventEnvelope, ChatMode, ContextUsageSnapshot, DiffSnippetLine, ThreadEvent } from "@deyin/contract";
import { STEP_LIMIT_LABEL, TOOL_RESULT_UI_CAP, truncateToolResultUi } from "@deyin/contract";
import {
  isBetterPlanDoc,
  looksLikePlan,
  planFileNameFromTitle,
  planPreviewFromMarkdown,
  planTitleFromMarkdown,
} from "../threads.js";
import { diffSnippet, diffStats } from "../diff.js";
import { formatTokens } from "../formatTokens.js";

/* -------------------------------------------------------------------------- */
/* Discriminated message types for the run timeline                           */
/* -------------------------------------------------------------------------- */

export type AgentMessageKind = "user" | "assistant" | "tool" | "phase" | "notice";

export type AgentMessageItem =
  | { id: string; kind: "user"; content: string; timestamp: number }
  | { id: string; kind: "assistant"; content: string; timestamp: number }
  | { id: string; kind: "tool"; name: string; summary: string; result?: string; ok?: boolean; denied?: boolean; timestamp: number }
  | { id: string; kind: "phase"; label: string; timestamp: number }
  | { id: string; kind: "notice"; text: string; timestamp: number };

export type RunPhase = "idle" | "thinking" | "streaming" | "tool" | "waiting";

/** Max activity lines retained per subagent card (the Agent panel's log). */
const SUBAGENT_LOG_CAP = 200;

/** Short model name for status labels. */
function shortModelName(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/** Status label when the run routes to a different model role. */
function roleRoutingLabel(role: string, model: string): string {
  const name = shortModelName(model);
  switch (role) {
    case "tool":
      return `Reading (${name})`;
    case "plan":
      return `Planning (${name})`;
    case "ask":
      return `Asking (${name})`;
    case "delivery":
      return `Verifying (${name})`;
    default:
      return `Implementing (${name})`;
  }
}

export interface RunStatus {
  phase: RunPhase;
  label: string;
  retryCount: number;
  maxRetries: number;
  startedAt: number | null;
  workDurationMs: number;
}

export interface SessionTokenStats {
  inputCached: number;
  inputUncached: number;
  output: number;
  sessionTotal: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export interface ThreadRunSnapshot {
  threadId: string;
  mode: ChatMode;
  running: boolean;
  turnActive: boolean;
  runEvents: ThreadEvent[];
  streamText: string | null;
  streamReasoning: string | null;
  planStream: string | null;
  status: RunStatus;
  tokens: number;
  contextSnapshot: ContextUsageSnapshot | null;
}

export interface RunFoldResult {
  threadId: string;
  events: ThreadEvent[];
  planMarkdown: string | null;
  planFinished: boolean;
  tokens: number;
  optimization: Extract<ThreadEvent, { kind: "optimization" }> | null;
}

export type AgentSideEffect =
  | {
      type: "file-change";
      threadId: string;
      path: string;
      before: string;
      after: string;
      renderable: boolean;
      /** Run the edit belongs to — groups the change under one undo checkpoint. */
      checkpointId: string;
    }
  | { type: "pending-change"; threadId: string; change: import("@deyin/contract").PendingChange }
  | { type: "pending-change-resolved"; changeId: string }
  | { type: "goal-updated"; threadId: string; goal: import("@deyin/contract").ThreadGoal | null }
  | { type: "todos"; threadId: string; todos: import("@deyin/contract").AgentTodoItem[] }
  | { type: "permission-request"; threadId: string; requestId: string; toolName: string; summary: string }
  | {
      type: "mcp-auth-needed";
      threadId: string;
      requestId: string;
      moduleId: string;
      serverName: string;
      message?: string;
    }
  | {
      type: "question-request";
      threadId: string;
      requestId: string;
      title?: string;
      questions: Array<{
        id: string;
        prompt: string;
        allow_multiple?: boolean;
        options: Array<{ id: string; label: string; description?: string; recommended?: boolean }>;
      }>;
    }
  | { type: "plan-created"; threadId: string; name: string; overview?: string; plan: string; filePath?: string }
  | { type: "page-created"; threadId: string; title: string; fileName: string; filePath?: string; preview?: string }
  | { type: "plan-panel-open"; threadId: string }
  | { type: "page-panel-open"; threadId: string }
  | { type: "mode-changed"; threadId: string; mode: ChatMode }
  | { type: "shell-session"; threadId: string; terminalId: string; label: string }
  | {
      type: "evidence-sign-off";
      threadId: string;
      stepId: string;
      reviewNotes?: string;
    }
  | {
      type: "compaction-notice";
      threadId: string;
      message: string;
    }
  | {
      type: "cache-stats";
      threadId: string;
      patch: {
        hitRate: number;
        sessionHit: number;
        sessionMiss: number;
        prefixChanged?: boolean;
        changeReasons?: Array<"system" | "tools" | "log_rewrite">;
      };
    }
  | { type: "context-snapshot"; threadId: string; snapshot: ContextUsageSnapshot }
  | { type: "run-complete"; fold: RunFoldResult }
  | { type: "usage-record"; tokens: number };

/* -------------------------------------------------------------------------- */
/* Per-thread mutable run state (refs folded into the store)                  */
/* -------------------------------------------------------------------------- */

interface ThreadRunMutable {
  mode: ChatMode;
  /** Identity of the current run: the undo checkpoint its file edits belong to. */
  runId: string;
  runEvents: ThreadEvent[];
  streamText: string;
  streamReasoning: string;
  planStream: string | null;
  toolIndex: Map<string, number>;
  subagentIndex: Map<string, number>;
  planDoc: string;
  planArtifactShown: boolean;
  textBuffer: string;
  reasoningBuffer: string;
  reasoningStart: number;
  tokens: number;
  optimization: Extract<ThreadEvent, { kind: "optimization" }> | null;
  running: boolean;
  turnActive: boolean;
  status: RunStatus;
  contextSnapshot: ContextUsageSnapshot | null;
  rafScheduled: boolean;
  seq: number;
}

function emptyStatus(): RunStatus {
  return {
    phase: "idle",
    label: "",
    retryCount: 0,
    maxRetries: 3,
    startedAt: null,
    workDurationMs: 0,
  };
}

/** Unique id for a run's undo checkpoint (stamped on every file card it produces). */
function newCheckpointId(): string {
  return `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function freshThreadRun(mode: ChatMode = "agent"): ThreadRunMutable {
  return {
    mode,
    runId: newCheckpointId(),
    runEvents: [],
    streamText: "",
    streamReasoning: "",
    planStream: null,
    toolIndex: new Map(),
    subagentIndex: new Map(),
    planDoc: "",
    planArtifactShown: false,
    textBuffer: "",
    reasoningBuffer: "",
    reasoningStart: 0,
    tokens: 0,
    optimization: null,
    running: false,
    turnActive: false,
    status: emptyStatus(),
    contextSnapshot: null,
    rafScheduled: false,
    seq: 0,
  };
}

let nextMsgId = 0;
function _msgId(): string {
  nextMsgId += 1;
  return `msg-${nextMsgId}`;
}
void _msgId;

/* -------------------------------------------------------------------------- */
/* Global store — survives tab switches                                       */
/* -------------------------------------------------------------------------- */

class AgentStateStore {
  private threads = new Map<string, ThreadRunMutable>();
  private listeners = new Set<() => void>();
  private streamListeners = new Map<string, Set<() => void>>();
  private sessionStats: SessionTokenStats = {
    inputCached: 0,
    inputUncached: 0,
    output: 0,
    sessionTotal: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  };
  private ignoreNextDone = new Set<string>();
  private sideEffects: ((effect: AgentSideEffect) => void)[] = [];

  onSideEffect(cb: (effect: AgentSideEffect) => void): () => void {
    this.sideEffects.push(cb);
    return () => {
      this.sideEffects = this.sideEffects.filter((x) => x !== cb);
    };
  }

  private emit(effect: AgentSideEffect) {
    for (const cb of this.sideEffects) cb(effect);
  }

  private thread(threadId: string): ThreadRunMutable {
    let t = this.threads.get(threadId);
    if (!t) {
      t = freshThreadRun();
      this.threads.set(threadId, t);
    }
    return t;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeStream = (threadId: string, listener: () => void): (() => void) => {
    let set = this.streamListeners.get(threadId);
    if (!set) {
      set = new Set();
      this.streamListeners.set(threadId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.streamListeners.delete(threadId);
    };
  };

  private notifyStructural() {
    // Snapshots must stay referentially stable between notifications:
    // useSyncExternalStore compares by identity, so a fresh object per
    // getSnapshot() call reads as "store changed" on every check and loops
    // into React's max-update-depth crash. Drop caches whenever we notify.
    this.snapshotCache.clear();
    this.streamSnapCache.clear();
    this.sessionStatsCache = null;
    for (const l of this.listeners) l();
  }

  private notifyStream(threadId: string) {
    this.streamSnapCache.delete(threadId);
    const set = this.streamListeners.get(threadId);
    if (set) for (const l of set) l();
  }

  private snapshotCache = new Map<string, ThreadRunSnapshot>();
  private streamSnapCache = new Map<string, { streamText: string; streamReasoning: string; seq: number }>();
  private sessionStatsCache: SessionTokenStats | null = null;

  getSnapshot(threadId: string): ThreadRunSnapshot {
    const cached = this.snapshotCache.get(threadId);
    if (cached) return cached;
    const t = this.thread(threadId);
    const snap: ThreadRunSnapshot = {
      threadId,
      mode: t.mode,
      running: t.running,
      turnActive: t.turnActive,
      runEvents: t.runEvents,
      streamText: t.running ? t.streamText : null,
      streamReasoning: t.running ? t.streamReasoning : null,
      planStream: t.planStream,
      status: { ...t.status, workDurationMs: t.status.startedAt ? Date.now() - t.status.startedAt : 0 },
      tokens: t.tokens,
      contextSnapshot: t.contextSnapshot,
    };
    this.snapshotCache.set(threadId, snap);
    return snap;
  }

  getStreamSnapshot(threadId: string): { streamText: string; streamReasoning: string; seq: number } {
    const cached = this.streamSnapCache.get(threadId);
    if (cached) return cached;
    const t = this.thread(threadId);
    const snap = { streamText: t.streamText, streamReasoning: t.streamReasoning, seq: t.seq };
    this.streamSnapCache.set(threadId, snap);
    return snap;
  }

  getSessionStats(): SessionTokenStats {
    if (this.sessionStatsCache) return this.sessionStatsCache;
    const snap = { ...this.sessionStats };
    this.sessionStatsCache = snap;
    return snap;
  }

  startRun(threadId: string, mode: ChatMode): string {
    const t = freshThreadRun(mode);
    t.running = true;
    t.turnActive = true;
    t.status = {
      phase: "thinking",
      label: "Starting…",
      retryCount: 0,
      maxRetries: 3,
      startedAt: Date.now(),
      workDurationMs: 0,
    };
    this.threads.set(threadId, t);
    this.notifyStructural();
    this.notifyStream(threadId);
    return t.runId;
  }

  setIgnoreNextDone(threadId: string, ignore: boolean) {
    if (ignore) this.ignoreNextDone.add(threadId);
    else this.ignoreNextDone.delete(threadId);
  }

  clearRun(threadId: string) {
    const t = this.thread(threadId);
    t.running = false;
    t.turnActive = false;
    t.runEvents = [];
    t.streamText = "";
    t.streamReasoning = "";
    t.planStream = null;
    t.textBuffer = "";
    t.reasoningBuffer = "";
    t.status = emptyStatus();
    this.notifyStructural();
    this.notifyStream(threadId);
  }

  private scheduleRafFlush(threadId: string) {
    const t = this.thread(threadId);
    if (t.rafScheduled) return;
    t.rafScheduled = true;
    requestAnimationFrame(() => {
      t.rafScheduled = false;
      t.streamText = t.textBuffer;
      t.streamReasoning = t.reasoningBuffer;
      t.seq += 1;
      // Structural snapshots embed streamText/streamReasoning; drop the cached
      // copy so a later getSnapshot() rebuilds instead of serving stale text.
      this.snapshotCache.delete(threadId);
      this.notifyStream(threadId);
    });
  }

  private flushReasoning(t: ThreadRunMutable): void {
    const text = t.reasoningBuffer;
    if (text.trim().length === 0) return;
    const seconds = Math.max(1, Math.round((Date.now() - t.reasoningStart) / 1000));
    t.reasoningBuffer = "";
    t.streamReasoning = "";
    t.runEvents = [...t.runEvents, { kind: "reasoning", text, seconds }];
    t.status = { ...t.status, phase: "streaming", label: "Responding…" };
  }

  private flushText(t: ThreadRunMutable): void {
    this.flushReasoning(t);
    const text = t.textBuffer;
    t.textBuffer = "";
    t.streamText = "";
    if (t.mode === "plan") {
      if (looksLikePlan(text) && isBetterPlanDoc(text, t.planDoc)) {
        t.planDoc = text;
        t.planStream = t.planDoc || null;
        return;
      }
      t.planStream = t.planDoc || null;
      if (text.trim().length > 0) t.runEvents = [...t.runEvents, { kind: "assistant", text }];
      return;
    }
    t.planStream = null;
    if (text.trim().length > 0) t.runEvents = [...t.runEvents, { kind: "assistant", text }];
  }

  dispatch(envelope: AgentEventEnvelope): void {
    const { threadId, event, runId } = envelope;
    const t = this.thread(threadId);

    if (runId !== undefined && runId !== t.runId) return;

    if (event.type === "done" && !t.running && !this.ignoreNextDone.has(threadId)) return;

    switch (event.type) {
      case "reasoning-delta": {
        if (t.reasoningBuffer.length === 0) t.reasoningStart = Date.now();
        t.reasoningBuffer += event.delta;
        t.status = { ...t.status, phase: "thinking", label: "Thinking…" };
        this.scheduleRafFlush(threadId);
        break;
      }
      case "text-delta": {
        this.flushReasoning(t);
        const firstChunk = t.textBuffer.length === 0;
        t.textBuffer += event.delta;
        if (t.mode === "plan") {
          const live = t.textBuffer;
          if (looksLikePlan(live)) {
            // The model moved from prose to a plan document: reveal the Plan tab.
            if (firstChunk) this.emit({ type: "plan-panel-open", threadId });
            if (isBetterPlanDoc(live, t.planDoc)) t.planDoc = live;
            t.planStream = t.planDoc || null;
          } else {
            t.streamText = live;
          }
        }
        t.status = { ...t.status, phase: "streaming", label: "Responding…" };
        this.scheduleRafFlush(threadId);
        break;
      }
      case "tool-start": {
        this.flushText(t);
        t.toolIndex.set(event.callId, t.runEvents.length);
        t.runEvents = [
          ...t.runEvents,
          { kind: "tool", name: event.name, summary: event.summary, cwd: event.cwd, startedAt: Date.now() },
        ];
        t.status = { ...t.status, phase: "tool", label: `${event.name}…` };
        this.notifyStructural();
        break;
      }
      case "tool-delta": {
        const index = t.toolIndex.get(event.callId);
        if (index === undefined) break;
        const prev = t.runEvents[index];
        if (!prev || prev.kind !== "tool") break;
        let result = (prev.result ?? "") + event.delta;
        if (result.length > TOOL_RESULT_UI_CAP) result = truncateToolResultUi(result);
        const next = [...t.runEvents];
        next[index] = { ...prev, result };
        t.runEvents = next;
        this.notifyStructural();
        break;
      }
      case "tool-end": {
        const index = t.toolIndex.get(event.callId);
        if (index === undefined) break;
        const prev = t.runEvents[index];
        if (!prev || prev.kind !== "tool") break;
        const next = [...t.runEvents];
        next[index] = {
          ...prev,
          result: event.result,
          ok: event.ok,
          denied: event.denied,
          cwd: event.cwd ?? prev.cwd,
          durationMs: prev.startedAt !== undefined ? Date.now() - prev.startedAt : undefined,
        };
        t.runEvents = next;
        t.status = { ...t.status, phase: "waiting", label: "Processing…" };
        this.notifyStructural();
        break;
      }
      case "file-change": {
        const stats = diffStats(event.before, event.after);
        let snippet: { snippet?: DiffSnippetLine[]; snippetMore?: number } = {};
        if (stats.renderable) {
          const excerpt = diffSnippet(event.before, event.after);
          if (excerpt.lines.length > 0) snippet = { snippet: excerpt.lines, snippetMore: excerpt.more };
        }
        const name = event.path.split(/[\\/]/).pop() ?? event.path;
        t.runEvents = [
          ...t.runEvents,
          {
            kind: "file",
            name,
            subtitle: event.path,
            adds: stats.adds,
            dels: stats.dels,
            checkpointId: t.runId,
            ...snippet,
          },
        ];
        this.notifyStructural();
        this.emit({
          type: "file-change",
          threadId,
          path: event.path,
          before: event.before,
          after: event.after,
          renderable: stats.renderable,
          checkpointId: t.runId,
        });
        break;
      }
      case "pending-change":
        this.emit({ type: "pending-change", threadId, change: event.change });
        break;
      case "pending-change-resolved":
        this.emit({ type: "pending-change-resolved", changeId: event.changeId });
        break;
      case "goal-updated":
        this.emit({ type: "goal-updated", threadId, goal: event.goal });
        break;
      case "todos": {
        const steps = event.todos.map((todo) => ({
          text: todo.content,
          done: todo.status === "completed",
          status: todo.status,
          acceptanceCriteria: todo.acceptanceCriteria,
          signedOff: todo.signedOff,
        }));
        const index = t.runEvents.findIndex((e) => e.kind === "plan");
        if (index >= 0) {
          const next = [...t.runEvents];
          next[index] = { kind: "plan", steps };
          t.runEvents = next;
        } else {
          t.runEvents = [...t.runEvents, { kind: "plan", steps }];
        }
        this.notifyStructural();
        this.emit({ type: "todos", threadId, todos: event.todos });
        break;
      }
      case "evidence-gate":
        t.runEvents = [...t.runEvents, { kind: "evidence-gate", code: event.code, message: event.message }];
        this.notifyStructural();
        break;
      case "evidence-sign-off":
        t.runEvents = [
          ...t.runEvents,
          {
            kind: "evidence-sign-off",
            stepId: event.stepId,
            verificationCommand: event.verificationCommand,
            diffSummary: event.diffSummary,
            reviewNotes: event.reviewNotes,
          },
        ];
        this.notifyStructural();
        this.emit({ type: "evidence-sign-off", threadId, stepId: event.stepId, reviewNotes: event.reviewNotes });
        break;
      case "usage":
        t.tokens = event.totalTokens;
        this.sessionStats.output = event.totalTokens;
        this.sessionStats.sessionTotal += event.totalTokens;
        this.notifyStructural();
        break;
      case "model-routed":
        t.status = { ...t.status, label: roleRoutingLabel(event.role, event.model) };
        t.runEvents = [
          ...t.runEvents,
          { kind: "thought", label: `Routed to ${event.role} model: ${shortModelName(event.model)}` },
        ];
        this.notifyStructural();
        break;
      case "optimization": {
        t.optimization = {
          kind: "optimization",
          originalInputTokens: event.originalInputTokens,
          compressedInputTokens: event.compressedInputTokens,
          compressionRatio: event.compressionRatio,
          cachedPromptTokens: event.cachedPromptTokens,
          toolCacheHits: event.toolCacheHits,
          toolCacheMisses: event.toolCacheMisses,
          responseCacheHits: event.responseCacheHits,
          responseCacheMisses: event.responseCacheMisses,
          estimatedCostSavingsUsd: event.estimatedCostSavingsUsd,
          sessionCacheHit: event.sessionCacheHit,
          sessionCacheMiss: event.sessionCacheMiss,
          cacheHitRate: event.cacheHitRate,
          prefixChanged: event.prefixChanged,
          changeReasons: event.changeReasons,
        };
        this.sessionStats.inputCached += event.cachedPromptTokens;
        this.sessionStats.inputUncached += Math.max(0, event.compressedInputTokens - event.cachedPromptTokens);
        this.sessionStats.cacheHitTokens += event.cachedPromptTokens;
        this.sessionStats.cacheMissTokens += Math.max(0, event.originalInputTokens - event.cachedPromptTokens);
        this.notifyStructural();
        if (
          event.cacheHitRate !== undefined &&
          event.sessionCacheHit !== undefined &&
          event.sessionCacheMiss !== undefined
        ) {
          this.emit({
            type: "cache-stats",
            threadId,
            patch: {
              hitRate: event.cacheHitRate,
              sessionHit: event.sessionCacheHit,
              sessionMiss: event.sessionCacheMiss,
              prefixChanged: event.prefixChanged,
              changeReasons: event.changeReasons,
            },
          });
        }
        break;
      }
      case "context-snapshot":
        t.contextSnapshot = event.snapshot;
        this.notifyStructural();
        this.emit({ type: "context-snapshot", threadId, snapshot: event.snapshot });
        break;
      case "compaction": {
        if (event.kind === "notice") {
          this.emit({
            type: "compaction-notice",
            threadId,
            message: `Context is ${Math.round(event.ratio * 100)}% full. History will be compacted if it keeps growing.`,
          });
          break;
        }
        if (event.kind === "exhausted") {
          this.emit({
            type: "compaction-notice",
            threadId,
            message:
              "Context is full and cannot be reduced further — a single message is too large. Start a new thread or narrow the task.",
          });
          break;
        }

        this.emit({
          type: "compaction-notice",
          threadId,
          message:
            event.kind === "fold"
              ? `Context folded — ${formatTokens(event.reclaimedTokens)} reclaimed.`
              : `Context pruned — ${formatTokens(event.reclaimedTokens)} reclaimed.`,
        });

        // One row per compaction, not one per step. The old loop compacted on
        // every iteration and pushed an entry each time, which buried the
        // transcript under identical notices.
        const previous = t.runEvents.at(-1);
        const merged: ThreadEvent =
          previous?.kind === "compaction-notice"
            ? {
                kind: "compaction-notice",
                compaction: event.kind === "fold" ? "fold" : previous.compaction,
                truncatedToolResults: previous.truncatedToolResults + event.truncatedToolResults,
                truncatedToolArgs: previous.truncatedToolArgs + event.truncatedToolArgs,
                droppedMessages: previous.droppedMessages + event.droppedMessages,
                reclaimedTokens: previous.reclaimedTokens + event.reclaimedTokens,
                summary: event.summary ?? previous.summary,
              }
            : {
                kind: "compaction-notice",
                compaction: event.kind,
                truncatedToolResults: event.truncatedToolResults,
                truncatedToolArgs: event.truncatedToolArgs,
                droppedMessages: event.droppedMessages,
                reclaimedTokens: event.reclaimedTokens,
                summary: event.summary,
              };
        t.runEvents =
          previous?.kind === "compaction-notice"
            ? [...t.runEvents.slice(0, -1), merged]
            : [...t.runEvents, merged];
        this.notifyStructural();
        break;
      }
      case "permission-request":
        this.emit({
          type: "permission-request",
          threadId,
          requestId: event.requestId,
          toolName: event.toolName,
          summary: event.summary,
        });
        break;
      case "mcp-auth-needed":
        this.emit({
          type: "mcp-auth-needed",
          threadId,
          requestId: event.requestId,
          moduleId: event.moduleId,
          serverName: event.serverName,
          message: event.message,
        });
        break;
      case "question-request":
        this.emit({
          type: "question-request",
          threadId,
          requestId: event.requestId,
          title: event.title,
          questions: event.questions,
        });
        break;
      case "plan-created": {
        const planTitle = event.name || planTitleFromMarkdown(event.plan);
        t.planDoc = event.plan;
        t.planArtifactShown = true;
        t.planStream = event.plan;
        this.emit({ type: "plan-created", threadId, name: event.name, overview: event.overview, plan: event.plan, filePath: event.filePath });
        t.runEvents = [
          ...t.runEvents,
          {
            kind: "plan-ready",
            title: planTitle,
            fileName: planFileNameFromTitle(planTitle || "plan"),
            preview: planPreviewFromMarkdown(event.plan),
          },
        ];
        this.notifyStructural();
        break;
      }
      case "page-created": {
        this.emit({
          type: "page-created",
          threadId,
          title: event.title,
          fileName: event.fileName,
          filePath: event.filePath,
          preview: event.preview,
        });
        this.emit({ type: "page-panel-open", threadId });
        t.runEvents = [
          ...t.runEvents,
          {
            kind: "page-ready",
            title: event.title,
            fileName: event.fileName,
            preview: event.preview,
          },
        ];
        this.notifyStructural();
        break;
      }
      case "mode-changed":
        t.mode = event.mode;
        this.notifyStructural();
        this.emit({ type: "mode-changed", threadId, mode: event.mode });
        break;
      case "subagent-start":
        this.flushText(t);
        t.subagentIndex.set(event.id, t.runEvents.length);
        t.runEvents = [
          ...t.runEvents,
          { kind: "subagent", id: event.id, name: event.name, status: "running", prompt: event.prompt, lines: [] },
        ];
        t.status = { ...t.status, phase: "tool", label: `${event.name} running…` };
        this.notifyStructural();
        break;
      case "subagent-progress": {
        const index = t.subagentIndex.get(event.id);
        if (index === undefined) break;
        const prev = t.runEvents[index];
        if (!prev || prev.kind !== "subagent") break;
        const next = [...t.runEvents];
        // Keep the full activity log for the Agent panel, capped so a long run
        // cannot grow the thread state without bound.
        const lines = [...(prev.lines ?? []), event.line].slice(-SUBAGENT_LOG_CAP);
        next[index] = { ...prev, line: event.line, lines };
        t.runEvents = next;
        this.notifyStructural();
        break;
      }
      case "subagent-end": {
        const index = t.subagentIndex.get(event.id);
        if (index === undefined) {
          t.runEvents = [...t.runEvents, { kind: "thought", label: `Subagent ${event.name} ${event.ok ? "finished" : "failed"}` }];
          this.notifyStructural();
          break;
        }
        const prev = t.runEvents[index];
        if (prev && prev.kind === "subagent") {
          const next = [...t.runEvents];
          next[index] = {
            ...prev,
            status: event.ok ? "done" : "failed",
            ms: event.ms,
            line: event.summary ?? prev.line,
            report: event.report ?? event.summary ?? prev.report,
          };
          const actionCount = Math.max(1, (prev.lines ?? []).length);
          next.splice(index + 1, 0, { kind: "worked", actions: actionCount });
          t.runEvents = next;
        }
        this.notifyStructural();
        break;
      }
      case "shell-session":
        this.emit({ type: "shell-session", threadId, terminalId: event.terminalId, label: event.label });
        break;
      case "error":
        t.runEvents = [...t.runEvents, { kind: "error", text: event.message }];
        t.status = { ...t.status, phase: "idle", label: "Error" };
        this.notifyStructural();
        break;
      case "done": {
        if (this.ignoreNextDone.has(threadId)) {
          this.ignoreNextDone.delete(threadId);
          break;
        }
        const text = t.textBuffer.trim().length > 0 ? t.textBuffer : event.finalText;
        const reasoning = t.reasoningBuffer;
        const reasoningSeconds = Math.max(1, Math.round((Date.now() - t.reasoningStart) / 1000));
        t.textBuffer = "";
        t.reasoningBuffer = "";
        let planText = t.planDoc;
        if (t.mode === "plan" && looksLikePlan(text) && isBetterPlanDoc(text, planText)) planText = text;
        const planRun = t.mode === "plan" && planText.trim().length > 0 && looksLikePlan(planText);
        const planFinished = planRun && event.reason === "completed";
        const planTitle = planRun ? planTitleFromMarkdown(planText) : undefined;
        const finished: ThreadEvent[] = [...t.runEvents];
        if (reasoning.trim().length > 0) finished.push({ kind: "reasoning", text: reasoning, seconds: reasoningSeconds });
        if (text.trim().length > 0 && !planRun) finished.push({ kind: "assistant", text });
        if (planFinished && !t.planArtifactShown) {
          finished.push({
            kind: "plan-ready",
            title: planTitle,
            fileName: planFileNameFromTitle(planTitle ?? "plan"),
            preview: planPreviewFromMarkdown(planText),
          });
        }
        if (event.reason === "aborted") finished.push({ kind: "thought", label: "Run stopped" });
        if (event.reason === "max-steps") finished.push({ kind: "thought", label: STEP_LIMIT_LABEL });
        const opt = t.optimization;
        if (
          opt &&
          (opt.originalInputTokens > opt.compressedInputTokens ||
            opt.cachedPromptTokens > 0 ||
            opt.toolCacheHits > 0 ||
            opt.responseCacheHits > 0 ||
            (opt.cacheHitRate ?? 0) > 0)
        ) {
          finished.push(opt);
        }
        const tokens = t.tokens;
        this.emit({
          type: "run-complete",
          fold: {
            threadId,
            events: finished,
            planMarkdown: planRun ? planText : null,
            planFinished,
            tokens,
            optimization: opt,
          },
        });
        this.emit({ type: "usage-record", tokens });
        t.running = false;
        t.turnActive = false;
        t.runEvents = [];
        t.streamText = "";
        t.streamReasoning = "";
        t.planStream = null;
        t.toolIndex.clear();
        t.subagentIndex.clear();
        t.planDoc = "";
        t.planArtifactShown = false;
        t.optimization = null;
        t.tokens = 0;
        t.status = emptyStatus();
        this.notifyStructural();
        this.notifyStream(threadId);
        break;
      }
    }
  }

  /** Force-fold a run (stop watchdog path). */
  forceStop(threadId: string): ThreadEvent[] {
    const t = this.thread(threadId);
    const finished = [...t.runEvents, { kind: "thought" as const, label: "Run stopped" }];
    t.running = false;
    t.turnActive = false;
    t.runEvents = [];
    t.streamText = "";
    t.streamReasoning = "";
    t.planStream = null;
    t.textBuffer = "";
    t.reasoningBuffer = "";
    t.toolIndex.clear();
    t.subagentIndex.clear();
    t.optimization = null;
    t.status = emptyStatus();
    this.notifyStructural();
    this.notifyStream(threadId);
    return finished;
  }

  isRunning(threadId: string): boolean {
    return this.thread(threadId).running;
  }

  anyRunning(): string | null {
    for (const [id, t] of this.threads) {
      if (t.running) return id;
    }
    return null;
  }

  getPlanStream(threadId: string): string | null {
    return this.thread(threadId).planStream;
  }

  shouldOpenPlanPanel(threadId: string, delta: string): boolean {
    const t = this.thread(threadId);
    if (t.mode !== "plan") return false;
    const live = t.textBuffer + delta;
    return looksLikePlan(live) && live === delta;
  }
}

export const agentStateStore = new AgentStateStore();

/* -------------------------------------------------------------------------- */
/* React hooks                                                                */
/* -------------------------------------------------------------------------- */

export function useAgentRunState(threadId: string | null): ThreadRunSnapshot | null {
  return useSyncExternalStore(
    agentStateStore.subscribe,
    () => (threadId ? agentStateStore.getSnapshot(threadId) : null),
    () => null,
  );
}

/** Stream-only subscription — re-renders on RAF text/reasoning batches only. */
export function useAgentStream(threadId: string | null): { streamText: string; streamReasoning: string } {
  const snap = useSyncExternalStore(
    (cb) => (threadId ? agentStateStore.subscribeStream(threadId, cb) : () => undefined),
    () => (threadId ? agentStateStore.getStreamSnapshot(threadId) : { streamText: "", streamReasoning: "", seq: 0 }),
    () => ({ streamText: "", streamReasoning: "", seq: 0 }),
  );
  return { streamText: snap.streamText, streamReasoning: snap.streamReasoning };
}

export function useSessionTokenStats(): SessionTokenStats {
  return useSyncExternalStore(
    agentStateStore.subscribe,
    () => agentStateStore.getSessionStats(),
    () => agentStateStore.getSessionStats(),
  );
}

export function useRunningThreadId(): string | null {
  return useSyncExternalStore(
    agentStateStore.subscribe,
    () => agentStateStore.anyRunning(),
    () => null,
  );
}

export interface UseAgentStateControllerOptions {
  onSideEffect?: (effect: AgentSideEffect) => void;
}

/** Subscribe to IPC agent events and wire the global store. */
export function useAgentStateController(options: UseAgentStateControllerOptions = {}) {
  const { onSideEffect } = options;

  useEffect(() => {
    if (!onSideEffect) return;
    return agentStateStore.onSideEffect(onSideEffect);
  }, [onSideEffect]);

  useEffect(() => {
    if (!window.deyin.agent) return;
    return window.deyin.agent.onEvent((envelope: AgentEventEnvelope) => {
      agentStateStore.dispatch(envelope);
    });
  }, []);

  const startRun = useCallback((threadId: string, mode: ChatMode) => {
    agentStateStore.startRun(threadId, mode);
  }, []);

  const clearRun = useCallback((threadId: string) => {
    agentStateStore.clearRun(threadId);
  }, []);

  const forceStop = useCallback((threadId: string) => {
    return agentStateStore.forceStop(threadId);
  }, []);

  const setIgnoreNextDone = useCallback((threadId: string, ignore: boolean) => {
    agentStateStore.setIgnoreNextDone(threadId, ignore);
  }, []);

  const dispatch = useCallback((envelope: AgentEventEnvelope) => {
    agentStateStore.dispatch(envelope);
  }, []);

  return {
    startRun,
    clearRun,
    forceStop,
    setIgnoreNextDone,
    dispatch,
    store: agentStateStore,
  };
}

/** @deprecated Use useAgentRunState — kept for plan compatibility. */
export function useAgentState(threadId: string) {
  const snap = useAgentRunState(threadId);
  return {
    items: [] as AgentMessageItem[],
    running: snap?.running ?? false,
    turnActive: snap?.turnActive ?? false,
  };
}

/* -------------------------------------------------------------------------- */
/* Test helpers                                                               */
/* -------------------------------------------------------------------------- */

export function __testResetAgentStore() {
  agentStateStore["threads"] = new Map();
  agentStateStore["sessionStats"] = {
    inputCached: 0,
    inputUncached: 0,
    output: 0,
    sessionTotal: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  };
}

export function __testDispatch(envelope: AgentEventEnvelope) {
  agentStateStore.dispatch(envelope);
}

export function __testFlushRaf(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export function __testGetThreadState(threadId: string): ThreadRunSnapshot {
  return agentStateStore.getSnapshot(threadId);
}
