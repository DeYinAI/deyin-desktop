import { BrowserWindow, powerMonitor } from "electron";
import {
  AutomationsStore,
  AutomationRunsStore,
  AutomationStateStore,
  SshHostsStore,
  enrichAutomations,
  limitsError,
  routinesOf,
  type Automation,
  type AutomationPayload,
  type AutomationInfo,
  type AutomationRun,
  type BotResult,
  type RoutineServerView,
  type SshHostCredentials,
  type SshHostInfo,
  type SshHostInput,
  type SshTestResult,
} from "@deyin/host-core";
import type { Storage } from "@deyin/host-core";
import { CH, type AutomationMutationResult } from "@deyin/contract";
import type { AuthManager } from "../auth.js";
import { resolveRoutineBot, type BotRunSource } from "../bots/run.js";
import type { ServerBotPort } from "../bots/engine/server-chat.js";
import type { AgentRunContextDeps } from "./agent-run-context.js";
import { createProbe, createRunExecutor, notifyHealth, notifyRunFinished } from "./executors.js";
import { consentError } from "./consent.js";
import { proposeLearnedRules } from "./heal-agent.js";
import { Healer } from "./healer.js";
import { HealthKeeper } from "./health.js";
import { AutomationRunner, type RunInput } from "./runner.js";
import { RoutineGate } from "./routine-gate.js";
import { prepareNewRoutine, prepareRoutinePatch } from "./routine-input.js";
import { AutomationScheduler, nextRunAt, validateCronExpression } from "./scheduler.js";
import { testSshHost } from "./ssh-client.js";

export interface AutomationServiceOptions {
  /** Bots that live on a server: how a routine reaches the server when this app starts it. */
  servers?: ServerBotPort;
  /** Where a routine runs by itself, for the Bots on servers. Absent in hosts without servers. */
  serverRoutines?: {
    /** The server's engine starts this routine on schedule, so this app's scheduler leaves it alone. */
    schedulesOnServer(automation: Automation): boolean;
    /** Where the routine runs and why not, for the list. */
    viewOf(automation: Automation): RoutineServerView | undefined;
  };
  /** Told whenever the automations change, e.g. so routines on servers can be kept in step. */
  onChanged?: () => void;
  /** Told after each run ends and its history is closed, for whatever was waiting on it. */
  onRunFinished?: (run: AutomationRun) => void;
  /** Told when an automation is deleted, so whatever pointed at it can let go. */
  onRemoved?: (id: string) => void;
  /** What a saved server's removal must reckon with: Bots that live on it, and the engine put there. */
  hostGuard?: {
    /** Why the server cannot be removed now, or null. */
    blocker(hostId: string): string | null;
    /** The server was removed. */
    removed(hostId: string): void;
  };
  storage: Storage;
  deps: AgentRunContextDeps;
  auth: AuthManager;
  isCatchUpEnabled: () => boolean;
  /** Present where Bots exist; a routine is an automation that runs as one of them. */
  bots?: BotRunSource;
}

export type { AutomationMutationResult };

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

/**
 * Out-of-process targets drive the `deyin` CLI, which only talks to Openference —
 * a custom provider's base URL and key live on this machine, not in the distro or
 * on the remote host. Force the provider rather than failing a saved automation
 * at run time.
 */
function coerceRemoteProvider<T extends Partial<Automation>>(input: T): T {
  const kind = input.target?.kind;
  if (kind === "ssh" || kind === "wsl") {
    return { ...input, providerId: "openference" };
  }
  return input;
}

function validatePayload(payload: AutomationPayload): void {
  switch (payload.kind) {
    case "prompt":
      if (!payload.prompt.trim()) throw new Error("Prompt is required.");
      return;
    case "skill":
      if (!payload.skill.trim()) throw new Error("Select a skill.");
      return;
    case "subagent":
      if (!payload.subagent.trim()) throw new Error("Select a subagent.");
      return;
  }
}

function validateAutomationInput(input: Partial<Automation>): void {
  if (input.payload !== undefined) validatePayload(input.payload);
  if (input.target) {
    if (!input.target.workspacePath.trim()) throw new Error("Workspace path is required.");
    if (input.target.kind === "ssh" && !input.target.hostId) {
      throw new Error("SSH host is required.");
    }
    if (input.target.kind === "wsl" && !input.target.distro.trim()) {
      throw new Error("Select a WSL distro.");
    }
  }
  const remote = input.target?.kind === "ssh" || input.target?.kind === "wsl";
  if (remote && input.providerId && input.providerId !== "openference") {
    throw new Error("Remote (SSH/WSL) automations must use the Openference provider.");
  }
  if (input.trigger?.kind === "cron") {
    const err = validateCronExpression(input.trigger.expression);
    if (err) throw new Error(err);
  }
  if (input.trigger?.kind === "once" && !Number.isFinite(input.trigger.at)) {
    throw new Error("Pick a date and time for the run.");
  }
  const limitProblem = limitsError(input.limits);
  if (limitProblem) throw new Error(limitProblem);
  const consentProblem = consentError(input.consent?.browserOrigins);
  if (consentProblem) throw new Error(consentProblem);
  if (input.consent?.browserOrigins?.length && input.target && input.target.kind !== "local") {
    throw new Error("Chrome access only works for automations that run on this machine, not on WSL or SSH targets.");
  }
  if (input.requires?.tools?.some((tool) => typeof tool !== "string" || !tool.trim())) {
    throw new Error("Required tools must be tool names or patterns.");
  }
}

export class AutomationService {
  readonly automations: AutomationsStore;
  readonly runs: AutomationRunsStore;
  readonly sshHosts: SshHostsStore;
  /** What each automation carries from one run to the next. */
  readonly states: AutomationStateStore;
  private readonly health: HealthKeeper;
  private readonly healer: Healer;
  private readonly runner: AutomationRunner;
  private readonly scheduler: AutomationScheduler;
  private readonly gate: RoutineGate;
  private readonly bots: BotRunSource | undefined;
  private readonly onResume: () => void;

  private readonly opts: AutomationServiceOptions;

  constructor(opts: AutomationServiceOptions) {
    this.opts = opts;
    this.automations = new AutomationsStore(opts.storage);
    this.runs = new AutomationRunsStore(opts.storage);
    this.sshHosts = new SshHostsStore(opts.storage);
    this.states = new AutomationStateStore(opts.storage);
    this.bots = opts.bots;
    this.gate = new RoutineGate({ resolveBot: (botId) => this.resolveBot(botId) });

    // Reconcile leftover running/queued rows from a previous crash.
    this.runs.abortStale("app-restarted");

    this.health = new HealthKeeper({
      get: (id) => this.automations.get(id),
      patch: (id, patch) => void this.automations.patchRuntime(id, patch),
      setEnabled: (id, enabled) => {
        this.automations.setEnabled(id, enabled);
        this.changed();
      },
      probe: createProbe(opts.deps, opts.auth),
      notify: notifyHealth,
    });

    this.healer = new Healer({
      get: (id) => this.automations.get(id),
      patch: (id, patch) => void this.automations.patchRuntime(id, patch),
      propose: (automation, run) => proposeLearnedRules(opts.deps, automation, run),
      notify: notifyHealth,
    });

    this.runner = new AutomationRunner(
      this.automations,
      this.runs,
      opts.deps,
      opts.auth,
      {
        onRunEvent: (runId, event) => {
          const run = this.runs.get(runId);
          broadcast(CH.automationEvent, { runId, automationId: run?.automationId ?? "", event });
        },
        onRunFinished: (run) => {
          // Health first, so the list the UI re-reads on this event already shows a pause.
          this.health.recordRun(run);
          this.healer.recordRun(run);
          broadcast(CH.automationRunFinished, { run });
          opts.onRunFinished?.(run);
        },
        execute: createRunExecutor(opts.deps, this.sshHosts, this.states, opts.bots, opts.servers),
        notify: notifyRunFinished,
      },
      { admit: (automation, now) => this.gate.admit(automation, now) },
    );

    this.scheduler = new AutomationScheduler(this.automations, {
      onTrigger: (automationId, scheduledAt) => this.runner.runScheduled(automationId, scheduledAt),
      isCatchUpEnabled: opts.isCatchUpEnabled,
      skip: (automation) => opts.serverRoutines?.schedulesOnServer(automation) ?? false,
    });
    this.scheduler.refresh();
    this.health.start(this.automations.list());

    // croner timers do not fire for slots that elapsed while the host was
    // suspended, so a laptop closed overnight would silently skip every
    // overnight run without this.
    this.onResume = () => this.scheduler.handleResume();
    powerMonitor.on("resume", this.onResume);
  }

  /** Whether a Bot can run right now, and the folder it works in. */
  private resolveBot(botId: string): BotResult<{ cwd: string }> {
    return resolveRoutineBot(this.bots, botId);
  }

  list(): AutomationInfo[] {
    return enrichAutomations(this.automations.list(), this.runs).map((info) => {
      const server = this.opts.serverRoutines?.viewOf(info);
      return { ...info, nextRunAt: nextRunAt(info), ...(server ? { server } : {}) };
    });
  }

  create(input: Omit<Automation, "id" | "createdAt" | "updatedAt">): AutomationMutationResult {
    const prepared =
      input.botId === undefined
        ? input
        : prepareNewRoutine(input, { existing: this.automations.list(), resolveBot: (botId) => this.resolveBot(botId), now: Date.now() });
    const coerced = coerceRemoteProvider(prepared);
    validateAutomationInput(coerced);
    const automation = this.automations.create(coerced);
    this.changed();
    return { automation, list: this.list() };
  }

  update(id: string, requested: Partial<Omit<Automation, "id" | "createdAt">>): AutomationMutationResult {
    const existing = this.automations.get(id);
    if (!existing) throw new Error("Automation not found.");
    const patch = prepareRoutinePatch(existing, requested, { now: Date.now() });
    const mergedTarget = patch.target ?? existing.target;
    const coerced: Partial<Automation> = coerceRemoteProvider({ ...patch, target: mergedTarget });
    validateAutomationInput(coerced);
    // Re-dating a one-shot re-arms it, even if the previous date already ran.
    if (patch.trigger?.kind === "once") coerced.lastScheduledAt = undefined;
    const automation = this.automations.update(id, coerced);
    if (!automation) throw new Error("Automation not found.");
    // Editing a paused automation is a person taking over; so is a new task, which also voids what the old one taught.
    const newTask = patch.payload !== undefined && JSON.stringify(patch.payload) !== JSON.stringify(existing.payload);
    if (existing.health?.pausedAt !== undefined || (patch.enabled !== undefined && patch.enabled !== existing.enabled) || newTask) {
      this.health.clear(id);
    }
    if (newTask) {
      // A new task voids what the old one taught, and the failures it could not be healed of.
      const { healedAt: _healed, unhealable: _unhealable, ...health } = this.automations.get(id)?.health ?? { consecutiveFailures: 0 };
      this.automations.patchRuntime(id, { learnedRules: undefined, learnedRevisions: undefined, health });
    }
    this.changed();
    return { automation, list: this.list() };
  }

  /** Undoes one of the healer's changes (and every one after it) from the Healing panel. */
  revertLearned(id: string, revisionId: string): AutomationInfo[] {
    if (!this.healer.revert(id, revisionId)) throw new Error("That change was already undone, or no longer exists.");
    return this.list();
  }

  remove(id: string): AutomationInfo[] {
    this.discard(id);
    this.changed();
    return this.list();
  }

  /** Delete one automation and everything kept for it. */
  private discard(id: string): void {
    this.health.clear(id);
    this.states.remove(id);
    this.gate.forget(id);
    this.automations.remove(id);
    this.opts.onRemoved?.(id);
  }

  /** A deleted Bot takes its routines with it: any run in flight is stopped, and nothing is left to fire against a Bot that is gone. */
  removeForBot(botId: string): number {
    const owned = routinesOf(this.automations.list(), botId);
    for (const routine of owned) {
      for (const run of this.runs.list(routine.id)) {
        if (run.status === "running" || run.status === "queued") this.runner.stop(run.id);
      }
      this.discard(routine.id);
    }
    if (owned.length > 0) this.changed();
    return owned.length;
  }

  toggle(id: string, enabled: boolean): AutomationInfo[] {
    this.automations.setEnabled(id, enabled);
    this.health.clear(id);
    this.changed();
    return this.list();
  }

  /** Start a run now. With `input` it is a message for a routine: its own run, answered from what the Bot reports. */
  run(id: string, input?: RunInput): AutomationRun {
    let automation = this.automations.get(id);
    if (!automation) throw new Error("Automation not found.");
    if (automation.target.kind === "ssh" && automation.providerId !== "openference") {
      this.automations.update(id, { providerId: "openference" });
      automation = this.automations.get(id);
      if (!automation) throw new Error("Automation not found.");
    }
    validateAutomationInput(automation);
    return this.runner.runNow(id, input);
  }

  stopRun(runId: string): void {
    this.runner.stop(runId);
  }

  listRuns(automationId?: string): AutomationRun[] {
    return this.runs.list(automationId);
  }

  /* SSH hosts -------------------------------------------------------------- */

  listSshHosts(): SshHostInfo[] {
    return this.sshHosts.list();
  }

  addSshHost(input: SshHostInput): SshHostInfo[] {
    this.sshHosts.add(input);
    return this.sshHosts.list();
  }

  updateSshHost(id: string, patch: Partial<SshHostInput>): SshHostInfo[] {
    this.sshHosts.update(id, patch);
    return this.sshHosts.list();
  }

  removeSshHost(id: string): SshHostInfo[] {
    const refs = this.automations.list().filter((a) => a.target.kind === "ssh" && a.target.hostId === id);
    if (refs.length > 0) {
      throw new Error(
        `Cannot delete: used by ${refs.length} automation${refs.length === 1 ? "" : "s"} (${refs.map((r) => r.name).join(", ")}).`,
      );
    }
    const blocker = this.opts.hostGuard?.blocker(id);
    if (blocker) throw new Error(blocker);
    this.sshHosts.remove(id);
    this.opts.hostGuard?.removed(id);
    return this.sshHosts.list();
  }

  setSshCredentials(id: string, creds: SshHostCredentials): SshHostInfo[] {
    this.sshHosts.setCredentials(id, creds);
    return this.sshHosts.list();
  }

  async testSshHost(hostId: string, acceptFingerprint?: string): Promise<SshTestResult> {
    return testSshHost(this.sshHosts, hostId, acceptFingerprint);
  }

  pinSshFingerprint(hostId: string, fingerprint: string): SshHostInfo[] {
    this.sshHosts.setKnownFingerprint(hostId, fingerprint);
    return this.sshHosts.list();
  }

  dispose(): void {
    powerMonitor.off("resume", this.onResume);
    this.scheduler.dispose();
    this.health.dispose();
    this.runner.dispose();
    this.runs.flush();
  }

  refreshScheduler(): void {
    this.scheduler.notifyAutomationChanged();
  }

  /** Re-plan the schedule after any change to the automations, and tell whoever keeps routines on servers in step. */
  private changed(): void {
    this.scheduler.notifyAutomationChanged();
    this.opts.onChanged?.();
  }
}
