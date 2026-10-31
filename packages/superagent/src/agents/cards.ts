/** Compact, bounded model-facing projections of triggers, tickets, threads, decisions and inputs; full texts stay behind resources. */
import { latestAssignment, ticketStage } from "../core/model.js";
import { reasonText } from "../core/reasons.js";
import type { State } from "../core/state.js";
import { preview } from "../core/text.js";
import type { Candidate, Decision, PolicyEffect, Thread, Ticket, TicketInput, Trigger, TriggerDisposition } from "../core/types.js";
import { threadKey } from "../core/types.js";
import type { Settings } from "../settings.js";

export { textPage } from "../core/text.js";

const TRIGGER_CHARS = 600;
const ASSIGNMENT_CHARS = 1500;
export const INPUT_PAGE = 10;
export const ASSIGNMENT_PAGE = 3;

const capped = (text: string, limit: number, read: string) => (text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read });

export function triggerCard(trigger: Trigger, disposition?: TriggerDisposition) {
  return {
    trigger_id: trigger.id,
    source: trigger.source,
    ...(trigger.url ? { source_url: trigger.url } : {}),
    actor: trigger.actor.id,
    thread: threadKey(trigger.threads[0]!),
    human: trigger.human,
    at: trigger.at,
    preview: preview(trigger.text),
    chars: trigger.text.length,
    read: `trigger/${trigger.id}`,
    ...(disposition
      ? {
          disposition: {
            ...(disposition.filtered ? { filtered: reasonText(disposition.filtered) } : {}),
            ...(disposition.decisionId ? { decision_id: disposition.decisionId } : {}),
            delivered_to: disposition.fanout,
          },
        }
      : {}),
  };
}

/** A trigger as models read it; `allowed` says whether its sender may direct work, which bots and strangers never do. */
export function triggerMessage(trigger: Trigger, options: { allowed?: boolean; note?: string; context?: boolean; repliesTo?: Trigger } = {}) {
  return {
    trigger_id: trigger.id,
    from: trigger.actor.id,
    thread: threadKey(trigger.threads[0]!),
    at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`),
    ...(trigger.url ? { source_url: trigger.url } : {}),
    ...(trigger.human ? { sender_allowed: options.allowed === true } : { bot: true }),
    ...(options.note ? { routing_note: options.note } : {}),
    ...(options.context ? { context: true } : {}),
    ...(options.repliesTo ? { replies_to: { trigger_id: options.repliesTo.id, preview: preview(options.repliesTo.text) } } : {}),
  };
}

/** The PR a ticket claimed, or whose thread it was opened from. */
export function pullNumber(ticket: Ticket): number | undefined {
  const follow = ticket.follows?.find((item) => item.own) ?? ticket.follows?.[0];
  const number = follow ? Number(follow.thread.slice(follow.thread.indexOf(":") + 1)) : NaN;
  return Number.isInteger(number) ? number : undefined;
}

export const TICKET_STATES = ["person/review", "person/answer", "person/blocked", "person/delivery", "failed", "working", "working/queued", "idle", "completed", "merged", "closed", "dropped", "stopped"] as const;
export type TicketCardState = (typeof TICKET_STATES)[number];

function cardState(ticket: Ticket): TicketCardState {
  if (ticket.ended) return ticket.ended.outcome;
  const stage = ticketStage(ticket);
  switch (stage) {
    case "review": return "person/review";
    case "person": return "person/answer";
    case "blocked": return "person/blocked";
    case "delivery": return "person/delivery";
    case "failed": return "failed";
    case "queued": return "working/queued";
    case "working": return "working";
    case "waiting": return "idle";
    case "ended": return "dropped";
    default: {
      const never: never = stage;
      throw new Error(`Unhandled stage ${String(never)}`);
    }
  }
}

export function ticketCard(ticket: Ticket) {
  const latest = latestAssignment(ticket)?.report;
  const pull = pullNumber(ticket);
  return {
    ticket_id: ticket.id,
    title: ticket.title,
    state: cardState(ticket),
    strength: ticket.mandate.strength,
    ...(pull ? { pr_number: pull } : {}),
    ...(ticket.ended ? { ended: { at: ticket.ended.at, by: ticket.ended.by, reason: ticket.ended.reason ?? ticket.ended.outcome } } : {}),
    ...(ticket.attention ? { attention: { question: ticket.attention.question, ...(ticket.attention.triggerId ? { trigger_id: ticket.attention.triggerId } : {}) } } : {}),
    preview: preview(latest?.summary ?? ""),
    read: `ticket/${ticket.id}`,
  };
}

export function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return "Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.";
  return [
    "Policy change:",
    ...(effect.rules ?? []).map((rule) =>
      rule.change === "disabled"
        ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
        : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`,
    ),
    ...(effect.proactive === false
      ? ["Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only what is in progress within the assignment, or report dropped, and take on nothing new."]
      : []),
    ...(effect.requesterAllowed === false
      ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : "who asked for it"}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`]
      : []),
  ].join("\n");
}

export const RESUMED =
  "This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.";

export interface InputContext {
  state: State;
  allowed(trigger: Trigger): boolean;
}

/** One ticket input as the worker reads it; `undefined` for an input with nothing to say. */
export function inputMessage(ctx: InputContext, ticket: Ticket, input: TicketInput): string | undefined {
  switch (input.kind) {
    case "trigger": {
      const trigger = ctx.state.triggers.get(input.triggerId);
      if (!trigger) return JSON.stringify({ trigger_id: input.triggerId, read: `trigger/${input.triggerId}` });
      const parent = parentOf(ctx.state, trigger);
      const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some((item) => item.kind === "trigger" && item.triggerId === parent.id));
      return JSON.stringify(triggerMessage(trigger, { allowed: ctx.allowed(trigger), ...(input.note ? { note: input.note } : {}), ...(input.context ? { context: true } : {}), ...(parent && !seen ? { repliesTo: parent } : {}) }));
    }
    case "policy-changed": return policyMessage(input.effect);
    case "resumed": return RESUMED;
    case "note": return `Note from the orchestrator, for context only: ${input.text}`;
    case "text": return input.text;
    default: {
      const never: never = input;
      throw new Error(`Unhandled input ${JSON.stringify(never)}`);
    }
  }
}

/** The message a review comment replies to, when it is on file. */
function parentOf(state: State, trigger: Trigger): Trigger | undefined {
  const reply = trigger.meta.inReplyTo;
  if (typeof reply !== "number") return undefined;
  for (const candidate of state.triggers.values()) if (candidate.meta.commentId === reply && candidate.meta.number === trigger.meta.number) return candidate;
  return undefined;
}

/** The first message of a worker's first run: what the ticket is; the origin trigger arrives as its first input. */
export function assignmentMessage(ticket: Ticket, options: { first: boolean }): string {
  const text = ticket.execution?.assignment ?? "";
  const { text: brief, chars, read } = capped(text, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`);
  if (!options.first) return JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length });
  return JSON.stringify({
    ticket_id: ticket.id,
    title: ticket.title,
    ...(brief ? { assignment: brief } : {}),
    ...(read ? { assignment_chars: chars, assignment_read: read } : {}),
    scope: ticket.mandate.scope,
    requested_by: ticket.mandate.actor.id,
  });
}

export function newestPage<T, L>(items: readonly T[], offset: number, size: number, line: (item: T) => L, next: string) {
  const newest = items.slice().reverse();
  const more = offset + size < newest.length;
  return { items: newest.slice(offset, offset + size).map(line), ...(more ? { next_resource: next, next_offset: offset + size } : {}) };
}

export function inputLine(ticket: Ticket, input: TicketInput) {
  const base = { id: input.id, kind: input.kind, at: input.at, ...(ticket.undelivered.includes(input.id) ? { undelivered: true } : {}) };
  switch (input.kind) {
    case "trigger":
    case "resumed": return { ...base, trigger_id: input.triggerId };
    case "text":
    case "note": return { ...base, ...(input.text.length <= 80 ? { text: input.text } : { preview: preview(input.text, 80), chars: input.text.length, read: `ticket/${ticket.id}/input/${input.id}` }) };
    case "policy-changed": return { ...base, read: `ticket/${ticket.id}/input/${input.id}` };
    default: {
      const never: never = input;
      throw new Error(`Unhandled input ${JSON.stringify(never)}`);
    }
  }
}

export function assignmentLine(ticket: Ticket, item: Ticket["assignments"][number]) {
  return {
    id: item.id,
    state: item.state,
    at: item.createdAt,
    ...(item.endedReason ? { ended_reason: item.endedReason } : {}),
    ...(item.report ? { report: { state: item.report.state, at: item.report.at, preview: preview(item.report.summary, 100), chars: item.report.summary.length, read: `ticket/${ticket.id}/report/${item.id}` } } : {}),
  };
}

export function ticketDetails(ticket: Ticket, threads: { thread: string; context?: true; own?: true }[], worker: boolean) {
  const { preview: _preview, ...card } = ticketCard(ticket);
  return {
    ...card,
    trigger_id: ticket.origin.triggerId,
    ...(worker ? {} : { decision_id: ticket.decisionId }),
    threads,
    directory: ticket.execution?.directory,
    scope: ticket.mandate.scope,
    requested_by: ticket.mandate.actor.id,
    assignments: newestPage(ticket.assignments, 0, ASSIGNMENT_PAGE, (item) => assignmentLine(ticket, item), `ticket/${ticket.id}/assignments`),
    inputs: newestPage(ticket.inputs, 0, INPUT_PAGE, (input) => inputLine(ticket, input), `ticket/${ticket.id}/inputs`),
    assignment: `ticket/${ticket.id}/assignment`,
    result: `ticket/${ticket.id}/result`,
  };
}

export function threadCard(thread: Thread) {
  return {
    thread: thread.key,
    source: thread.ref.source,
    tickets: thread.subscriptions,
    ...(thread.evaluating ? { evaluating: { since: thread.evaluating.startedAt, deadline: thread.evaluating.deadline } } : {}),
    pending: thread.pending.length,
    ...(typeof thread.meta.url === "string" ? { url: thread.meta.url } : {}),
    read: `thread/${thread.key}`,
  };
}

export function decisionCard(decision: Decision) {
  return {
    decision_id: decision.id,
    kind: decision.kind,
    reason: reasonText(decision.reason),
    strength: decision.strength,
    thread: decision.threadKey,
    trigger_ids: decision.triggerIds,
    ...(decision.ticketId ? { ticket_id: decision.ticketId } : {}),
    at: decision.at,
    read: `decision/${decision.id}`,
  };
}

export function decisionDetails(decision: Decision) {
  const mandate = decision.mandate && (({ policyVersion: _version, ...rest }) => rest)(decision.mandate);
  return { ...decisionCard(decision), ...(mandate ? { mandate } : {}), ...(decision.audit ? { audit: decision.audit } : {}) };
}

export function relatedTickets(tickets: readonly Ticket[]) {
  const order = [...tickets].sort((a, b) => (Number(!a.ended) === Number(!b.ended) ? b.createdAt.localeCompare(a.createdAt) : a.ended ? 1 : -1));
  return { related_tickets: order.slice(0, 8).map(ticketCard), tickets_total: tickets.length };
}

/** The orchestrator's view of a candidate: its newest trigger as workers would read it, the rest of the batch, related tickets. */
export function candidateCard(ctx: InputContext, candidate: Candidate, settings: Settings) {
  const primary = candidate.triggers.at(-1)!;
  const others = candidate.triggers.filter((trigger) => trigger.id !== primary.id);
  const handedBack = candidate.triggers.flatMap((trigger) => (ctx.state.disposition(trigger.id)?.handbacks ?? []).map((item) => ({ trigger_id: trigger.id, ticket_id: item.ticketId, reason: item.reason })));
  const delivered = ctx.state.disposition(primary.id)?.fanout ?? [];
  return {
    ...triggerMessage(primary, { allowed: ctx.allowed(primary), repliesTo: parentOf(ctx.state, primary) }),
    strength: candidate.strength,
    mode: settings.eval.mode,
    ...(others.length ? { batch: others.map((trigger) => triggerCard(trigger)) } : {}),
    ...(handedBack.length ? { handed_back: handedBack } : {}),
    ...relatedTickets(candidate.tickets),
    ...(delivered.length ? { delivered_to: delivered } : {}),
    next_action:
      candidate.strength === "explicit"
        ? "Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore."
        : "Ignore it with orchestrator_route if the card shows it touches no enabled rule; else assess it with orchestrator_eval, orchestrator_eval_read, then orchestrator_eval_decide.",
  };
}
