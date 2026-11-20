import {
  isHumanBlocker,
  type Automation,
  type AutomationBlocker,
  type AutomationBlockerKind,
  type AutomationHealth,
  type AutomationRequirements,
  type AutomationRun,
} from "@deyin/host-core";
import { chromeReadiness, consentOrigins, needsChrome, type BrowserReadiness } from "./consent.js";
import { systemClock, type Clock } from "./watchdog.js";

/**
 * Keeping an unattended automation healthy.
 *
 * Before this, a broken automation failed every slot forever — a signed-out
 * account, a missing tool, a dead MCP server each cost a model run per tick —
 * and the only sign was the user happening to open Run History. Here, the
 * cheap failures are caught before any model is called, the transient ones are
 * retried, a run of real failures pauses the automation, and a paused one is
 * probed (again without a model) so it can resume on its own when the cause was
 * temporary. Nothing here touches Electron: ports and the clock are injected.
 */

export const PAUSE_AFTER_FAILURES = 3;
/** Runs that finish without reporting are not failures, but a hundred of them are not a working automation either. */
export const PAUSE_AFTER_UNREPORTED = 4;
/** Delays before each resume probe of a recoverably paused automation; after the last, a person must act. */
export const PROBE_SCHEDULE_MS: readonly number[] = [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
/** In-slot retries of a transient start-up failure, and how long to wait before each. */
export const TRANSIENT_RETRY_BACKOFF_MS: readonly number[] = [5_000, 20_000];
export const MCP_CONNECT_ATTEMPTS = 3;
export const MCP_CONNECT_BACKOFF_MS: readonly number[] = [1_000, 3_000];

const MAX_REASON_CHARS = 300;

function clip(text: string, max = MAX_REASON_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/* Error classification --------------------------------------------------------------------- */

export interface ErrorClass {
  /** Worth trying again in the same slot, when nothing had been done yet. */
  transient: boolean;
  kind: AutomationBlockerKind;
}

const RATE_LIMIT = /\b429\b|rate.?limit|too many requests|quota/i;
const AUTH = /\b40[13]\b|unauthori[sz]ed|forbidden|not signed in|token (is )?(expired|invalid)|invalid (api )?key/i;
const NETWORK = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network|timed? ?out|\b50[0234]\b|bad gateway|service unavailable|gateway timeout|overloaded|temporarily/i;

/** Sorts an error message into "try again" and "stop", and into the blocker it would be. */
export function classifyError(message: string): ErrorClass {
  if (RATE_LIMIT.test(message)) return { transient: true, kind: "rate-limit" };
  if (AUTH.test(message)) return { transient: false, kind: "auth" };
  if (NETWORK.test(message)) return { transient: true, kind: "other" };
  if (/\bmcp\b/i.test(message)) return { transient: false, kind: "mcp" };
  return { transient: false, kind: "other" };
}

/* Required tools --------------------------------------------------------------------------- */

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** `chrome_*` matches `chrome_open`; a plain name matches itself. */
export function matchesGlob(name: string, glob: string): boolean {
  return globToRegExp(glob).test(name);
}

/** The first required tool pattern nothing in `available` satisfies, as a blocker; null when all are met. */
export function checkRequiredTools(
  requires: AutomationRequirements | undefined,
  available: readonly string[],
  hint?: (missing: string) => string | undefined,
): AutomationBlocker | null {
  for (const pattern of requires?.tools ?? []) {
    if (available.some((name) => matchesGlob(name, pattern))) continue;
    const extra = hint?.(pattern);
    return { kind: "tool-missing", detail: `Required tool "${pattern}" is not available to this run.${extra ? ` ${extra}` : ""}` };
  }
  return null;
}

/* Static preflight ------------------------------------------------------------------------- */

export interface PreflightProbes {
  /** The credential this run's model needs, or null when it has none (signed out, refresh failed, no key saved). */
  token(): Promise<string | null>;
  /** What to tell the person when `token` finds nothing. Defaults to the Openference sign-in message. */
  missingCredential?: string;
  workspaceExists(path: string): boolean;
  sleep(ms: number): Promise<void>;
  /** Chrome's state, or undefined when this host has no Chrome control. */
  browser?: () => BrowserReadiness | undefined;
}

export type PreflightResult = { ok: true; token: string } | { ok: false; blocker: AutomationBlocker };

const TOKEN_RETRY_DELAY_MS = 1_000;

/** Everything that can be checked without building a tool registry or calling a model. */
export async function preflight(
  automation: Pick<Automation, "target" | "requires" | "consent">,
  probes: PreflightProbes,
): Promise<PreflightResult> {
  let token = await probes.token();
  if (!token) {
    // One more try: a refresh that failed on a network blip should not read as "signed out".
    await probes.sleep(TOKEN_RETRY_DELAY_MS);
    token = await probes.token();
  }
  if (!token) return { ok: false, blocker: { kind: "auth", detail: probes.missingCredential ?? "Not signed in. Connect your Openference account first." } };

  const { target } = automation;
  if (target.kind === "local" && !probes.workspaceExists(target.workspacePath)) {
    return { ok: false, blocker: { kind: "other", detail: `The workspace folder does not exist: ${target.workspacePath}` } };
  }

  if (needsChrome(automation)) {
    // Say what is missing now, in a sentence a person can act on, rather than let the run discover it and improvise.
    if (target.kind !== "local") {
      return { ok: false, blocker: { kind: "tool-missing", detail: "Chrome access only works for automations that run on this machine, not on WSL or SSH targets." } };
    }
    const state = probes.browser?.();
    if (!state) return { ok: false, blocker: { kind: "tool-missing", detail: "Chrome control is not available in this app." } };
    const blocker = chromeReadiness(consentOrigins(automation), state);
    if (blocker) return { ok: false, blocker };
  }
  return { ok: true, token };
}

/* Connecting with retries ------------------------------------------------------------------ */

export interface ConnectFailure {
  name: string;
  error: unknown;
}

export interface ConnectRetryOptions {
  attempts: number;
  backoffMs: readonly number[];
  sleep(ms: number): Promise<void>;
  /** A failure that retrying cannot fix (it needs a sign-in) is reported at once. */
  retryable?: (error: unknown) => boolean;
}

/**
 * Connects `defs`, then retries just the ones that failed. A server that was
 * briefly unreachable at the top of the hour should not cost the run its tools;
 * one that is really down is reported, by name, rather than silently dropped.
 */
export async function connectWithRetry<D extends { name: string }, C>(
  defs: D[],
  connect: (defs: D[], onFail: (name: string, error: unknown) => void) => Promise<C[]>,
  options: ConnectRetryOptions,
): Promise<{ connections: C[]; failures: ConnectFailure[] }> {
  const connections: C[] = [];
  /** Servers that have failed and not yet connected, by name. */
  const unresolved = new Map<string, ConnectFailure>();
  let pending = defs;
  for (let attempt = 0; attempt < options.attempts && pending.length > 0; attempt += 1) {
    if (attempt > 0) await options.sleep(options.backoffMs[Math.min(attempt - 1, options.backoffMs.length - 1)] ?? 0);
    const failed = new Map<string, ConnectFailure>();
    connections.push(...(await connect(pending, (name, error) => failed.set(name, { name, error }))));
    for (const def of pending) {
      const failure = failed.get(def.name);
      if (failure) unresolved.set(def.name, failure);
      else unresolved.delete(def.name);
    }
    pending = pending.filter((def) => {
      const failure = failed.get(def.name);
      return failure !== undefined && (options.retryable?.(failure.error) ?? true);
    });
  }
  return { connections, failures: [...unresolved.values()] };
}

/* The health state machine ----------------------------------------------------------------- */

export interface PauseInfo {
  kind: NonNullable<AutomationHealth["pausedKind"]>;
  reason: string;
  /** False when only a person can fix it, so no probe is scheduled. */
  recoverable: boolean;
}

export interface HealthTransition {
  health: AutomationHealth;
  /** Set when this run is the one that paused the automation. */
  paused?: PauseInfo;
  /** Set when this run proved an auto-paused automation works again. */
  resumed?: boolean;
}

export function freshHealth(): AutomationHealth {
  return { consecutiveFailures: 0 };
}

function withoutPause(health: AutomationHealth): AutomationHealth {
  const { pausedAt: _a, pausedReason: _r, pausedKind: _k, nextProbeAt: _n, ...rest } = health;
  return rest;
}

export function nextProbeDelay(attempts: number): number | undefined {
  return PROBE_SCHEDULE_MS[attempts];
}

function paused(base: AutomationHealth, info: PauseInfo, now: number): HealthTransition {
  const delay = info.recoverable ? nextProbeDelay(base.probeAttempts ?? 0) : undefined;
  // Already paused (a manual run failed again): keep when it began and when it will next be probed.
  const probeAt = base.nextProbeAt ?? (delay !== undefined ? now + delay : undefined);
  const health: AutomationHealth = {
    ...base,
    pausedAt: base.pausedAt ?? now,
    pausedReason: clip(info.reason),
    pausedKind: info.kind,
    ...(probeAt !== undefined ? { nextProbeAt: probeAt } : {}),
  };
  // Pausing an automation that is already paused (a manual run, say) is not news.
  return { health, ...(base.pausedAt === undefined ? { paused: info } : {}) };
}

/** Folds a finished run into the automation's health. Runs with no outcome (a user stop, a skipped tick) change nothing. */
export function recordOutcome(
  prev: AutomationHealth | undefined,
  run: Pick<AutomationRun, "outcome" | "blocker" | "reason">,
  now: number,
): HealthTransition {
  const before = prev ?? freshHealth();
  if (!run.outcome) return { health: before };
  const base: AutomationHealth = { ...before, lastOutcome: run.outcome };

  switch (run.outcome) {
    case "success":
    case "idle": {
      const healed: AutomationHealth = { ...withoutPause(base), consecutiveFailures: 0, consecutiveUnreported: 0, lastSuccessAt: now, probeAttempts: 0 };
      return { health: healed, ...(before.pausedAt !== undefined ? { resumed: true } : {}) };
    }
    case "unreported": {
      const unreported = (before.consecutiveUnreported ?? 0) + 1;
      const next = { ...base, consecutiveUnreported: unreported };
      if (unreported >= PAUSE_AFTER_UNREPORTED) {
        return paused(next, { kind: "failures", reason: `${unreported} runs in a row finished without reporting an outcome, so nothing can be said about whether they worked.`, recoverable: true }, now);
      }
      return { health: next };
    }
    case "blocked": {
      const blocker = run.blocker ?? { kind: "other" as const, detail: run.reason ?? "blocked" };
      const next = { ...base, consecutiveFailures: before.consecutiveFailures + 1, consecutiveUnreported: 0 };
      // A login wall will not clear by trying again; waiting for three tries only repeats it.
      if (isHumanBlocker(blocker.kind)) return paused(next, { kind: blocker.kind, reason: blocker.detail, recoverable: false }, now);
      if (next.consecutiveFailures >= PAUSE_AFTER_FAILURES) return paused(next, { kind: blocker.kind, reason: blocker.detail, recoverable: true }, now);
      return { health: next };
    }
    case "failed": {
      const next = { ...base, consecutiveFailures: before.consecutiveFailures + 1, consecutiveUnreported: 0 };
      if (next.consecutiveFailures >= PAUSE_AFTER_FAILURES) {
        return paused(next, { kind: "failures", reason: `${next.consecutiveFailures} runs in a row failed. Last: ${run.reason ?? "no reason recorded"}`, recoverable: true }, now);
      }
      return { health: next };
    }
    default: {
      const unreachable: never = run.outcome;
      throw new Error(`Unhandled run outcome: ${String(unreachable)}`);
    }
  }
}

/** What a resume probe found. A pass resumes with one strike left, so a repeat offender is paused again at once. */
export function recordProbe(prev: AutomationHealth, passed: boolean, now: number): HealthTransition {
  if (passed) {
    return { health: { ...withoutPause(prev), consecutiveFailures: PAUSE_AFTER_FAILURES - 1, consecutiveUnreported: 0 }, resumed: true };
  }
  const attempts = (prev.probeAttempts ?? 0) + 1;
  const delay = nextProbeDelay(attempts);
  const { nextProbeAt: _gone, ...rest } = prev;
  return { health: { ...rest, probeAttempts: attempts, ...(delay !== undefined ? { nextProbeAt: now + delay } : {}) } };
}

/* The keeper -------------------------------------------------------------------------------- */

export interface HealthPorts {
  get(id: string): Automation | undefined;
  /** Writes runner-owned fields without disturbing the catch-up floor. */
  patch(id: string, patch: { health: AutomationHealth }): void;
  /** Turns scheduled runs on or off. */
  setEnabled(id: string, enabled: boolean): void;
  /** A cheap check, with no model call, that a paused automation could run again; null when it could. */
  probe(automation: Automation): Promise<AutomationBlocker | null>;
  notify(automation: Automation, message: string): void;
  clock?: Clock;
}

export class HealthKeeper {
  private readonly clock: Clock;
  private readonly timers = new Map<string, unknown>();

  constructor(private readonly ports: HealthPorts) {
    this.clock = ports.clock ?? systemClock;
  }

  /** Arms probes for automations that were paused when the app last ran. */
  start(automations: readonly Automation[]): void {
    for (const automation of automations) this.arm(automation);
  }

  dispose(): void {
    for (const handle of this.timers.values()) this.clock.clearTimeout(handle);
    this.timers.clear();
  }

  /** Folds a finished run into its automation's health, pausing or resuming it when that is warranted. */
  recordRun(run: AutomationRun): void {
    if (!run.outcome) return; // a user stop or a skipped tick says nothing about health
    const automation = this.ports.get(run.automationId);
    if (!automation) return;
    const transition = recordOutcome(automation.health, run, this.clock.now());
    this.ports.patch(automation.id, { health: transition.health });

    if (transition.paused) {
      this.ports.setEnabled(automation.id, false);
      this.ports.notify(automation, `Paused: ${transition.paused.reason}${transition.paused.recoverable ? " It will be checked again automatically." : " It needs you."}`);
    } else if (transition.resumed) {
      if (!automation.enabled) this.ports.setEnabled(automation.id, true);
      this.ports.notify(automation, "Resumed: a run worked again.");
    }
    const updated = this.ports.get(automation.id);
    if (updated) this.arm(updated);
  }

  /** The user took over (toggled it on or off): whatever was automatic no longer applies. */
  clear(id: string): void {
    this.disarm(id);
    const automation = this.ports.get(id);
    if (automation?.health) this.ports.patch(id, { health: { ...withoutPause(automation.health), consecutiveFailures: 0, consecutiveUnreported: 0, probeAttempts: 0 } });
  }

  private disarm(id: string): void {
    const handle = this.timers.get(id);
    if (handle !== undefined) this.clock.clearTimeout(handle);
    this.timers.delete(id);
  }

  private arm(automation: Automation): void {
    this.disarm(automation.id);
    const at = automation.health?.nextProbeAt;
    if (at === undefined || automation.health?.pausedAt === undefined) return;
    const handle = this.clock.setTimeout(() => void this.probe(automation.id), Math.max(0, at - this.clock.now()));
    this.timers.set(automation.id, handle);
  }

  private async probe(id: string): Promise<void> {
    this.timers.delete(id);
    const automation = this.ports.get(id);
    if (!automation?.health?.pausedAt) return;
    let blocker: AutomationBlocker | null;
    try {
      blocker = await this.ports.probe(automation);
    } catch (err) {
      blocker = { kind: "other", detail: err instanceof Error ? err.message : String(err) };
    }
    const current = this.ports.get(id);
    if (!current?.health?.pausedAt) return; // the user took over while the probe ran
    const transition = recordProbe(current.health, blocker === null, this.clock.now());
    this.ports.patch(id, { health: transition.health });
    if (transition.resumed) {
      this.ports.setEnabled(id, true);
      this.ports.notify(current, "Resumed: the cause of the pause has cleared.");
    }
    const updated = this.ports.get(id);
    if (updated) this.arm(updated);
  }
}
