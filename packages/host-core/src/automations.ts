import { randomUUID } from "node:crypto";
import type { Storage } from "./storage.js";
import type {
  Automation,
  AutomationInfo,
  AutomationRun,
  AutomationRunStatus,
  AgentUiEvent,
  SshHostCredentials,
  SshHostInfo,
  SshHostInput,
  StoredSshHost,
} from "./types.js";

const MAX_RUNS_PER_AUTOMATION = 20;
const MAX_TOTAL_RUNS = 200;
const MAX_EVENTS_PER_RUN = 200;
const EVENT_PERSIST_DEBOUNCE_MS = 400;

/* AutomationsStore --------------------------------------------------------- */

interface AutomationsState {
  automations: Automation[];
}

export class AutomationsStore {
  private state: AutomationsState;

  constructor(private readonly storage: Storage) {
    this.state = storage.readJson<AutomationsState>("automations.json", { automations: [] });
  }

  private persist(): void {
    this.storage.writeJson("automations.json", this.state);
  }

  list(): Automation[] {
    return [...this.state.automations].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Automation | undefined {
    return this.state.automations.find((a) => a.id === id);
  }

  create(input: Omit<Automation, "id" | "createdAt" | "updatedAt">): Automation {
    const now = Date.now();
    const automation: Automation = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    this.state.automations.push(automation);
    this.persist();
    return automation;
  }

  update(id: string, patch: Partial<Omit<Automation, "id" | "createdAt">>): Automation | null {
    const idx = this.state.automations.findIndex((a) => a.id === id);
    if (idx < 0) return null;
    const next = { ...this.state.automations[idx]!, ...patch, updatedAt: Date.now() };
    this.state.automations[idx] = next;
    this.persist();
    return next;
  }

  remove(id: string): boolean {
    const before = this.state.automations.length;
    this.state.automations = this.state.automations.filter((a) => a.id !== id);
    if (this.state.automations.length === before) return false;
    this.persist();
    return true;
  }

  setEnabled(id: string, enabled: boolean): Automation | null {
    return this.update(id, { enabled });
  }

  setLastScheduledAt(id: string, at: number): void {
    const automation = this.get(id);
    if (!automation) return;
    automation.lastScheduledAt = at;
    automation.updatedAt = Date.now();
    this.persist();
  }
}

/* AutomationRunsStore ------------------------------------------------------ */

interface RunsState {
  runs: AutomationRun[];
}

export class AutomationRunsStore {
  private state: RunsState;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** automationId → runs sorted by startedAt descending. O(1) lastForAutomation. */
  private index = new Map<string, AutomationRun[]>();

  constructor(private readonly storage: Storage) {
    this.state = storage.readJson<RunsState>("automation-runs.json", { runs: [] });
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.index.clear();
    for (let i = this.state.runs.length - 1; i >= 0; i--) {
      const run = this.state.runs[i]!;
      const list = this.index.get(run.automationId) ?? [];
      list.push(run);
      this.index.set(run.automationId, list);
    }
    for (const list of this.index.values()) list.sort((a, b) => b.startedAt - a.startedAt);
  }

  private persist(): void {
    this.storage.writeJson("automation-runs.json", this.state);
    this.dirty = false;
  }

  /** Flush immediately (finish / create / setStatus). */
  private persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persist();
  }

  /** Debounced persist for high-frequency appendEvent. */
  private persistSoon(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.dirty) this.persist();
    }, EVENT_PERSIST_DEBOUNCE_MS);
  }

  /** Flush a pending debounced persist (call on dispose so runs aren't lost). */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty) this.persist();
  }

  list(automationId?: string): AutomationRun[] {
    if (automationId) {
      // Use the index for the sorted-per-automation slice; copy so callers can't mutate.
      return [...(this.index.get(automationId) ?? [])];
    }
    return [...this.state.runs].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): AutomationRun | undefined {
    return this.state.runs.find((r) => r.id === id);
  }

  create(automationId: string): AutomationRun {
    const run: AutomationRun = {
      id: randomUUID(),
      automationId,
      status: "queued",
      startedAt: Date.now(),
      events: [],
    };
    this.state.runs.unshift(run);
    this.indexInsert(run);
    this.trim();
    this.persistNow();
    return run;
  }

  private indexInsert(run: AutomationRun): void {
    const list = this.index.get(run.automationId) ?? [];
    // Runs are created with descending startedAt (Date.now() grows), so prepend.
    list.unshift(run);
    this.index.set(run.automationId, list);
  }

  setStatus(runId: string, status: AutomationRunStatus): void {
    const run = this.get(runId);
    if (!run) return;
    run.status = status;
    this.persistNow();
  }

  appendEvent(runId: string, event: AgentUiEvent): void {
    const run = this.get(runId);
    if (!run) return;
    run.events.push(event);
    if (run.events.length > MAX_EVENTS_PER_RUN) {
      run.events = run.events.slice(-MAX_EVENTS_PER_RUN);
    }
    // Flush immediately on terminal events so a crash does not drop the last deltas.
    if (event.type === "done" || event.type === "error") this.persistNow();
    else this.persistSoon();
  }

  finish(
    runId: string,
    status: AutomationRunStatus,
    opts: { reason?: string; finalText?: string } = {},
  ): AutomationRun | null {
    const run = this.get(runId);
    if (!run) return null;
    run.status = status;
    run.finishedAt = Date.now();
    if (opts.reason !== undefined) run.reason = opts.reason;
    if (opts.finalText !== undefined) run.finalText = opts.finalText;
    this.persistNow();
    return run;
  }

  /** Mark any leftover queued/running runs as aborted (app restart). */
  abortStale(reason = "app-restarted"): number {
    let count = 0;
    for (const run of this.state.runs) {
      if (run.status === "running" || run.status === "queued") {
        run.status = "aborted";
        run.finishedAt = Date.now();
        run.reason = reason;
        count += 1;
      }
    }
    if (count > 0) this.persistNow();
    return count;
  }

  lastForAutomation(automationId: string): AutomationRun | undefined {
    return this.index.get(automationId)?.[0];
  }

  private trim(): void {
    const byAutomation = new Map<string, AutomationRun[]>();
    for (const run of this.state.runs) {
      const list = byAutomation.get(run.automationId) ?? [];
      list.push(run);
      byAutomation.set(run.automationId, list);
    }
    const keep = new Set<string>();
    for (const runs of byAutomation.values()) {
      runs.sort((a, b) => b.startedAt - a.startedAt);
      for (const run of runs.slice(0, MAX_RUNS_PER_AUTOMATION)) keep.add(run.id);
    }
    let trimmed = this.state.runs.filter((r) => keep.has(r.id));
    trimmed.sort((a, b) => b.startedAt - a.startedAt);
    if (trimmed.length > MAX_TOTAL_RUNS) trimmed = trimmed.slice(0, MAX_TOTAL_RUNS);
    this.state.runs = trimmed;
    this.rebuildIndex();
  }
}

export function enrichAutomations(automations: Automation[], runs: AutomationRunsStore): AutomationInfo[] {
  return automations.map((a) => ({ ...a, lastRun: runs.lastForAutomation(a.id) }));
}

/* SshHostsStore ------------------------------------------------------------ */

interface SshHostsState {
  hosts: StoredSshHost[];
}

export class SshHostsStore {
  private state: SshHostsState;

  constructor(private readonly storage: Storage) {
    this.state = storage.readJson<SshHostsState>("ssh-hosts.json", { hosts: [] });
  }

  private persist(): void {
    this.storage.writeJson("ssh-hosts.json", this.state);
  }

  private toInfo(host: StoredSshHost): SshHostInfo {
    return {
      id: host.id,
      label: host.label,
      host: host.host,
      port: host.port,
      username: host.username,
      authMethod: host.authMethod,
      hasKey: Boolean(host.keyCipher),
      hasPassword: Boolean(host.passwordCipher),
      knownHostFingerprint: host.knownHostFingerprint,
    };
  }

  list(): SshHostInfo[] {
    return this.state.hosts.map((h) => this.toInfo(h));
  }

  get(id: string): StoredSshHost | undefined {
    return this.state.hosts.find((h) => h.id === id);
  }

  add(input: SshHostInput): SshHostInfo {
    const host: StoredSshHost = {
      id: randomUUID(),
      label: input.label,
      host: input.host,
      port: input.port ?? 22,
      username: input.username,
      authMethod: input.authMethod,
    };
    this.state.hosts.push(host);
    this.persist();
    return this.toInfo(host);
  }

  update(id: string, patch: Partial<SshHostInput>): SshHostInfo | null {
    const host = this.get(id);
    if (!host) return null;
    if (patch.label !== undefined) host.label = patch.label;
    if (patch.host !== undefined) host.host = patch.host;
    if (patch.port !== undefined) host.port = patch.port;
    if (patch.username !== undefined) host.username = patch.username;
    if (patch.authMethod !== undefined) host.authMethod = patch.authMethod;
    this.persist();
    return this.toInfo(host);
  }

  setCredentials(id: string, creds: SshHostCredentials): SshHostInfo | null {
    const host = this.get(id);
    if (!host) return null;
    if (creds.privateKey !== undefined) {
      host.keyCipher = creds.privateKey ? this.storage.cipher.encrypt(creds.privateKey) : undefined;
    }
    if (creds.passphrase !== undefined) {
      host.passphraseCipher = creds.passphrase ? this.storage.cipher.encrypt(creds.passphrase) : undefined;
    }
    if (creds.password !== undefined) {
      host.passwordCipher = creds.password ? this.storage.cipher.encrypt(creds.password) : undefined;
    }
    this.persist();
    return this.toInfo(host);
  }

  setKnownFingerprint(id: string, fingerprint: string): SshHostInfo | null {
    const host = this.get(id);
    if (!host) return null;
    host.knownHostFingerprint = fingerprint;
    this.persist();
    return this.toInfo(host);
  }

  remove(id: string): boolean {
    const before = this.state.hosts.length;
    this.state.hosts = this.state.hosts.filter((h) => h.id !== id);
    if (this.state.hosts.length === before) return false;
    this.persist();
    return true;
  }

  /** Decrypt credentials for main-process SSH connect only. */
  resolveCredentials(id: string): {
    host: StoredSshHost;
    privateKey?: string;
    passphrase?: string;
    password?: string;
  } | null {
    const host = this.get(id);
    if (!host) return null;
    return {
      host,
      privateKey: host.keyCipher ? (this.storage.cipher.decrypt(host.keyCipher) ?? undefined) : undefined,
      passphrase: host.passphraseCipher ? (this.storage.cipher.decrypt(host.passphraseCipher) ?? undefined) : undefined,
      password: host.passwordCipher ? (this.storage.cipher.decrypt(host.passwordCipher) ?? undefined) : undefined,
    };
  }
}
