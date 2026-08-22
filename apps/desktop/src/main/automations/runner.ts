import { Notification } from "electron";
import type {
  Automation,
  AutomationRun,
  AutomationsStore,
  AutomationRunsStore,
  SshHostsStore,
} from "@deyin/host-core";
import type { AgentUiEvent } from "@deyin/contract";
import type { AuthManager } from "../auth.js";
import type { AgentRunContextDeps } from "./agent-run-context.js";
import { runLocalAutomation } from "./local-executor.js";
import { runWslAutomation } from "./wsl-executor.js";
import { resolvePayload } from "./payload.js";
import { runRemoteAutomation } from "./remote-executor.js";

const GLOBAL_CONCURRENCY = 2;

export interface AutomationRunnerCallbacks {
  onRunEvent: (runId: string, event: AgentUiEvent) => void;
  onRunFinished: (run: AutomationRun) => void;
}

interface QueueEntry {
  automationId: string;
  scheduledAt: number;
  runId?: string;
}

export class AutomationRunner {
  private readonly activeByRun = new Map<string, AbortController>();
  /** Per-automation concurrency lock: an automationId is in here iff a run is active. */
  private readonly activeAutomations = new Set<string>();
  private activeCount = 0;
  private readonly queue: QueueEntry[] = [];

  constructor(
    private readonly automations: AutomationsStore,
    private readonly runs: AutomationRunsStore,
    private readonly sshHosts: SshHostsStore,
    private readonly deps: AgentRunContextDeps,
    private readonly auth: AuthManager,
    private readonly callbacks: AutomationRunnerCallbacks,
  ) {}

  runNow(automationId: string): AutomationRun {
    const automation = this.automations.get(automationId);
    if (!automation) throw new Error("Automation not found.");
    // Dedupe against started and merely-queued runs (queue entries are not in activeByAutomation).
    const existing = this.runs.list(automationId).find((r) => r.status === "running" || r.status === "queued");
    if (existing) return existing;
    const queued = this.queue.find((q) => q.automationId === automationId);
    if (queued?.runId) {
      const fromQueue = this.runs.get(queued.runId);
      if (fromQueue) return fromQueue;
    }
    const run = this.runs.create(automationId); // status: queued
    if (this.activeCount >= GLOBAL_CONCURRENCY) {
      this.queue.push({ automationId, scheduledAt: Date.now(), runId: run.id });
      return run;
    }
    void this.start(automation, Date.now(), run.id);
    return run;
  }

  runScheduled(automationId: string, scheduledAt: number): void {
    if (this.activeAutomations.has(automationId)) return;
    if (this.queue.some((q) => q.automationId === automationId)) return;

    const automation = this.automations.get(automationId);
    if (!automation || !automation.enabled) return;

    // Claim lastScheduledAt in start() once the run actually begins — not while
    // merely queued — so a crash mid-queue still allows catch-up.
    if (this.activeCount >= GLOBAL_CONCURRENCY) {
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
    controller?.abort();
  }

  /** Abort every in-flight and queued run (app quit). */
  dispose(): void {
    for (const entry of [...this.queue]) {
      if (entry.runId) {
        this.runs.finish(entry.runId, "aborted", { reason: "app-quit" });
      }
    }
    this.queue.length = 0;
    for (const controller of this.activeByRun.values()) {
      controller.abort();
    }
  }

  private drainQueue(): void {
    while (this.activeCount < GLOBAL_CONCURRENCY && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      const automation = this.automations.get(next.automationId);
      if (!automation || !automation.enabled || this.activeAutomations.has(next.automationId)) {
        if (next.runId) {
          const finished = this.runs.finish(next.runId, "aborted", { reason: "skipped" });
          if (finished) this.callbacks.onRunFinished(finished);
        }
        continue;
      }
      void this.start(automation, next.scheduledAt, next.runId);
    }
  }

  private async start(automation: Automation, scheduledAt: number, existingRunId?: string): Promise<void> {
    const controller = new AbortController();
    this.activeCount += 1;
    this.activeAutomations.add(automation.id);

    const run = existingRunId
      ? (this.runs.get(existingRunId) ?? this.runs.create(automation.id))
      : this.runs.create(automation.id);
    this.activeByRun.set(run.id, controller);
    this.runs.setStatus(run.id, "running");

    // Claim cron slot as soon as execution begins (before auth/host checks) so
    // failures do not retry-loop, but queued-then-crash still catch-up.
    if (automation.trigger.kind === "cron") {
      this.automations.setLastScheduledAt(automation.id, scheduledAt);
    }

    const emit = (event: AgentUiEvent): void => {
      this.runs.appendEvent(run.id, event);
      this.callbacks.onRunEvent(run.id, event);
    };

    try {
      const token = await this.auth.getAccessToken();
      if (!token) {
        emit({ type: "error", message: "Not signed in. Connect your Openference account first." });
        const finished = this.runs.finish(run.id, "failed", { reason: "auth" });
        if (finished) this.callbacks.onRunFinished(finished);
        return;
      }

      // Skills and subagents resolve against the live registry here, so a
      // renamed or disabled capability fails the run with a clear message
      // instead of sending placeholder text to the model.
      const caps = await this.deps.capabilities.enabledForRun();
      let resolved;
      try {
        resolved = resolvePayload(automation.payload, {
          skills: caps.skills,
          subagents: caps.subagents,
          canDelegateInProcess: automation.target.kind === "local",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: "error", message });
        const finished = this.runs.finish(run.id, "failed", { reason: message });
        if (finished) this.callbacks.onRunFinished(finished);
        return;
      }

      let result: { reason: "completed" | "max-steps" | "aborted"; finalText: string };
      if (automation.target.kind === "local") {
        result = await runLocalAutomation(this.deps, {
          automation,
          prompt: resolved.prompt,
          subagent: resolved.subagent,
          cwd: automation.target.workspacePath,
          onEvent: emit,
          signal: controller.signal,
        });
      } else if (automation.target.kind === "wsl") {
        result = await runWslAutomation({
          automation,
          prompt: resolved.prompt,
          distro: automation.target.distro,
          workspacePath: automation.target.workspacePath,
          token,
          onEvent: emit,
          signal: controller.signal,
        });
      } else {
        const host = this.sshHosts.get(automation.target.hostId);
        if (!host) {
          emit({ type: "error", message: "SSH host not found." });
          const finished = this.runs.finish(run.id, "failed", { reason: "missing-host" });
          if (finished) this.callbacks.onRunFinished(finished);
          return;
        }
        result = await runRemoteAutomation({
          automation,
          prompt: resolved.prompt,
          hosts: this.sshHosts,
          hostId: automation.target.hostId,
          workspacePath: automation.target.workspacePath,
          token,
          onEvent: emit,
          signal: controller.signal,
        });
      }

      const status = result.reason === "aborted" ? "aborted" : result.reason === "completed" ? "completed" : "failed";
      const finished = this.runs.finish(run.id, status, { reason: result.reason, finalText: result.finalText });
      if (finished) {
        this.notifyComplete(automation, finished);
        this.callbacks.onRunFinished(finished);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message });
      emit({ type: "done", reason: "aborted", finalText: "" });
      const finished = this.runs.finish(run.id, "failed", { reason: message });
      if (finished) {
        this.notifyComplete(automation, finished);
        this.callbacks.onRunFinished(finished);
      }
    } finally {
      this.activeByRun.delete(run.id);
      this.activeAutomations.delete(automation.id);
      this.activeCount -= 1;
      this.drainQueue();
    }
  }

  private notifyComplete(automation: Automation, run: AutomationRun): void {
    if (!Notification.isSupported()) return;
    const ok = run.status === "completed";
    const notification = new Notification({
      title: ok ? `Automation completed: ${automation.name}` : `Automation failed: ${automation.name}`,
      body: ok ? (run.finalText?.slice(0, 120) || "Done.") : (run.reason || "Run failed."),
    });
    notification.show();
  }
}
