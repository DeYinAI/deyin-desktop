/**
 * Event-sourced agent state inspired by Deyin agent useController.
 *
 * - Agent emits facts, UI renders them
 * - Per-tab state preservation (background tabs keep streaming)
 * - Stream-only updates skip full re-render (useSyncExternalStore)
 * - Text/reasoning deltas batched via requestAnimationFrame
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AgentEventEnvelope, ChatMode, ContextUsageSnapshot, ThreadEvent } from "../../shared/types.js";
import { TOOL_RESULT_UI_CAP, truncateToolResultUi } from "../../shared/types.js";
import { isBetterPlanDoc, looksLikePlan } from "../threads.js";

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
  | { type: "file-change"; path: string; before: string; after: string }
  | { type: "pending-change"; change: import("../../shared/types.js").PendingChange }
  | { type: "pending-change-resolved"; changeId: string }
  | { type: "goal-updated"; goal: import("../../shared/types.js").ThreadGoal | null }
  | { type: "todos"; todos: import("../../shared/types.js").AgentTodoItem[] }
  | { type: "permission-request"; requestId: string; toolName: string; summary: string }
  | {
      type: "question-request";
      requestId: string;
      title?: string;
      questions: Array<{
        id: string;
        prompt: string;
        allow_multiple?: boolean;
        options: Array<{ id: string; label: string }>;
      }>;
    }
  | { type: "plan-created"; name: string; overview?: string; plan: string; filePath?: string }
  | { type: "mode-changed"; mode: ChatMode }
  | { type: "shell-session"; terminalId: string; label: string }
  | { type: "run-complete"; fold: RunFoldResult }
  | { type: "usage-record"; tokens: number };

/* -------------------------------------------------------------------------- */
/* Per-thread mutable run state (refs folded into the store)                  */
/* -------------------------------------------------------------------------- */

interface ThreadRunMutable {
  mode: ChatMode;
  runEvents: ThreadEvent[];
  streamText: string;
  streamReasoning: string;
  planStream: string | null;
  toolIndex: Map<string, number>;
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

function freshThreadRun(mode: ChatMode = "agent"): ThreadRunMutable {
  return {
    mode,
    runEvents: [],
    streamText: "",
    streamReasoning: "",
    planStream: null,
    toolIndex: new Map(),
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
    for (const l of this.listeners) l();
  }

  private notifyStream(threadId: string) {
    const set = this.streamListeners.get(threadId);
    if (set) for (const l of set) l();
  }

  getSnapshot(threadId: string): ThreadRunSnapshot {
    const t = this.thread(threadId);
    return {
      threadId,
      running: t.running,
      turnActive: t.turnActive,
      runEvents: t.runEvents,
      streamText: t.running && t.streamText.length > 0 ? t.streamText : t.running ? t.streamText : null,
      streamReasoning: t.running && t.streamReasoning.length > 0 ? t.streamReasoning : t.running ? t.streamReasoning : null,
      planStream: t.planStream,
      status: { ...t.status, workDurationMs: t.status.startedAt ? Date.now() - t.status.startedAt : 0 },
      tokens: t.tokens,
      contextSnapshot: t.contextSnapshot,
    };
  }

  getStreamSnapshot(threadId: string): { streamText: string; streamReasoning: string; seq: number } {
    const t = this.thread(threadId);
    return { streamText: t.streamText, streamReasoning: t.streamReasoning, seq: t.seq };
  }

  getSessionStats(): SessionTokenStats {
    return { ...this.sessionStats };
  }

  startRun(threadId: string, mode: ChatMode) {
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
    const { threadId, event } = envelope;
    const t = this.thread(threadId);

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
        t.textBuffer += event.delta;
        if (t.mode === "plan") {
          const live = t.textBuffer;
          if (looksLikePlan(live)) {
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
        t.runEvents = [...t.runEvents, { kind: "tool", name: event.name, summary: event.summary }];
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
        next[index] = { ...prev, result: event.result, ok: event.ok, denied: event.denied };
        t.runEvents = next;
        t.status = { ...t.status, phase: "waiting", label: "Processing…" };
        this.notifyStructural();
        break;
      }
      case "file-change":
        this.emit({ type: "file-change", path: event.path, before: event.before, after: event.after });
        break;
      case "pending-change":
        this.emit({ type: "pending-change", change: event.change });
        break;
      case "pending-change-resolved":
        this.emit({ type: "pending-change-resolved", changeId: event.changeId });
        break;
      case "goal-updated":
        this.emit({ type: "goal-updated", goal: event.goal });
        break;
      case "todos":
        this.emit({ type: "todos", todos: event.todos });
        break;
      case "usage":
        t.tokens = event.totalTokens;
        this.sessionStats.output = event.totalTokens;
        this.sessionStats.sessionTotal += event.totalTokens;
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
        };
        this.sessionStats.inputCached += event.cachedPromptTokens;
        this.sessionStats.inputUncached += Math.max(0, event.compressedInputTokens - event.cachedPromptTokens);
        this.sessionStats.cacheHitTokens += event.cachedPromptTokens;
        this.sessionStats.cacheMissTokens += Math.max(0, event.originalInputTokens - event.cachedPromptTokens);
        this.notifyStructural();
        break;
      }
      case "context-snapshot":
        t.contextSnapshot = event.snapshot;
        this.notifyStructural();
        break;
      case "permission-request":
        this.emit({ type: "permission-request", requestId: event.requestId, toolName: event.toolName, summary: event.summary });
        break;
      case "question-request":
        this.emit({
          type: "question-request",
          requestId: event.requestId,
          title: event.title,
          questions: event.questions,
        });
        break;
      case "plan-created":
        t.planDoc = event.plan;
        t.planArtifactShown = true;
        t.planStream = event.plan;
        this.emit({ type: "plan-created", name: event.name, overview: event.overview, plan: event.plan, filePath: event.filePath });
        t.runEvents = [
          ...t.runEvents,
          {
            kind: "plan-ready",
            title: event.name,
            fileName: event.name ? `${event.name.replace(/\s+/g, "-").toLowerCase()}.md` : "plan.md",
          },
        ];
        this.notifyStructural();
        break;
      case "mode-changed":
        this.emit({ type: "mode-changed", mode: event.mode });
        break;
      case "subagent-start":
        this.flushText(t);
        t.runEvents = [...t.runEvents, { kind: "thought", label: `Subagent ${event.name} started` }];
        this.notifyStructural();
        break;
      case "subagent-end":
        t.runEvents = [...t.runEvents, { kind: "thought", label: `Subagent ${event.name} ${event.ok ? "finished" : "failed"}` }];
        this.notifyStructural();
        break;
      case "shell-session":
        this.emit({ type: "shell-session", terminalId: event.terminalId, label: event.label });
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
        const finished: ThreadEvent[] = [...t.runEvents];
        if (reasoning.trim().length > 0) finished.push({ kind: "reasoning", text: reasoning, seconds: reasoningSeconds });
        if (text.trim().length > 0 && !planRun) finished.push({ kind: "assistant", text });
        if (planFinished && !t.planArtifactShown) {
          finished.push({ kind: "plan-ready", title: undefined, fileName: "plan.md" });
        }
        if (event.reason === "aborted") finished.push({ kind: "thought", label: "Run stopped" });
        if (event.reason === "max-steps") finished.push({ kind: "thought", label: "Stopped after reaching the step limit" });
        const opt = t.optimization;
        if (opt && (opt.originalInputTokens > opt.compressedInputTokens || opt.cachedPromptTokens > 0 || opt.toolCacheHits > 0 || opt.responseCacheHits > 0)) {
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
