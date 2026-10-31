/**
 * Policy: the gate every incoming Trigger passes, the revalidation of a Mandate against current settings, and the effect a
 * settings change has on open tickets. Who may originate work is configured per Source in that Source's own identities.
 */
import { key } from "./core/text.js";
import { sameName } from "./core/text.js";
import type {
  AcceptMode, ActorRef, Admission, AdmissionCell, Mandate, MandateBasis, PolicyEffect, Strength, Thread, Ticket, Trigger,
} from "./core/types.js";
import { ADMISSION_DEFAULTS, type Allowed, type Settings } from "./settings.js";

export interface SourceScope {
  scope(input: { source: string; meta: Record<string, unknown> }): { listened: boolean; observed: boolean; row?: string };
}

export type GateResult =
  | { admissible: true; strength: Strength; basis: MandateBasis }
  | { admissible: false; reason: string };

export interface Policy {
  readonly version: string;
  readonly paused: boolean;
  readonly mode: AcceptMode;
  readonly evalTimeoutMs: number;
  gate(trigger: Trigger, thread: Thread, tickets: readonly Ticket[]): GateResult;
  /** True when an inferred candidate matching `rules` may be accepted without a person asking. */
  admitsInferred(rules: readonly string[]): boolean;
  /** True when the Mandate still holds under the current settings. */
  revalidate(mandate: Mandate): boolean;
  /** True when a person with this identity may currently originate work. */
  allowedSender(actor: ActorRef): boolean;
}

const POLICY_REVISION = "mandate-v3";

/** Version hash of the settings that affect work authorization; models, concurrency and pausing do not change it. */
export function policyVersion(settings: Settings): string {
  return key(POLICY_REVISION, JSON.stringify({ rules: settings.policy.rules, mode: settings.eval.mode, sources: settings.policy.sources }));
}

export const allowedSender = (settings: Settings, actor: ActorRef): Allowed | undefined =>
  settings.policy.sources[actor.source as "github"]?.allowed.find((entry) => sameName(entry.id, actor.id));

export const listedBot = (settings: Settings, actor: ActorRef): Allowed | undefined =>
  settings.policy.sources[actor.source as "github"]?.bots.find((entry) => sameName(entry.id, actor.id));

const senderName = (entry: Allowed): string => entry.name || entry.id;

/** True when a thread has a ticket of its own, other than context-only subscriptions. */
const participating = (thread: Thread, tickets: readonly Ticket[]): boolean =>
  [...thread.subscriptions, ...tickets.map((ticket) => ticket.id)].some((id) => !thread.context?.includes(id));

const admissionCell = (allowed: boolean, addressed: boolean): AdmissionCell | undefined =>
  allowed ? (addressed ? undefined : "listedUnaddressed") : addressed ? "unlistedAddressed" : "unlistedUnaddressed";

function admissionOf(settings: Settings, source: string, row: string | undefined, cell: AdmissionCell): Admission {
  const table = settings.policy.sources[source as "github"]?.admission as Record<string, Partial<Record<AdmissionCell, Admission>> | undefined> | undefined;
  return (row === undefined ? undefined : table?.[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell];
}

const STRENGTH: Readonly<Record<Admission, number>> = { ignore: 0, inferred: 1, explicit: 2 };

/** Builds the active Policy for gating Triggers and revalidating Mandates. */
export function settingsPolicy(settings: Settings, sources: SourceScope): Policy {
  const version = policyVersion(settings);
  const mode = settings.eval.mode;
  const ruleOn = (id: string) => settings.policy.rules.some((rule) => rule.enabled && rule.id === id);
  const rulesOn = (rules: readonly string[] | undefined) => (rules ?? []).every(ruleOn);

  /** Non-human triggers: only listed bots (as inferred candidates) and senderless system events may pass. */
  const machineGate = (trigger: Trigger): GateResult => {
    const bot = trigger.actor.id ? listedBot(settings, trigger.actor) : undefined;
    if (trigger.actor.id && !bot) return { admissible: false, reason: "not_human" };
    const scope = sources.scope({ source: trigger.source, meta: trigger.meta });
    if (!scope.listened || !(trigger.addressed || scope.observed)) return { admissible: false, reason: "not_human" };
    const recorded = { source: trigger.source, scope: trigger.meta, ...(scope.row === undefined ? {} : { row: scope.row }) };
    const addressed = trigger.addressed ? { addressed: trigger.addressed } : {};
    if (bot) {
      if (mode === "off") return { admissible: false, reason: "admission_ignored" };
      return { admissible: true, strength: "inferred", basis: { ...recorded, via: "bot", sender: senderName(bot), ...addressed, observation: { mode } } };
    }
    const cell = "unlistedUnaddressed" as const;
    if (admissionOf(settings, trigger.source, scope.row, cell) !== "inferred" || mode === "off") return { admissible: false, reason: "admission_ignored" };
    return { admissible: true, strength: "inferred", basis: { ...recorded, via: "admission", cell, observation: { mode } } };
  };

  return {
    version,
    paused: settings.paused,
    mode,
    evalTimeoutMs: settings.eval.timeoutSeconds * 1000,
    allowedSender: (actor) => !!allowedSender(settings, actor),
    gate(trigger, thread, tickets) {
      if (!trigger.human) return machineGate(trigger);
      const allowed = allowedSender(settings, trigger.actor);
      const scope = sources.scope({ source: trigger.source, meta: trigger.meta });
      const row = scope.listened ? scope.row : undefined;
      const recorded = { source: trigger.source, scope: trigger.meta, ...(row === undefined ? {} : { row }), ...(allowed ? { sender: senderName(allowed) } : {}) };
      if (allowed && trigger.addressed) {
        return { admissible: true, strength: "explicit", basis: { ...recorded, via: "addressed", addressed: trigger.addressed } };
      }
      const cell = admissionCell(!!allowed, !!trigger.addressed)!;
      // An unaddressed message uses the admission table only where the Source observes every message of that scope.
      const receivable = !!trigger.addressed || (scope.listened && scope.observed);
      const admission = receivable ? admissionOf(settings, trigger.source, row, cell) : "ignore";
      const basis = { ...recorded, via: "admission" as const, cell, ...(trigger.addressed ? { addressed: trigger.addressed } : {}) };
      // An explicit table cell comes before thread follow-ups, so a thread's tickets never weaken an explicit request.
      if (admission === "explicit") return { admissible: true, strength: "explicit", basis };
      // Direct-message threads belong to one sender; inferred follow-ups need an accept mode other than off.
      if (!(trigger.addressed === "direct" && !allowed) && (allowed || mode !== "off") && participating(thread, tickets)) {
        return { admissible: true, strength: allowed ? "explicit" : "inferred", basis: { ...recorded, via: "followup" } };
      }
      if (admission === "inferred" && mode !== "off") return { admissible: true, strength: "inferred", basis: { ...basis, observation: { mode } } };
      return { admissible: false, reason: !allowed ? "not_a_member" : receivable && admission === "ignore" ? "admission_ignored" : "no_mention" };
    },
    admitsInferred: (rules) => mode === "auto" && rules.length > 0 && rulesOn(rules),
    revalidate(mandate) {
      const { basis } = mandate;
      const source = basis.source;
      const current = source && basis.scope ? sources.scope({ source, meta: basis.scope }) : undefined;
      if (current && !current.listened) return false;
      if (basis.via === "followup") return mandate.strength === "explicit" || (mode === "auto" && rulesOn(basis.rules));
      if (basis.via === "bot" && !listedBot(settings, mandate.actor)) return false;
      if (basis.via === "admission") {
        const { cell } = basis;
        const listed = !!allowedSender(settings, mandate.actor);
        if (cell === "unlistedAddressed" && listed) return true;
        const now = cell === "unlistedUnaddressed" && listed ? "listedUnaddressed" : cell;
        if (now === "listedUnaddressed" && !listed) return false;
        const admission = admissionOf(settings, source ?? "", current?.listened ? current.row : undefined, now);
        if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false;
        if (mandate.strength === "explicit") return true;
      } else if (basis.via !== "bot" && !allowedSender(settings, mandate.actor)) return false;
      // An observed (inferred) mandate holds only while auto mode is on and its matched rules stay enabled.
      if ((basis.via === "admission" || basis.via === "bot") && basis.observation) return mode === "auto" && rulesOn(basis.rules);
      return true;
    },
  };
}

/** How a settings change from `old` to `now` bears on each open ticket's authorization or matched rules. */
export function policyEffects(
  tickets: readonly Ticket[],
  old: Settings,
  now: Settings,
  scope: (settings: Settings) => SourceScope,
): Map<string, PolicyEffect> {
  const before = settingsPolicy(old, scope(old));
  const after = settingsPolicy(now, scope(now));
  const effects = new Map<string, PolicyEffect>();
  for (const ticket of tickets) {
    const rules = (ticket.mandate.basis.rules ?? []).flatMap((id): NonNullable<PolicyEffect["rules"]> => {
      const was = old.policy.rules.find((rule) => rule.id === id);
      const is = now.policy.rules.find((rule) => rule.id === id);
      if (!is?.enabled) return was?.enabled ? [{ id, name: was.name, change: "disabled" }] : [];
      return JSON.stringify(was) === JSON.stringify(is) ? [] : [{ id, name: is.name, change: "changed", instruction: is.instruction }];
    });
    const effect: PolicyEffect = rules.length ? { rules } : {};
    if (before.revalidate(ticket.mandate) && !after.revalidate(ticket.mandate)) {
      // With the previous accept mode and rules, the mandate would still hold unless the sender or scope lost authorization.
      const asBefore = { ...now, eval: old.eval, policy: { ...now.policy, rules: old.policy.rules } };
      if (!settingsPolicy(asBefore, scope(now)).revalidate(ticket.mandate)) Object.assign(effect, { requesterAllowed: false, requester: ticket.mandate.actor });
      else if (ticket.mandate.strength === "inferred" && old.eval.mode === "auto" && now.eval.mode !== "auto") effect.proactive = false;
    }
    if (Object.keys(effect).length) effects.set(ticket.id, effect);
  }
  return effects;
}
