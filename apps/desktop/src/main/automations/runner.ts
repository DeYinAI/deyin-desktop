import { existsSync } from "node:fs";
import { SURFACE_LIMITS, resolveLimits } from "@deyin/host-core";
import type {
  Automation,
  AutomationResource,
  AutomationRun,
  AutomationsStore,
  AutomationRunsStore,
} from "@deyin/host-core";
import type { AgentUiEvent } from "@deyin/contract";
import type { AuthManager } from "../auth.js";
import { credentialProbe, type AgentRunContextDeps } from "./agent-run-context.js";
import type { LocalRunResult } from "./local-executor.js";
import { browserReadiness, resourcesOf } from "./consent.js";
import { resolvePayload, type ResolvedPayload } from "./payload.js";
import { resolveRunOutcome } from "./outcome.js";
import { TRANSIENT_RETRY_BACKOFF_MS, classifyError, preflight } from "./health.js";
import { sleep, supervise, systemClock, type Clock, type Supervision } from "./watchdog.js";

const GLOBAL_CONCURRENCY = 2;

/** The reason on the history row of a tick that found the previous run still going. */
export const SKIPPED_OVERLAP = "skipped: previous run still active";

/**
 * What a surface hands to a routine for one run: the message, put after the routine's own instructions. A run with
 * input is its own run: it is never merged with one already going, and it waits its turn rather than being skipped.
 */
export interface RunInput {
  text: string;
}

/** A routine already has as many messages waiting as it will hold. */
export class RoutineBusyError extends Error {
  constructor() {
    super(`This routine already has ${SURFACE_LIMITS.queued} messages waiting.`);
  }
}

/** What a run needs from the runner to do its work and be held to its limits. */
export interface RunContext extends Supervision {
  startedAt: number;
  limits: ReturnType<typeof resolveLimits>;
  emit: (event: AgentUiEvent) => void;
}

/** Runs an automation on its target. Throws if it cannot start; otherwise returns how the run ended. */
export type RunExecutor = (automation: Automation, resolved: ResolvedPayload, token: string, ctx: RunContext) => Promise<LocalRunResult>;

/** Seams for tests: the clock the limits are measured on, and how often and how patiently they are enforced. */
export interface AutomationRunnerOptions {
  clock?: Clock;
  /** Whether a local workspace folder exists; defaults to the filesystem. */
  workspaceExists?: (path: string) => boolean;
  tickMs?: number;
  graceMs?: number;
  /**
   * Last check before a run begins. A string refuses the run, and is written to its history row; the run
   * ends as skipped (not failed), so it neither notifies nor counts against the automation's health.
   */
  admit?: (automation: Automation, now: number) => string | null;
}

export interface AutomationRunnerCallbacks {
  onRunEvent: (runId: string, event: AgentUiEvent) => void;
  onRunFinished: (run: AutomationRun) => void;
  /** Runs an automation on its target; injected so the runner needs no Electron. */
  execute: RunExecutor;
  /** Tells the user a run ended badly or finished. Optional: absent in tests. */
  notify?: (automation: Automation, run: AutomationRun) => void;
}

interface QueueEntry {
  automationId: string;
  scheduledAt: number;
  runId?: string;
  /** Waits for the automation to be free instead of being dropped when it is busy. */
  input?: true;
}

export class AutomationRunner {
  private readonly activeByRun = new Map<string, AbortController>();
  /** Why a run was told to stop, so the history says "stopped" for a user and "app-quit" for a quit. */
  private readonly stopReasons = new Map<string, string>();
  /** Per-automation concurrency lock: an automationId is in here iff a run is active. */
  private readonly activeAutomations = new Set<string>();
  private activeCount = 0;
  private readonly queue: QueueEntry[] = [];
  /**
   * Resources a run holds alone, and which automation holds them. Two runs steering the same Chrome would fight
   * over its tabs and focus, so the second waits in the queue rather than start beside the first.
   */
  private readonly heldResources = new Map<AutomationResource, string>();
  /** The message each run with input was started for, until the run ends. */
  private readonly inputs = new Map<string, RunInput>();

  constructor(
    private readonly automations: AutomationsStore,
    private readonly runs: AutomationRunsStore,
    private readonly deps: AgentRunContextDeps,
    private readonly auth: AuthManager,
    private readonly callbacks: AutomationRunnerCallbacks,
    private readonly options: AutomationRunnerOptions = {},
  ) {}

  runNow(automationId: string, input?: RunInput): AutomationRun {
    const automation = this.automations.get(automationId);
    if (!automation) throw new Error("Automation not found.");
    if (input) return this.runWithInput(automation, input);
    // Dedupe against started and merely-queued runs (queue entries are not in activeByAutomation).
    const existing = this.runs.list(automationId).find((r) => r.status === "running" || r.status === "queued");
    if (existing) return existing;
    const queued = this.queue.find((q) => q.automationId === automationId);
    if (queued?.runId) {
      const fromQueue = this.runs.get(queued.runId);
      if (fromQueue) return fromQueue;
    }
    const run = this.runs.create(automationId); // status: queued
    if (this.activeCount >= GLOBAL_CONCURRENCY || this.resourceBusy(automation)) {
      this.queue.push({ automationId, scheduledAt: Date.now(), runId: run.id });
      return run;
    }
    void this.start(automation, Date.now(), run.id);
    return run;
  }

  /** A message for a routine: a run of its own, started now if the routine is free and queued behind the others if not. */
  private runWithInput(automation: Automation, input: RunInput): AutomationRun {
    const waiting = this.queue.filter((entry) => entry.automationId === automation.id && entry.input).length;
    if (waiting >= SURFACE_LIMITS.queued) throw new RoutineBusyError();
    const run = this.runs.create(automation.id);
    this.inputs.set(run.id, input);
    const mustWait =
      this.activeAutomations.has(automation.id) ||
      this.queue.some((entry) => entry.automationId === automation.id) ||
      this.activeCount >= GLOBAL_CONCURRENCY ||
      this.resourceBusy(automation);
    if (mustWait) {
      this.queue.push({ automationId: automation.id, scheduledAt: Date.now(), runId: run.id, input: true });
      return run;
    }
    void this.start(automation, Date.now(), run.id);
    return run;
  }

  runScheduled(automationId: string, scheduledAt: number): void {
    if (this.activeAutomations.has(automationId)) {
      this.recordSkippedTick(automationId);
      return;
    }
    if (this.queue.some((q) => q.automationId === automationId)) return;

    const automation = this.automations.get(automationId);
    if (!automation || !automation.enabled) return;

    // Claim lastScheduledAt in start() once the run actually begins — not while
    // merely queued — so a crash mid-queue still allows catch-up.
    if (this.activeCount >= GLOBAL_CONCURRENCY || this.resourceBusy(automation)) {
      const run = this.runs.create(automationId);
      this.queue.push({ automationId, scheduledAt, runId: run.id });
      return;
    }
    void this.start(automation, scheduledAt);
  }

  stop(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;

    // Queued but not started: remove from queue and mark aborted.
    const qi = this.queue.findIndex((q) => q.runId === runId);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.inputs.delete(runId);
      const finished = this.runs.finish(runId, "aborted", { reason: "stopped" });
      if (finished) this.callbacks.onRunFinished(finished);
      return;
    }

    if (run.status === "queued") {
      const finished = this.runs.finish(runId, "aborted", { reason: "stopped" });
      if (finished) this.callbacks.onRunFinished(finished);
      return;
    }

    const controller = this.activeByRun.get(runId);
    if (controller) this.stopReasons.set(runId, "stopped");
    controller?.abort();
  }

  /**
   * A tick that arrives while the previous run is still going used to vanish. It gets a history row
   * instead — one per live run, so a stuck run does not bury its own history in identical rows.
   */
  private recordSkippedTick(automationId: string): void {
    const history = this.runs.list(automationId);
    const live = history.find((r) => r.status === "running");
    const alreadyNoted = history.some((r) => r.reason === SKIPPED_OVERLAP && (!live || r.startedAt >= live.startedAt));
    if (alreadyNoted) return;
    const row = this.runs.create(automationId);
    const finished = this.runs.finish(row.id, "aborted", { reason: SKIPPED_OVERLAP });
    if (finished) this.callbacks.onRunFinished(finished);
  }

  /** Abort every in-flight and queued run (app quit). */
  dispose(): void {
    for (const entry of [...this.queue]) {
      if (entry.runId) {
        this.runs.finish(entry.runId, "aborted", { reason: "app-quit" });
        this.inputs.delete(entry.runId);
      }
    }
    this.queue.length = 0;
    for (const [runId, controller] of this.activeByRun) {
      this.stopReasons.set(runId, "app-quit");
      controller.abort();
    }
  }

  /** Whether a run of this automation would need a resource another automation's run is holding. */
  private resourceBusy(automation: Automation): boolean {
    return resourcesOf(automation).some((resource) => {
      const holder = this.heldResources.get(resource);
      return holder !== undefined && holder !== automation.id;
    });
  }

  private drainQueue(): void {
    // Entries waiting on a resource stay put; the ones behind them may still start.
    for (let i = 0; i < this.queue.length && this.activeCount < GLOBAL_CONCURRENCY; ) {
      const next = this.queue[i];
      if (!next) break;
      const automation = this.automations.get(next.automationId);
      const overlapping = this.activeAutomations.has(next.automationId);
      // A message waits for the routine to be free; any other entry that finds it busy was a tick that missed its turn.
      if (!automation || !automation.enabled || (overlapping && !next.input)) {
        this.queue.splice(i, 1);
        if (next.runId) {
          this.inputs.delete(next.runId);
          const finished = this.runs.finish(next.runId, "aborted", { reason: "skipped" });
          if (finished) this.callbacks.onRunFinished(finished);
        }
        continue;
      }
      if (overlapping || this.resourceBusy(automation)) {
        i += 1;
        continue;
      }
      this.queue.splice(i, 1);
      void this.start(automation, next.scheduledAt, next.runId);
    }
  }

  private async start(automation: Automation, scheduledAt: number, existingRunId?: string): Promise<void> {
    const controller = new AbortController();
    this.activeCount += 1;
    this.activeAutomations.add(automation.id);
    const held = resourcesOf(automation);
    for (const resource of held) this.heldResources.set(resource, automation.id);

    const run = existingRunId
      ? (this.runs.get(existingRunId) ?? this.runs.create(automation.id))
      : this.runs.create(automation.id);
    this.activeByRun.set(run.id, controller);
    this.runs.setStatus(run.id, "running");

    // Claim cron slot as soon as execution begins (before auth/host checks) so
    // failures do not retry-loop, but queued-then-crash still catch-up.
    const input = this.inputs.get(run.id);
    // A message is not the schedule's turn, so it does not use up the slot a cron tick or catch-up is waiting for.
    if (!input && (automation.trigger.kind === "cron" || automation.trigger.kind === "once")) {
      this.automations.setLastScheduledAt(automation.id, scheduledAt);
    }

    const clock = this.options.clock ?? systemClock;
    const startedAt = clock.now();
    const limits = resolveLimits(automation);
    const refusal = this.options.admit?.(automation, startedAt) ?? null;
    /** Once a run is finished its history is closed, even if an abandoned executor is still talking. */
    let closed = false;
    /** Only a prompt run on this machine is given `automation_report`; set once the payload is resolved. */
    let reportable = false;

    const emit = (event: AgentUiEvent): void => {
      if (closed) return;
      this.runs.appendEvent(run.id, event);
      this.callbacks.onRunEvent(run.id, event);
    };

    const finish = (status: "completed" | "failed" | "aborted", details: Parameters<AutomationRunsStore["finish"]>[2]): void => {
      closed = true;
      const finished = this.runs.finish(run.id, status, details);
      if (!finished) return;
      if (status !== "aborted") this.notifyComplete(automation, finished);
      this.callbacks.onRunFinished(finished);
    };

    try {
      if (refusal) {
        emit({ type: "error", message: refusal });
        finish("aborted", { reason: refusal });
        return;
      }
      // Everything that can be known without a model: signed in (after one retry), workspace present.
      const pre = await preflight(automation, {
        ...credentialProbe({ agents: this.deps.agents, auth: this.auth }, automation),
        workspaceExists: this.options.workspaceExists ?? existsSync,
        sleep: (ms) => sleep(clock, ms, controller.signal),
        browser: () => browserReadiness(this.deps.chrome),
      });
      if (!pre.ok) {
        emit({ type: "error", message: pre.blocker.detail });
        finish("failed", { reason: pre.blocker.kind === "auth" ? "auth" : `blocked: ${pre.blocker.kind}`, outcome: "blocked", blocker: pre.blocker });
        return;
      }
      const token = pre.token;

      // Skills and subagents resolve against the live registry here, so a
      // renamed or disabled capability fails the run with a clear message
      // instead of sending placeholder text to the model.
      const caps = await this.deps.capabilities.enabledForRun();
      let resolved: ResolvedPayload;
      try {
        resolved = resolvePayload(automation.payload, {
          skills: caps.skills,
          subagents: caps.subagents,
          canDelegateInProcess: automation.target.kind === "local",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: "error", message });
        finish("failed", { reason: message, outcome: "failed" });
        return;
      }

      reportable = automation.target.kind === "local" && !resolved.subagent;
      // The routine's own instructions come first and the message after them, so the message cannot reorder them.
      if (input) resolved = { ...resolved, prompt: `${resolved.prompt}\n\n${input.text}` };

      const supervised = await supervise({
        limits: { maxMs: limits.maxMinutes * 60_000, idleMs: limits.idleMinutes * 60_000 },
        signal: controller.signal,
        clock,
        tickMs: this.options.tickMs,
        graceMs: this.options.graceMs,
        run: (supervision) =>
          this.executeWithRetry(automation, resolved, token, clock, {
            ...supervision,
            startedAt,
            limits,
            emit: (event) => {
              supervision.touch();
              emit(event);
            },
          }),
      });

      if (supervised.tripped === "timeout") {
        emit({ type: "error", message: `Stopped: the run used up its ${limits.maxMinutes}-minute limit.` });
      } else if (supervised.tripped === "stalled") {
        emit({ type: "error", message: `Stopped: no progress for ${limits.idleMinutes} minutes.` });
      }
      if (supervised.abandoned) {
        emit({ type: "error", message: "The run did not stop when asked, so it was left behind and its slot freed." });
      }
      if (!supervised.value) emit({ type: "done", reason: "aborted", finalText: "" });

      const resolvedRun = resolveRunOutcome({
        exec: supervised.value,
        report: supervised.value?.report,
        reportable,
        tripped: supervised.tripped,
        stopReason: this.stopReasons.get(run.id),
      });
      finish(resolvedRun.status, {
        reason: resolvedRun.reason,
        // What the Bot said back is its report, not the report with whatever it said after it.
        finalText: input ? (supervised.value?.report?.summary ?? resolvedRun.finalText) : resolvedRun.finalText,
        outcome: resolvedRun.outcome,
        blocker: resolvedRun.blocker,
        artifacts: resolvedRun.artifacts,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message });
      emit({ type: "done", reason: "aborted", finalText: "" });
      const failed = resolveRunOutcome({ error: message, reportable });
      finish(failed.status, { reason: failed.reason, outcome: failed.outcome, blocker: failed.blocker });
    } finally {
      this.inputs.delete(run.id);
      this.activeByRun.delete(run.id);
      this.stopReasons.delete(run.id);
      this.activeAutomations.delete(automation.id);
      for (const resource of held) if (this.heldResources.get(resource) === automation.id) this.heldResources.delete(resource);
      this.activeCount -= 1;
      this.drainQueue();
    }
  }

  /**
   * A run that fails to start because of a hiccup (the API briefly down, a dropped connection) gets
   * up to two more tries in the same slot — but only while it has done nothing yet. Once a tool has
   * run, retrying could post twice or write twice, so the failure stands.
   */
  private async executeWithRetry(
    automation: Automation,
    resolved: ResolvedPayload,
    token: string,
    clock: Clock,
    ctx: RunContext,
  ): Promise<LocalRunResult> {
    for (let attempt = 0; ; attempt += 1) {
      let acted = false;
      try {
        return await this.callbacks.execute(automation, resolved, token, {
          ...ctx,
          emit: (event) => {
            if (event.type === "tool-start") acted = true;
            ctx.emit(event);
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const delay = TRANSIENT_RETRY_BACKOFF_MS[attempt];
        if (!classifyError(message).transient || acted || delay === undefined || ctx.signal.aborted) throw err;
        ctx.emit({ type: "error", message: `Temporary failure before any work was done (${message.slice(0, 160)}). Trying again in ${Math.round(delay / 1000)}s.` });
        await sleep(clock, delay, ctx.signal);
        if (ctx.signal.aborted) throw err;
      }
    }
  }

  private notifyComplete(automation: Automation, run: AutomationRun): void {
    this.callbacks.notify?.(automation, run);
  }
}
