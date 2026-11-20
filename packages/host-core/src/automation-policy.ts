import type { Automation, AutomationBlockerKind, AutomationLimits } from "./types.js";

/** One run's bounds when an automation does not set its own. */
export const DEFAULT_AUTOMATION_LIMITS: AutomationLimits = {
  maxMinutes: 15,
  idleMinutes: 5,
  maxSteps: 120,
};

const LIMIT_BOUNDS: Record<keyof AutomationLimits, { min: number; max: number }> = {
  maxMinutes: { min: 1, max: 240 },
  idleMinutes: { min: 1, max: 60 },
  maxSteps: { min: 1, max: 1_000 },
};

function bounded(value: unknown, key: keyof AutomationLimits): number {
  const { min, max } = LIMIT_BOUNDS[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_AUTOMATION_LIMITS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** What is wrong with limits a person or agent supplied, or null when they are usable. */
export function limitsError(limits: Partial<AutomationLimits> | undefined): string | null {
  if (!limits) return null;
  const names: Record<keyof AutomationLimits, string> = { maxMinutes: "Run time limit (minutes)", idleMinutes: "Quiet limit (minutes)", maxSteps: "Step limit" };
  for (const key of Object.keys(LIMIT_BOUNDS) as Array<keyof AutomationLimits>) {
    const value = limits[key];
    if (value === undefined) continue;
    const { min, max } = LIMIT_BOUNDS[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      return `${names[key]} must be a whole number from ${min} to ${max}.`;
    }
  }
  if (limits.maxMinutes !== undefined && limits.idleMinutes !== undefined && limits.idleMinutes > limits.maxMinutes) {
    return "The quiet limit cannot be longer than the run time limit.";
  }
  return null;
}

/** The limits a run is held to: the automation's own, clamped, over the defaults. */
export function resolveLimits(automation: Pick<Automation, "limits">): AutomationLimits {
  const own = automation.limits ?? {};
  const maxMinutes = bounded(own.maxMinutes, "maxMinutes");
  return {
    maxMinutes,
    // A quiet period longer than the whole run could never trip.
    idleMinutes: Math.min(bounded(own.idleMinutes, "idleMinutes"), maxMinutes),
    maxSteps: bounded(own.maxSteps, "maxSteps"),
  };
}

/**
 * Blockers only a person can clear: a login wall, a captcha, a locked or warned
 * account, a site the automation has no consent for, a tool the user switched off.
 * An unattended run retrying one of these would only repeat the failure.
 */
const HUMAN_BLOCKERS: ReadonlySet<AutomationBlockerKind> = new Set<AutomationBlockerKind>([
  "login-required",
  "captcha",
  "account-warning",
  "approval-required",
  "stopped",
]);

export function isHumanBlocker(kind: AutomationBlockerKind): boolean {
  return HUMAN_BLOCKERS.has(kind);
}

export const BLOCKER_KINDS: readonly AutomationBlockerKind[] = [
  "login-required",
  "captcha",
  "account-warning",
  "approval-required",
  "stopped",
  "rate-limit",
  "tool-missing",
  "mcp",
  "auth",
  "other",
];

export function isBlockerKind(value: unknown): value is AutomationBlockerKind {
  return typeof value === "string" && (BLOCKER_KINDS as readonly string[]).includes(value);
}
