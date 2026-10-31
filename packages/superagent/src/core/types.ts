/**
 * Domain model of Deyin Superagent: sources produce Triggers, Threads group them, Eval decides whether a batch asks for work,
 * an accept creates a Ticket bound by a Mandate, and an Assignment hands the Ticket to a worker. Nothing here does I/O.
 */

/** Actor identity in a Source's own vocabulary; Policy decides which actors may originate work. */
export interface ActorRef { source: string; id: string }
/** Thread identity; the rule deriving `id` from a native event belongs to the Source. */
export interface ThreadRef { source: string; id: string }
/** Write-only address on a thread; the address format belongs to the Source. */
export interface ChannelRef { source: string; thread: string; address: Record<string, string> }

export const threadKey = (ref: ThreadRef): string => `${ref.source}:${ref.id}`
/** Inverse of {@link threadKey}; `undefined` for a malformed key. */
export function parseThreadKey(key: string): ThreadRef | undefined {
  const at = key.indexOf(":");
  return at < 1 || at === key.length - 1 ? undefined : { source: key.slice(0, at), id: key.slice(at + 1) };
}

/** Why the core recorded something, by code; `values` fill the English text (see reasons.ts). */
export interface Reason { code: string; values?: Record<string, string | number> }

/** One immutable event produced by a Source. `text` and `meta` are untrusted external data. */
export interface Trigger {
  id: string;
  source: string;
  /** Every thread the trigger belongs to; `threads[0]` is the primary thread that hosts its evaluation. */
  threads: ThreadRef[];
  actor: ActorRef;
  /** Source-declared: written by a person rather than a bot, CI or this agent. */
  human: boolean;
  /** Source-declared: the sender addressed the agent by mentioning it. */
  addressed?: "mention" | "direct";
  at: string;
  text: string;
  channel?: ChannelRef;
  url?: string;
  /** Source-native details for adapters; the core never interprets them. */
  meta: Record<string, unknown>;
}

/** Where a trigger went after intake. It grants nothing, but decides who decides a person's follow-up. */
export interface TriggerDisposition {
  /** Rejected by the gate, with its reason. */
  filtered?: Reason;
  evalId?: string;
  decisionId?: string;
  /** Tickets it reached by subscription fan-out or attachment. */
  fanout: string[];
  /** Tickets of `fanout` it reached only on a thread their worker follows for context. */
  context?: string[];
  /** A person (or the orchestrator) sent it to Eval again. */
  requeued?: true;
  /** Tickets whose worker handed it back as beyond the ticket, each once. */
  handbacks?: { ticketId: string; reason: string; at: string }[];
  /** Tickets whose worker acknowledged or answered it, taking it up as in scope. */
  acked?: string[];
  at: string;
}

export type Strength = "explicit" | "inferred";
export type AcceptMode = "off" | "observe" | "auto";
/** Admission-table cells, by whether the sender is listed and whether they addressed the agent. */
export type AdmissionCell = "listedUnaddressed" | "unlistedAddressed" | "unlistedUnaddressed";
export type Admission = "explicit" | "inferred" | "ignore";

/** Where a Mandate's Trigger was received. */
interface Received { source?: string; scope?: Record<string, unknown>; row?: string }
/** How the gate admitted the Trigger a Mandate came from, which revalidation re-checks. */
export type MandateBasis = Received & { sender?: string; rules?: string[] } & (
  | { via: "addressed"; addressed: "mention" | "direct" }
  | { via: "followup" }
  | { via: "admission"; cell: AdmissionCell; addressed?: "mention" | "direct"; observation?: { mode: AcceptMode } }
  | { via: "bot"; addressed?: "mention" | "direct"; observation: { mode: AcceptMode } }
);

/** Immutable authorization produced by an accept; execution is bounded by it. */
export interface Mandate {
  strength: Strength;
  policyVersion: string;
  basis: MandateBasis;
  actor: ActorRef;
  scope: string;
}

/** The active evaluation of a thread's queued triggers; at most one exists per thread. */
export interface Evaluation {
  id: string;
  threadKey: string;
  triggerIds: string[];
  /** The admissible trigger that gave the batch its strength; a ticket the Eval starts takes it as origin. */
  primary?: string;
  strength: Strength;
  actor: ActorRef;
  basis: MandateBasis;
  policyVersion: string;
  startedAt: string;
  /** When the candidate reached the orchestrator; the deadline counts from then. */
  delivered?: string;
  deadline: string;
  /** When a processing pause began; resuming shifts `deadline` by the pause length. */
  pausedAt?: string;
}

/** Thread aggregate: the consistency boundary of Eval, holder of subscriptions and decision history. */
export interface Thread {
  key: string;
  ref: ThreadRef;
  createdAt: string;
  lastAt?: string;
  /** Tickets subscribed to this thread; live ones receive every trigger as context. */
  subscriptions: string[];
  /** Subscribed tickets whose worker follows the thread read-only: their messages grant nothing and resume nothing. */
  context?: string[];
  /** Triggers waiting for the next Eval. */
  pending: string[];
  evaluating?: Evaluation;
  /** Evals of its queued triggers that expired in a row. */
  expired?: number;
  /** Source-native attributes (label, url, number, kind ...). */
  meta: Record<string, unknown>;
}

export type DecisionKind = "ignore" | "accept" | "stop" | "unavailable";
/** Outcome of one Eval, recorded on its thread. */
export interface Decision {
  id: string;
  evalId: string;
  threadKey: string;
  triggerIds: string[];
  policyVersion: string;
  at: string;
  kind: DecisionKind;
  reason: Reason[];
  strength: Strength;
  ticketId?: string;
  mandate?: Mandate;
  /** Assessor audit data: rule assessments, direction, evidence. */
  audit?: Record<string, unknown>;
  dismissed?: true;
}

export type AssignmentState = "pending" | "running" | "ended";
export type ReportState = "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped";
export interface Assignment {
  id: string;
  state: AssignmentState;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  endedReason?: string;
  report?: { state: ReportState; summary: string; at: string };
  /** When inputs last reached the worker. */
  deliveredAt?: string;
  /** When a worker turn last ended with nothing left to run. */
  idleAt?: string;
}

/** How a policy change bears on a ticket. */
export interface PolicyEffect {
  rules?: { id: string; name: string; change: "changed" | "disabled"; instruction?: string }[];
  proactive?: false;
  requesterAllowed?: false;
  requester?: ActorRef;
}

export type TicketInput =
  | { id: string; kind: "trigger"; triggerId: string; at: string; note?: string; human?: true; context?: true; deliveredTo?: string; deliveredAt?: string }
  | { id: string; kind: "policy-changed"; from: string; to: string; at: string; effect?: PolicyEffect }
  | { id: string; kind: "resumed"; triggerId: string; at: string }
  | { id: string; kind: "text"; text: string; at: string }
  | { id: string; kind: "note"; text: string; at: string };

export type TicketEndBy = "executor" | "human" | "host";
export type TicketOutcome = "completed" | "merged" | "closed" | "dropped" | "stopped";
/** A question for a person; `triggerId` is the human message that raised it, whose conversation it returns to. */
export interface Attention { id: string; question: string; triggerId?: string }
/** A thread a ticket follows (its pull request, say): `own` when the ticket opened it. */
export interface Follow { thread: string; own: boolean; closed?: { at: string; outcome: "merged" | "closed" } }
export interface Execution { name: string; directory: string; assignment: string }

/** An authorized work item with its assignments, channels, thread bindings and inputs. */
export interface Ticket {
  id: string;
  title: string;
  decisionId: string;
  mandate: Mandate;
  channels: ChannelRef[];
  ended?: { at: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string };
  attention?: Attention;
  assignments: Assignment[];
  inputs: TicketInput[];
  /** Inputs not yet handed to a running assignment. */
  undelivered: string[];
  follows?: Follow[];
  /** People's questions the worker answered; each lets the orchestrator send one answer. */
  answers?: string[];
  createdAt: string;
  updatedAt: string;
  origin: { triggerId: string; triggerIds: string[] };
  execution?: Execution;
  delivery?: { error: string; at: string };
}

export type ReplyPurpose = "acknowledgement" | "answer" | "result" | "attention";
export type ReceiptStatus = "pending" | "sent" | "dropped";
/** An outbound message from queueing to delivery. */
export interface Receipt {
  id: string;
  purpose: ReplyPurpose;
  ticketId?: string;
  triggerId?: string;
  text: string;
  channel: ChannelRef;
  status: ReceiptStatus;
  attempts: number;
  createdAt: string;
  sentAt?: string;
  droppedReason?: "channelGone" | "channelIgnored";
  error?: string;
  /** Earliest next attempt, after a failure. */
  retryAt?: string;
}

/** A message for the orchestrator that is not a candidate: a worker report, a follow-up notice. */
export interface Notice {
  id: string;
  kind: "report" | "follow_up" | "text";
  ticketId?: string;
  /** For a follow-up: the trigger, which the message is made from when it is sent (the tickets it reached may have changed by then). */
  triggerId?: string;
  text: string;
  at: string;
  delivered?: true;
}

/** A candidate the orchestrator decides: an Eval's batch, the thread and its tickets. */
export interface Candidate {
  evalId: string;
  thread: Thread;
  strength: Strength;
  triggers: Trigger[];
  tickets: Ticket[];
  deadline: string;
  delivered?: string;
}

/** What the orchestrator (or an assessment) decides for a candidate. */
export type Outcome =
  | { kind: "accept"; title: string; scope: string; reason: string | Reason; acknowledgement?: string; name?: string; note?: string; rules?: string[]; audit?: Record<string, unknown> }
  | { kind: "stop"; ticketId: string; reason: string | Reason }
  | { kind: "ignore"; reason: string | Reason; audit?: Record<string, unknown> }
  | { kind: "unavailable"; reason: string | Reason; audit?: Record<string, unknown> };

/** Domain events, for the host to turn into UI refreshes and orchestrator notices. */
export type DomainEvent =
  | { type: "trigger.received"; triggerId: string }
  | { type: "decision.recorded"; decisionId: string }
  | { type: "ticket.created"; ticketId: string }
  | { type: "ticket.resumed"; ticketId: string }
  | { type: "ticket.ended"; ticketId: string }
  | { type: "ticket.updated"; ticketId: string }
  | { type: "reply.queued"; receiptId: string };
