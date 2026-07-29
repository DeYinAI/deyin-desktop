import { BrowserWindow } from "electron";
import {
  AutomationsStore,
  AutomationRunsStore,
  SshHostsStore,
  enrichAutomations,
  type Automation,
  type AutomationInfo,
  type AutomationRun,
  type SshHostCredentials,
  type SshHostInfo,
  type SshHostInput,
  type SshTestResult,
} from "@deyin/host-core";
import type { Storage } from "@deyin/host-core";
import { CH, type AutomationMutationResult } from "../../shared/ipc.js";
import type { AuthManager } from "../auth.js";
import type { AgentRunContextDeps } from "./agent-run-context.js";
import { AutomationRunner } from "./runner.js";
import { AutomationScheduler, validateCronExpression } from "./scheduler.js";
import { testSshHost } from "./ssh-client.js";

export interface AutomationServiceOptions {
  storage: Storage;
  deps: AgentRunContextDeps;
  auth: AuthManager;
  isCatchUpEnabled: () => boolean;
}

export type { AutomationMutationResult };

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function coerceSshProvider<T extends Partial<Automation>>(input: T): T {
  if (input.target?.kind === "ssh") {
    return { ...input, providerId: "openference" };
  }
  return input;
}

function validateAutomationInput(input: Partial<Automation>): void {
  if (input.prompt !== undefined && !input.prompt.trim()) {
    throw new Error("Prompt is required.");
  }
  if (input.target) {
    if (!input.target.workspacePath.trim()) throw new Error("Workspace path is required.");
    if (input.target.kind === "ssh" && !input.target.hostId) {
      throw new Error("SSH host is required.");
    }
  }
  if (input.target?.kind === "ssh" && input.providerId && input.providerId !== "openference") {
    throw new Error("SSH automations must use the Openference provider.");
  }
  if (input.trigger?.kind === "cron") {
    const err = validateCronExpression(input.trigger.expression);
    if (err) throw new Error(err);
  }
}

export class AutomationService {
  readonly automations: AutomationsStore;
  readonly runs: AutomationRunsStore;
  readonly sshHosts: SshHostsStore;
  private readonly runner: AutomationRunner;
  private readonly scheduler: AutomationScheduler;

  constructor(opts: AutomationServiceOptions) {
    this.automations = new AutomationsStore(opts.storage);
    this.runs = new AutomationRunsStore(opts.storage);
    this.sshHosts = new SshHostsStore(opts.storage);

    // Reconcile leftover running/queued rows from a previous crash.
    this.runs.abortStale("app-restarted");

    this.runner = new AutomationRunner(
      this.automations,
      this.runs,
      this.sshHosts,
      opts.deps,
      opts.auth,
      {
        onRunEvent: (runId, event) => {
          const run = this.runs.get(runId);
          broadcast(CH.automationEvent, { runId, automationId: run?.automationId ?? "", event });
        },
        onRunFinished: (run) => broadcast(CH.automationRunFinished, { run }),
      },
    );

    this.scheduler = new AutomationScheduler(this.automations, {
      onTrigger: (automationId, scheduledAt) => this.runner.runScheduled(automationId, scheduledAt),
      isCatchUpEnabled: opts.isCatchUpEnabled,
    });
    this.scheduler.refresh();
  }

  list(): AutomationInfo[] {
    return enrichAutomations(this.automations.list(), this.runs);
  }

  create(input: Omit<Automation, "id" | "createdAt" | "updatedAt">): AutomationMutationResult {
    const coerced = coerceSshProvider(input);
    validateAutomationInput(coerced);
    const automation = this.automations.create(coerced);
    this.scheduler.notifyAutomationChanged();
    return { automation, list: this.list() };
  }

  update(id: string, patch: Partial<Omit<Automation, "id" | "createdAt">>): AutomationMutationResult {
    const existing = this.automations.get(id);
    if (!existing) throw new Error("Automation not found.");
    const mergedTarget = patch.target ?? existing.target;
    const coerced = coerceSshProvider({ ...patch, target: mergedTarget });
    validateAutomationInput(coerced);
    const automation = this.automations.update(id, coerced);
    if (!automation) throw new Error("Automation not found.");
    this.scheduler.notifyAutomationChanged();
    return { automation, list: this.list() };
  }

  remove(id: string): AutomationInfo[] {
    this.automations.remove(id);
    this.scheduler.notifyAutomationChanged();
    return this.list();
  }

  toggle(id: string, enabled: boolean): AutomationInfo[] {
    this.automations.setEnabled(id, enabled);
    this.scheduler.notifyAutomationChanged();
    return this.list();
  }

  run(id: string): AutomationRun {
    let automation = this.automations.get(id);
    if (!automation) throw new Error("Automation not found.");
    if (automation.target.kind === "ssh" && automation.providerId !== "openference") {
      this.automations.update(id, { providerId: "openference" });
      automation = this.automations.get(id);
      if (!automation) throw new Error("Automation not found.");
    }
    validateAutomationInput(automation);
    return this.runner.runNow(id);
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
    this.sshHosts.remove(id);
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
    this.scheduler.dispose();
    this.runner.dispose();
  }

  refreshScheduler(): void {
    this.scheduler.notifyAutomationChanged();
  }
}
