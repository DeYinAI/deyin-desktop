import type { Reason } from "./types.js";

/** English text of the codes the core records; a Source's or gate's own codes fall back to the code itself. */
export const REASONS: Readonly<Record<string, string>> = {
  explicitRouted: "Routed as an explicit request",
  humanStop: "A person asked to stop",
  routed: "Routed to an existing ticket",
  timeout: "The assessment timed out",
  policyChanged: "The policy changed while the assessment ran",
  stopNotExplicit: "Only an explicit message from an allowed sender stops a ticket",
  stopUnknown: "No such ticket to stop",
  directionUnsettled: "The direction is not settled: no requested implementation, no established target, or an open design decision",
  noRuleMatched: "No enabled rule matched",
  observed: "Would accept, recorded only in observe mode: {text}",
  ignoredFromCard: "Ignored from its card: {text}",
  said: "{text}",
  not_human: "Not a person's message",
  not_a_member: "The sender is not on the allowed list",
  no_mention: "The agent was not addressed",
  admission_ignored: "The admission table ignores this kind of message",
  filteredSelf: "Written by the agent itself",
  outOfScope: "Outside the watched repository",
};

export function reasonText(reason: Reason | readonly Reason[] | string): string {
  if (typeof reason === "string") return reason;
  if (Array.isArray(reason)) return (reason as readonly Reason[]).map((item) => reasonText(item)).join("; ");
  const one = reason as Reason;
  const template = REASONS[one.code] ?? one.code;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (one.values && name in one.values ? String(one.values[name]) : match));
}

/** A free-text reason as a core `said` reason; a Reason passes through. */
export const asReason = (reason: string | Reason): Reason => (typeof reason === "string" ? { code: "said", values: { text: reason } } : reason);
