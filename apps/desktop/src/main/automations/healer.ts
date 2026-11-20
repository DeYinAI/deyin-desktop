import { randomUUID } from "node:crypto";
import { errorCategory } from "@deyin/agent-core";
import { isHumanBlocker } from "@deyin/host-core";
import type { Automation, AutomationHealth, AutomationRun, LearnedRevision } from "@deyin/host-core";
import { systemClock, type Clock } from "./watchdog.js";

/**
 * Self-healing by learned rules.
 *
 * When a run fails in a way a rule could prevent, a bounded model call reads what happened and proposes a
 * few short rules. They are appended to the automation's prompt at lower priority than the task itself — so
 * the healer can sharpen *how* a run goes about its job, and can never change *what* the job is, its
 * schedule, model, limits, sites or account. A mechanical validator (not a model) enforces that; the next
 * run is a probation, and a patch that does not help is rolled back and the failure left for a person.
 *
 * This file is pure of Electron and of the model call, which is injected, so every rule of the loop is tested.
 */

export const MAX_LEARNED_RULES = 12;
export const MAX_RULE_CHARS = 200;
const MIN_RULE_CHARS = 12;
const MAX_RATIONALE_CHARS = 400;
/** The least time between two patches for the same failure. */
export const HEAL_COOLDOWN_MS = 24 * 3_600_000;
/** Revisions kept for the Healing panel; the oldest resolved ones go first. */
const MAX_REVISIONS = 30;

export interface Proposal {
  add: string[];
  remove: string[];
  rationale: string;
}

/* Signature --------------------------------------------------------------------------------- */

/** "tool: result" → "result", so the error category sees the error rather than the tool's name. */
function withoutToolPrefix(error: string): string {
  return error.replace(/^[a-z][a-z0-9_]*: /i, "");
}

/**
 * What kind of failure a run was: how it ended, the last tool it used, and the category of its last error.
 * Two runs that fail the same way share a signature, which is what the cooldown and "unhealable" key on.
 */
export function failureSignature(run: Pick<AutomationRun, "outcome" | "reason" | "summary">): string {
  const tool = run.summary?.lastTool ?? "none";
  const cause = withoutToolPrefix(run.summary?.lastError ?? run.reason ?? "");
  return `${run.outcome ?? "none"}:${tool}:${errorCategory(cause)}`.slice(0, 160);
}

/* Eligibility ------------------------------------------------------------------------------- */

export type HealDecision = { heal: true; signature: string } | { heal: false; why: string };

/** The revision still on probation, if the last patch has not been judged yet. */
export function probationRevision(automation: Pick<Automation, "learnedRevisions">): LearnedRevision | undefined {
  return [...(automation.learnedRevisions ?? [])].reverse().find((revision) => revision.status === "probation");
}

/** Whether a finished run should be healed: only failures a rule could prevent, never twice for one failure in a day. */
export function healDecision(automation: Automation, run: AutomationRun, now: number): HealDecision {
  if (automation.autoHeal === false) return { heal: false, why: "self-healing is off for this automation" };
  // Learned rules ride in the system prompt of a local prompt run; other runs would never see them.
  if (automation.target.kind !== "local" || automation.payload.kind !== "prompt") {
    return { heal: false, why: "learned rules apply to local prompt automations only" };
  }
  if (run.outcome !== "failed" && run.outcome !== "unreported") return { heal: false, why: `a ${run.outcome ?? "stopped"} run is not a failure a rule can fix` };
  if (run.blocker && isHumanBlocker(run.blocker.kind)) return { heal: false, why: "only a person can clear this" };
  if (probationRevision(automation)) return { heal: false, why: "the last patch has not been judged yet" };
  const signature = failureSignature(run);
  if (automation.health?.unhealable?.includes(signature)) return { heal: false, why: "an earlier patch for this failure made it worse" };
  const last = automation.health?.healedAt?.[signature];
  if (last !== undefined && now - last < HEAL_COOLDOWN_MS) return { heal: false, why: "this failure was already tried today" };
  return { heal: true, signature };
}

/* Validation -------------------------------------------------------------------------------- */

/**
 * What a learned rule may never say. Deliberately blunt: a false positive costs one rejected rule, a false
 * negative lets a model that was fed a hostile web page rewrite what an unattended run is allowed to do.
 */
const FORBIDDEN: ReadonlyArray<{ matches: (rule: string) => boolean; why: string }> = [
  { matches: (r) => /\b(cap|caps|limit|limits|quota|quotas|rate|per hour|per day|a day|an hour|unlimited|throttl\w*|budget)\b/i.test(r), why: "mentions caps or limits, which belong to the task" },
  { matches: (r) => /\b(log ?in|login|sign ?in|signin|sign ?up|password|passcode|credentials?|2fa|two-factor|otp|captcha|verify (that )?it'?s you|api[- ]?key|secret|token)\b/i.test(r), why: "mentions logging in or credentials" },
  { matches: (r) => /@\w+/.test(r), why: "names or changes an account handle" },
  { matches: (r) => /\b(switch|change|use|post as|act as|log into)\b.{0,24}\b(accounts?|profiles?|identity)\b/i.test(r), why: "changes the account" },
  { matches: (r) => /\b(ignore|override|supersede|disregard|overrule|replace|instead of)\b.{0,40}\b(prompt|instructions?|rules?|playbook|above|earlier|previous|task)\b/i.test(r), why: "tries to override the task" },
  { matches: (r) => /\b(computer_|powershell|sendinput|sendkeys|autohotkey|xdotool|pyautogui|osascript|uiautomation|pywinauto)\b/i.test(r), why: "points at OS input synthesis" },
  { matches: (r) => /\b(workaround|work around|work-around|bypass|circumvent|evade|disable)\b/i.test(r), why: "asks to get around a guard" },
  // "Report success only after the post is verified" is the rule we want; "report success regardless" is not.
  { matches: (r) => /\b(always|even if|regardless|whatever|no matter)\b.{0,40}\b(success|succeeded|done|complete\w*)\b/i.test(r), why: "tells the run to claim success regardless" },
  { matches: (r) => /\b(report|mark|claim|say|call it)\b.{0,20}\b(success|succeeded)\b/i.test(r) && !/\b(only|verified|verifying|verify|confirmed|confirming|confirm)\b/i.test(r), why: "tells the run what to report without a verification condition" },
  { matches: (r) => /\b(skip|omit|without|don'?t|do not|never|no need to|stop)\s+(\w+\s+)?(verify|verifying|verification|check|checking|log|logging|report|reporting)\b/i.test(r), why: "skips verification, logging or reporting" },
  { matches: (r) => /https?:\/\//i.test(r), why: "names a URL" },
  { matches: (r) => /\b(delete|unfollow|dm|direct message|purchase|buy|pay|payment|transfer|install|sudo|rm -rf|format (the )?(disk|drive))\b/i.test(r), why: "adds an action the task does not have" },
  { matches: (r) => /[\u0000-\u0008\u000e-\u001f]/.test(r), why: "is not plain text" },
];

export type Validation = { ok: true; rules: string[]; added: string[]; removed: string[]; rationale: string } | { ok: false; reason: string };

const asStrings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : null;

/** Reads the `propose_learned_rules` arguments; null when they are not the right shape. */
export function parseProposal(args: Record<string, unknown>): Proposal | null {
  const add = args.add === undefined ? [] : asStrings(args.add);
  const remove = args.remove === undefined ? [] : asStrings(args.remove);
  if (add === null || remove === null || typeof args.rationale !== "string") return null;
  return { add, remove, rationale: args.rationale };
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Applies a proposal to the current rules, or says why it may not be applied. */
export function validateProposal(proposal: Proposal, current: readonly string[]): Validation {
  const rationale = squash(proposal.rationale).slice(0, MAX_RATIONALE_CHARS);
  if (!rationale) return { ok: false, reason: "no rationale given" };

  const removed: string[] = [];
  for (const raw of proposal.remove) {
    const target = current.find((rule) => rule.toLowerCase() === squash(raw).toLowerCase());
    if (!target) return { ok: false, reason: `cannot remove a rule that does not exist: "${squash(raw).slice(0, 60)}"` };
    if (!removed.includes(target)) removed.push(target);
  }

  const kept = current.filter((rule) => !removed.includes(rule));
  const added: string[] = [];
  for (const raw of proposal.add) {
    if (/[\n\r]/.test(raw.trim())) return { ok: false, reason: `rule "${squash(raw).slice(0, 60)}…" is not a single line of plain text` };
    const rule = squash(raw);
    if (rule.length < MIN_RULE_CHARS) return { ok: false, reason: `rule is too short to mean anything: "${rule}"` };
    if (rule.length > MAX_RULE_CHARS) return { ok: false, reason: `rule is longer than ${MAX_RULE_CHARS} characters: "${rule.slice(0, 60)}…"` };
    const forbidden = FORBIDDEN.find((entry) => entry.matches(rule));
    if (forbidden) return { ok: false, reason: `rule "${rule.slice(0, 60)}${rule.length > 60 ? "…" : ""}" ${forbidden.why}` };
    const duplicate = [...kept, ...added].some((existing) => existing.toLowerCase() === rule.toLowerCase());
    if (!duplicate) added.push(rule);
  }

  if (added.length === 0 && removed.length === 0) return { ok: false, reason: "nothing to change" };
  const rules = [...kept, ...added];
  if (rules.length > MAX_LEARNED_RULES) return { ok: false, reason: `that would leave ${rules.length} rules; the most is ${MAX_LEARNED_RULES}` };
  return { ok: true, rules, added, removed, rationale };
}

/* Patches ----------------------------------------------------------------------------------- */

/** What the runner may write back: only the healer-owned fields, never the task. */
export interface RuntimePatch {
  learnedRules: string[] | undefined;
  learnedRevisions: LearnedRevision[];
  health: AutomationHealth;
}

function health(automation: Pick<Automation, "health">): AutomationHealth {
  return automation.health ?? { consecutiveFailures: 0 };
}

/** Keeps the history bounded, dropping resolved revisions before ones still being judged. */
function trimRevisions(revisions: LearnedRevision[]): LearnedRevision[] {
  let out = revisions;
  while (out.length > MAX_REVISIONS) {
    const drop = out.findIndex((revision) => revision.status !== "probation");
    out = out.filter((_, index) => index !== (drop === -1 ? 0 : drop));
  }
  return out;
}

/** The record that this run's failure was attempted, written before the model is called so a crash cannot loop. */
export function stampAttempt(automation: Pick<Automation, "health">, signature: string, now: number): AutomationHealth {
  const current = health(automation);
  return { ...current, healedAt: { ...current.healedAt, [signature]: now } };
}

export function applyValidProposal(
  automation: Pick<Automation, "learnedRules" | "learnedRevisions" | "health">,
  valid: Extract<Validation, { ok: true }>,
  run: Pick<AutomationRun, "id">,
  signature: string,
  now: number,
  id: string,
): RuntimePatch {
  const revision: LearnedRevision = {
    id,
    at: now,
    runId: run.id,
    signature,
    rationale: valid.rationale,
    added: valid.added,
    removed: valid.removed,
    previousRules: [...(automation.learnedRules ?? [])],
    baselineFailures: health(automation).consecutiveFailures,
    status: "probation",
  };
  return {
    learnedRules: valid.rules,
    learnedRevisions: trimRevisions([...(automation.learnedRevisions ?? []), revision]),
    health: stampAttempt(automation, signature, now),
  };
}

export type Judgement = { kind: "kept"; revision: LearnedRevision; patch: RuntimePatch } | { kind: "reverted"; revision: LearnedRevision; patch: RuntimePatch };

/**
 * Judges the patch on probation by the first run that started after it. A run that did its job keeps it; a
 * run that failed again rolls it back and marks the failure as one only a person can fix. Runs that say
 * nothing about the rules (blocked, stopped) leave the patch on probation.
 */
export function judgeProbation(automation: Automation, run: AutomationRun, now: number): Judgement | null {
  const revision = probationRevision(automation);
  if (!revision || run.startedAt < revision.at || run.outcome === undefined) return null;
  const resolve = (status: "kept" | "reverted", note: string): LearnedRevision => ({ ...revision, status, resolvedAt: now, note });
  const replace = (next: LearnedRevision): LearnedRevision[] => (automation.learnedRevisions ?? []).map((r) => (r.id === next.id ? next : r));

  if (run.outcome === "success" || run.outcome === "idle") {
    const next = resolve("kept", `The next run went fine (${run.outcome}).`);
    return { kind: "kept", revision: next, patch: { learnedRules: automation.learnedRules, learnedRevisions: replace(next), health: health(automation) } };
  }
  if (run.outcome === "failed" || run.outcome === "unreported") {
    const next = resolve("reverted", `The next run ${run.outcome === "failed" ? "failed" : "finished without reporting"} again, so the patch was rolled back.`);
    const current = health(automation);
    return {
      kind: "reverted",
      revision: next,
      patch: {
        learnedRules: revision.previousRules.length > 0 ? revision.previousRules : undefined,
        learnedRevisions: replace(next),
        health: { ...current, unhealable: [...new Set([...(current.unhealable ?? []), revision.signature])] },
      },
    };
  }
  return null;
}

/**
 * Undoes a revision and every one after it, restoring the rules from before it. A person rejecting a patch also
 * means "do not try that again": its failure is marked as one for them to fix.
 */
export function revertRevision(automation: Automation, revisionId: string, now: number): RuntimePatch | null {
  const revisions = automation.learnedRevisions ?? [];
  const index = revisions.findIndex((revision) => revision.id === revisionId);
  const target = revisions[index];
  if (!target || target.status === "reverted") return null;
  const reverted = revisions.map((revision, i) =>
    i >= index && revision.status !== "reverted" ? { ...revision, status: "reverted" as const, resolvedAt: now, note: "Reverted by you." } : revision,
  );
  const current = health(automation);
  const signatures = revisions.slice(index).filter((revision) => revision.status !== "reverted").map((revision) => revision.signature);
  return {
    learnedRules: target.previousRules.length > 0 ? target.previousRules : undefined,
    learnedRevisions: reverted,
    health: { ...current, unhealable: [...new Set([...(current.unhealable ?? []), ...signatures])] },
  };
}

/** What a person is told after a patch, in one line. */
export function describePatch(revision: Pick<LearnedRevision, "added" | "removed" | "rationale">): string {
  const parts: string[] = [];
  if (revision.added.length) parts.push(`added ${revision.added.length === 1 ? `"${revision.added[0]}"` : `${revision.added.length} rules`}`);
  if (revision.removed.length) parts.push(`removed ${revision.removed.length} rule${revision.removed.length === 1 ? "" : "s"}`);
  return `Self-healing ${parts.join(" and ")}. ${revision.rationale}`;
}

/* The loop ---------------------------------------------------------------------------------- */

export interface HealerPorts {
  get(id: string): Automation | undefined;
  /** Writes healer-owned fields without touching `updatedAt`, the catch-up floor. */
  patch(id: string, patch: Partial<RuntimePatch>): void;
  /** Asks a model what rule would have prevented this failure. null when it had nothing to propose or could not answer. */
  propose(automation: Automation, run: AutomationRun): Promise<Proposal | null>;
  notify(automation: Automation, message: string): void;
  clock?: Clock;
  newId?: () => string;
}

export class Healer {
  /** One heal at a time per automation: a second failure while the model is thinking adds nothing. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly ports: HealerPorts) {}

  private now(): number {
    return (this.ports.clock ?? systemClock).now();
  }

  /** Call for every finished run. Judges a patch on probation at once; any new heal runs in the background. */
  recordRun(run: AutomationRun): void {
    const automation = this.ports.get(run.automationId);
    if (!automation || run.outcome === undefined) return;

    const judged = judgeProbation(automation, run, this.now());
    if (judged) {
      this.ports.patch(automation.id, judged.patch);
      if (judged.kind === "reverted") {
        this.ports.notify(automation, `Self-healing rolled back its last change because the next run failed again. This failure needs you. ${describePatch(judged.revision)}`);
        return;
      }
    }

    const fresh = this.ports.get(automation.id);
    if (!fresh || this.inFlight.has(fresh.id)) return;
    const decision = healDecision(fresh, run, this.now());
    if (!decision.heal) return;
    // Stamped before the model is asked, so a failure that keeps recurring costs one attempt a day, not one a run.
    this.ports.patch(fresh.id, { health: stampAttempt(fresh, decision.signature, this.now()) });
    const task = this.heal(fresh, run, decision.signature).finally(() => this.inFlight.delete(fresh.id));
    this.inFlight.set(fresh.id, task);
  }

  /** Resolves when no heal is in flight. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
  }

  /** A person undoing a patch from the Healing panel. False when there was nothing to undo. */
  revert(automationId: string, revisionId: string): boolean {
    const automation = this.ports.get(automationId);
    if (!automation) return false;
    const patch = revertRevision(automation, revisionId, this.now());
    if (!patch) return false;
    this.ports.patch(automationId, patch);
    return true;
  }

  private async heal(automation: Automation, run: AutomationRun, signature: string): Promise<void> {
    let proposal: Proposal | null;
    try {
      proposal = await this.ports.propose(automation, run);
    } catch {
      return; // The healer is best effort: a model hiccup must never turn into a second failure.
    }
    if (!proposal) return;

    const latest = this.ports.get(automation.id);
    // A person edited the task or the rules while the model was thinking: what it saw is stale.
    if (!latest || latest.updatedAt !== automation.updatedAt || JSON.stringify(latest.learnedRules ?? []) !== JSON.stringify(automation.learnedRules ?? [])) return;

    const valid = validateProposal(proposal, latest.learnedRules ?? []);
    if (!valid.ok) return;
    const patch = applyValidProposal(latest, valid, run, signature, this.now(), (this.ports.newId ?? randomUUID)());
    this.ports.patch(latest.id, patch);
    const revision = patch.learnedRevisions[patch.learnedRevisions.length - 1];
    if (revision) this.ports.notify(latest, describePatch(revision));
  }
}
