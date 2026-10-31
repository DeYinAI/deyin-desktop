/**
 * The Engine: every state transition of the domain model. Sources feed it Triggers, the orchestrator decides candidates through
 * it, workers report through it, and people stop or retry tickets through it. It performs no I/O: effects are durable records
 * (assignments, receipts, notices, undelivered inputs) that drivers scan for and settle.
 */
import { UserError } from "./errors.js";
import { followsDone, humanTriggerInput, liveAssignment, ticketStage } from "./model.js";
import { asReason, reasonText } from "./reasons.js";
import { MAX_PENDING_FOLLOWUPS, type State } from "./state.js";
import { key } from "./text.js";
import type { Policy } from "../policy.js";
import type {
  Assignment, Candidate, Decision, DomainEvent, Evaluation, Execution, Mandate, Notice, Outcome, PolicyEffect, Reason, Receipt, ReplyPurpose,
  ReportState, Strength, Thread, ThreadRef, Ticket, TicketEndBy, TicketInput, TicketOutcome, Trigger, TriggerDisposition,
} from "./types.js";
import { parseThreadKey, threadKey } from "./types.js";

export interface ExecutionRequest {
  ticketId: string;
  title: string;
  scope: string;
  name?: string;
  trigger: Trigger;
  mandate: Mandate;
  taken: ReadonlySet<string>;
}

export interface EngineDeps {
  /** The policy in force now; read on every call so a settings change applies at once. */
  policy(): Policy;
  now?(): Date;
  /** Chooses a new ticket's worktree name and assignment text. */
  execution(input: ExecutionRequest): Execution;
  emit?(event: DomainEvent): void;
}

export interface ReplyRequest {
  purpose: ReplyPurpose;
  ticketId?: string;
  triggerId?: string;
  text: string;
  /** For attention: the ticket's current question, which the reply must repeat exactly. */
  question?: string;
  /** Set by the host for its own messages, such as an acknowledgement on accept; skips the pause check. */
  internal?: true;
}
export type ReplyResult = Receipt & { reused: boolean };

export interface WorkerReport {
  state: Exclude<ReportState, "waiting">;
  summary: string;
  /** `undefined` keeps the pending question, `null` clears it. */
  question?: string | null;
  askedBy?: string;
  answers?: string;
}

/** What a worker is told when asked for its status (the upstream text, which says this is not a request to carry on). */
const STATUS_REQUEST = "Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.";

const MAX_NOTICE = 1200;
/** The most of a message that is kept; GitHub allows 65,536 characters in one. */
export const MAX_TRIGGER_TEXT = 20_000;
/** An evaluation the orchestrator never received expires after this many evaluation timeouts. */
const UNDELIVERED_GRACE = 6;

export class Engine {
  constructor(
    private readonly state: State,
    private readonly deps: EngineDeps,
  ) {}

  // ---- infrastructure ----------------------------------------------------------------------------------------------

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
  private policy(): Policy {
    return this.deps.policy();
  }
  private emit(event: DomainEvent): void {
    this.deps.emit?.(event);
  }
  private ticket(id: string): Ticket {
    const ticket = this.state.tickets.get(id);
    if (!ticket) throw new UserError("unknownTicket", `Unknown ticket ${id}`);
    return ticket;
  }
  private liveTicket(id: string): Ticket {
    const ticket = this.ticket(id);
    if (ticket.ended) throw new UserError("ticketEnded");
    return ticket;
  }
  private touch(ticket?: Ticket): void {
    if (ticket) ticket.updatedAt = this.now();
    this.state.touch();
  }
  private ticketsOf(thread: Thread): Ticket[] {
    return thread.subscriptions.flatMap((id) => this.state.tickets.get(id) ?? []);
  }

  // ---- intake ------------------------------------------------------------------------------------------------------

  /** Stores a Trigger, delivers it to the tickets subscribed to its threads, and queues it for assessment when nobody owns it. */
  receive(incoming: Trigger): "stored" | "duplicate" {
    if (this.state.triggers.has(incoming.id)) return "duplicate";
    if (incoming.threads.length === 0) throw new UserError("invalid", "A trigger belongs to at least one thread");
    // Anyone may write on a public repository, so what is kept of a message has a bound; the source still has all of it.
    const trigger = incoming.text.length > MAX_TRIGGER_TEXT ? { ...incoming, text: `${incoming.text.slice(0, MAX_TRIGGER_TEXT)}\n[… ${incoming.text.length - MAX_TRIGGER_TEXT} more characters not kept]` } : incoming;
    const at = this.now();
    this.state.triggers.set(trigger.id, trigger);
    const disposition: TriggerDisposition = { fanout: [], at };
    this.state.dispositions.set(trigger.id, disposition);
    const threads = trigger.threads.map((ref) => this.state.ensureThread(ref, at));
    for (const thread of threads) if (!thread.lastAt || thread.lastAt < trigger.at) thread.lastAt = trigger.at;
    const seen = new Set<string>();
    let owned = false;
    for (const thread of threads) {
      for (const ticketId of thread.subscriptions) {
        if (seen.has(ticketId)) continue;
        seen.add(ticketId);
        const ticket = this.state.tickets.get(ticketId);
        if (!ticket) continue;
        const reached = this.reach(ticket, trigger, disposition, thread.context?.includes(ticketId) === true);
        if (reached === "owner") owned = true;
      }
    }
    // The orchestrator hears of a person's message a worker decides, so that it can stop the work when that is what was asked.
    if (owned) this.addNotice({ kind: "follow_up", triggerId: trigger.id, text: "" });
    else this.queueForEval(trigger, disposition);
    this.state.touch();
    this.emit({ type: "trigger.received", triggerId: trigger.id });
    return "stored";
  }

  /** Delivers `trigger` to one subscribed ticket; "owner" when it is a person's directive the ticket's worker decides. */
  private reach(ticket: Ticket, trigger: Trigger, disposition: TriggerDisposition, context: boolean): "owner" | "context" | "none" {
    const policy = this.policy();
    const directive = trigger.human && !context && policy.allowedSender(trigger.actor);
    if (ticket.ended) {
      if (!directive || ticket.ended.by === "human" || !policy.revalidate(ticket.mandate)) return "none";
      this.addInput(ticket, trigger, { human: true });
      disposition.fanout.push(ticket.id);
      this.tryResume(ticket, trigger.id);
      return "owner";
    }
    this.addInput(ticket, trigger, { human: directive, context });
    disposition.fanout.push(ticket.id);
    if (context) (disposition.context ??= []).push(ticket.id);
    return directive ? "owner" : "context";
  }

  private addInput(ticket: Ticket, trigger: Trigger, flags: { human?: boolean; context?: boolean; note?: string }): TicketInput | undefined {
    if (ticket.inputs.some((input) => input.kind === "trigger" && input.triggerId === trigger.id)) return undefined;
    const input: TicketInput = {
      id: this.state.nextId("i"), kind: "trigger", triggerId: trigger.id, at: this.now(),
      ...(flags.note ? { note: flags.note } : {}),
      ...(flags.human ? { human: true as const } : {}),
      ...(flags.context ? { context: true as const } : {}),
    };
    ticket.inputs.push(input);
    ticket.undelivered.push(input.id);
    this.touch(ticket);
    return input;
  }

  private pushInput(ticket: Ticket, make: (id: string, at: string) => TicketInput): void {
    const input = make(this.state.nextId("i"), this.now());
    ticket.inputs.push(input);
    ticket.undelivered.push(input.id);
    this.touch(ticket);
  }

  /** Queues a trigger for the gate; a rejected one records why. */
  private queueForEval(trigger: Trigger, disposition: TriggerDisposition): boolean {
    const thread = this.state.threads.get(threadKey(trigger.threads[0]!));
    if (!thread) return false;
    const result = this.policy().gate(trigger, thread, this.ticketsOf(thread));
    if (!result.admissible) {
      disposition.filtered = { code: result.reason };
      return false;
    }
    delete disposition.filtered;
    if (!thread.pending.includes(trigger.id) && !thread.evaluating?.triggerIds.includes(trigger.id)) thread.pending.push(trigger.id);
    return true;
  }

  // ---- evaluation --------------------------------------------------------------------------------------------------

  /** Advances time-driven work: starts evaluations, expires overdue ones, and resumes tickets people have answered. */
  evaluateDue(): void {
    const policy = this.policy();
    const nowMs = (this.deps.now?.() ?? new Date()).getTime();
    for (const thread of this.state.threads.values()) {
      const evaluation = thread.evaluating;
      if (evaluation) {
        if (policy.paused && !evaluation.pausedAt) {
          evaluation.pausedAt = this.now();
          this.state.touch();
        } else if (!policy.paused && evaluation.pausedAt) {
          const shift = nowMs - Date.parse(evaluation.pausedAt);
          evaluation.deadline = new Date(Date.parse(evaluation.deadline) + shift).toISOString();
          delete evaluation.pausedAt;
          this.state.touch();
        } else if (!policy.paused && evaluation.delivered && nowMs >= Date.parse(evaluation.deadline)) {
          this.expire(thread, evaluation);
        } else if (!policy.paused && !evaluation.delivered && nowMs >= Date.parse(evaluation.startedAt) + policy.evalTimeoutMs * UNDELIVERED_GRACE) {
          // The orchestrator never took it (no model, repeated failures): let it expire rather than block its thread for ever.
          this.expire(thread, evaluation);
        }
      }
      if (!thread.evaluating && thread.pending.length > 0 && !policy.paused) this.startEvaluation(thread);
    }
    if (!policy.paused) this.resumeAnswered();
  }

  private startEvaluation(thread: Thread): void {
    const policy = this.policy();
    const admitted: { trigger: Trigger; strength: "explicit" | "inferred"; basis: Mandate["basis"] }[] = [];
    const refused: Reason[] = [];
    const refusedIds: string[] = [];
    for (const id of thread.pending) {
      const trigger = this.state.triggers.get(id);
      const disposition = this.state.dispositions.get(id);
      if (!trigger || !disposition) continue;
      const result = policy.gate(trigger, thread, this.ticketsOf(thread));
      if (result.admissible) admitted.push({ trigger, strength: result.strength, basis: result.basis });
      else {
        disposition.filtered = { code: result.reason };
        refusedIds.push(id);
        refused.push({ code: result.reason });
      }
    }
    thread.pending = [];
    if (admitted.length === 0) {
      // Admissible when it arrived, not now (the policy changed while it waited): left on record as ignored, not lost.
      if (refusedIds.length > 0) this.recordDirect({ thread, triggerIds: refusedIds, kind: "ignore", reason: refused, strength: "inferred" });
      this.state.touch();
      return;
    }
    const strongest = admitted.some((item) => item.strength === "explicit") ? "explicit" : "inferred";
    const primary = admitted.filter((item) => item.strength === strongest).at(-1)!;
    const at = this.now();
    const evaluation: Evaluation = {
      id: this.state.nextId("e"), threadKey: thread.key, triggerIds: admitted.map((item) => item.trigger.id), primary: primary.trigger.id,
      strength: strongest, actor: primary.trigger.actor, basis: primary.basis, policyVersion: policy.version, startedAt: at,
      deadline: new Date(Date.parse(at) + policy.evalTimeoutMs).toISOString(),
    };
    thread.evaluating = evaluation;
    for (const id of evaluation.triggerIds) {
      const disposition = this.state.dispositions.get(id);
      if (disposition) disposition.evalId = evaluation.id;
    }
    this.state.touch();
  }

  private expire(thread: Thread, evaluation: Evaluation): void {
    this.record(thread, evaluation, { kind: "unavailable", reason: { code: "timeout" } });
    thread.expired = (thread.expired ?? 0) + 1;
    this.state.touch();
  }

  /** Candidates awaiting the orchestrator, oldest first. */
  candidates(): Candidate[] {
    const out: Candidate[] = [];
    for (const thread of this.state.threads.values()) {
      const candidate = thread.evaluating && this.candidateOf(thread, thread.evaluating);
      if (candidate) out.push(candidate);
    }
    return out.sort((a, b) => a.thread.evaluating!.startedAt.localeCompare(b.thread.evaluating!.startedAt));
  }

  /** The active candidate holding `triggerId`, if any. */
  candidate(triggerId: string): Candidate | undefined {
    for (const thread of this.state.threads.values()) {
      if (thread.evaluating?.triggerIds.includes(triggerId)) return this.candidateOf(thread, thread.evaluating);
    }
    return undefined;
  }

  private candidateOf(thread: Thread, evaluation: Evaluation): Candidate {
    return {
      evalId: evaluation.id, thread, strength: evaluation.strength,
      triggers: evaluation.triggerIds.flatMap((id) => this.state.triggers.get(id) ?? []),
      tickets: this.ticketsOf(thread), deadline: evaluation.deadline,
      ...(evaluation.delivered ? { delivered: evaluation.delivered } : {}),
    };
  }

  /** Starts the evaluation's deadline once the candidate has reached the orchestrator. */
  candidateDelivered(evalId: string): void {
    for (const thread of this.state.threads.values()) {
      const evaluation = thread.evaluating;
      if (evaluation?.id !== evalId || evaluation.delivered) continue;
      evaluation.delivered = this.now();
      evaluation.deadline = new Date((this.deps.now?.() ?? new Date()).getTime() + this.policy().evalTimeoutMs).toISOString();
      this.state.touch();
    }
  }

  /** Forgets that a candidate was delivered, so it is delivered again (the orchestrator turn failed before acting). */
  candidateUndelivered(evalId: string): void {
    for (const thread of this.state.threads.values()) {
      if (thread.evaluating?.id === evalId && thread.evaluating.delivered) {
        delete thread.evaluating.delivered;
        this.state.touch();
      }
    }
  }

  /**
   * Decides the evaluation holding `triggerId`, which decides its whole batch. Idempotent: a trigger decided earlier returns its
   * Decision. @throws UserError when no assessment is in progress, the request is not explicit, or processing is paused.
   */
  decide(triggerId: string, outcome: Outcome): Decision {
    const thread = this.threadEvaluating(triggerId);
    if (!thread) {
      const earlier = this.state.dispositions.get(triggerId)?.decisionId;
      const decision = earlier ? this.state.decisions.get(earlier) : undefined;
      if (outcome.kind === "stop") return this.stopFollowUp(triggerId, outcome);
      if (decision) return decision;
      throw new UserError("noAssessment");
    }
    const evaluation = thread.evaluating!;
    const policy = this.policy();
    if (policy.paused) throw new UserError("paused");
    switch (outcome.kind) {
      case "accept":
        return this.decideAccept(thread, evaluation, outcome);
      case "stop":
        return this.decideStop(thread, evaluation, outcome);
      case "ignore":
      case "unavailable":
        return this.record(thread, evaluation, { kind: outcome.kind, reason: asReason(outcome.reason), ...(outcome.audit ? { audit: outcome.audit } : {}) });
      default: {
        const never: never = outcome;
        throw new Error(`Unhandled outcome ${JSON.stringify(never)}`);
      }
    }
  }

  /**
   * Stops a ticket on a person's message that reached it as a follow-up, which no assessment holds because the ticket's worker decides it.
   * Idempotent for the same ticket. @throws UserError when the message did not reach the ticket as a person's, or processing is paused.
   */
  private stopFollowUp(triggerId: string, outcome: Extract<Outcome, { kind: "stop" }>): Decision {
    const trigger = this.state.triggers.get(triggerId);
    const disposition = this.state.dispositions.get(triggerId);
    if (!trigger || !disposition) throw new UserError("noAssessment");
    const ticket = this.state.tickets.get(outcome.ticketId);
    if (!ticket) throw new UserError("unknownTicket", `No such ticket to stop: ${outcome.ticketId}`);
    const earlier = disposition.decisionId ? this.state.decisions.get(disposition.decisionId) : undefined;
    if (earlier?.kind === "stop" && earlier.ticketId === ticket.id) return earlier;
    if (ticket.ended) throw new UserError("ticketEnded");
    if (!ticket.inputs.some((input) => input.kind === "trigger" && input.triggerId === triggerId && humanTriggerInput(input))) throw new UserError("notReached");
    if (this.policy().paused) throw new UserError("paused");
    const decision = this.recordDirect({ triggerIds: [triggerId], kind: "stop", reason: [asReason(outcome.reason)], strength: "explicit", ticketId: ticket.id, threadKey: threadKey(trigger.threads[0]!) });
    this.endTicket(ticket, "human", "stopped", reasonText(decision.reason));
    return decision;
  }

  /** Records a decision that no evaluation held (a person's follow-up stopped a ticket; a queued message the policy no longer admits). */
  private recordDirect(fields: { thread?: Thread; threadKey?: string; triggerIds: string[]; kind: Decision["kind"]; reason: Reason[]; strength: Strength; ticketId?: string }): Decision {
    const decision: Decision = {
      id: this.state.nextId("d"), evalId: "", threadKey: fields.thread?.key ?? fields.threadKey ?? "", triggerIds: fields.triggerIds, policyVersion: this.policy().version, at: this.now(),
      kind: fields.kind, reason: fields.reason, strength: fields.strength, ...(fields.ticketId ? { ticketId: fields.ticketId } : {}),
    };
    this.state.decisions.set(decision.id, decision);
    for (const id of fields.triggerIds) {
      const disposition = this.state.dispositions.get(id);
      if (disposition) disposition.decisionId = decision.id;
    }
    this.state.touch();
    this.emit({ type: "decision.recorded", decisionId: decision.id });
    return decision;
  }

  private threadEvaluating(triggerId: string): Thread | undefined {
    for (const thread of this.state.threads.values()) if (thread.evaluating?.triggerIds.includes(triggerId)) return thread;
    return undefined;
  }

  private decideAccept(thread: Thread, evaluation: Evaluation, outcome: Extract<Outcome, { kind: "accept" }>): Decision {
    const policy = this.policy();
    const strength = evaluation.strength;
    if (strength === "inferred" && !(outcome.rules && policy.admitsInferred(outcome.rules))) {
      if (!outcome.rules) throw new UserError("notExplicit");
      return this.record(thread, evaluation, { kind: "unavailable", reason: { code: "policyChanged" } });
    }
    const mandate: Mandate = {
      strength, policyVersion: policy.version, actor: evaluation.actor, scope: outcome.scope,
      basis: { ...evaluation.basis, ...(outcome.rules ? { rules: [...outcome.rules] } : {}) },
    };
    if (evaluation.policyVersion !== policy.version && !policy.revalidate(mandate)) {
      return this.record(thread, evaluation, { kind: "unavailable", reason: { code: "policyChanged" } });
    }
    const decision = this.record(thread, evaluation, { kind: "accept", mandate, reason: asReason(outcome.reason), ...(outcome.audit ? { audit: outcome.audit } : {}) });
    const ticket = this.createTicket(decision, evaluation, outcome, mandate);
    decision.ticketId = ticket.id;
    this.state.touch();
    this.emit({ type: "ticket.created", ticketId: ticket.id });
    return decision;
  }

  private decideStop(thread: Thread, evaluation: Evaluation, outcome: Extract<Outcome, { kind: "stop" }>): Decision {
    const ticket = this.state.tickets.get(outcome.ticketId);
    if (!ticket) throw new UserError("unknownTicket", `No such ticket to stop: ${outcome.ticketId}`);
    const primary = this.state.triggers.get(evaluation.primary ?? evaluation.triggerIds[0]!);
    const explicit = evaluation.strength === "explicit" && !!primary?.human;
    if (!explicit) return this.record(thread, evaluation, { kind: "ignore", reason: { code: "stopNotExplicit" }, ticketId: ticket.id });
    const decision = this.record(thread, evaluation, { kind: "stop", reason: asReason(outcome.reason), ticketId: ticket.id });
    if (!ticket.ended) this.endTicket(ticket, "human", "stopped", reasonText(decision.reason));
    return decision;
  }

  /** Records a decision, ends the evaluation, and marks every trigger of the batch decided. */
  private record(
    thread: Thread, evaluation: Evaluation,
    fields: { kind: Decision["kind"]; reason: Decision["reason"][number]; mandate?: Mandate; audit?: Record<string, unknown>; ticketId?: string },
  ): Decision {
    const decision: Decision = {
      id: this.state.nextId("d"), evalId: evaluation.id, threadKey: thread.key, triggerIds: [...evaluation.triggerIds],
      policyVersion: evaluation.policyVersion, at: this.now(), kind: fields.kind, reason: [fields.reason], strength: evaluation.strength,
      ...(fields.mandate ? { mandate: fields.mandate } : {}),
      ...(fields.audit ? { audit: fields.audit } : {}),
      ...(fields.ticketId ? { ticketId: fields.ticketId } : {}),
    };
    this.state.decisions.set(decision.id, decision);
    for (const id of evaluation.triggerIds) {
      const disposition = this.state.dispositions.get(id);
      if (disposition) disposition.decisionId = decision.id;
    }
    delete thread.evaluating;
    if (fields.reason.code !== "timeout") delete thread.expired;
    this.state.touch();
    this.emit({ type: "decision.recorded", decisionId: decision.id });
    return decision;
  }

  /** Sends a trigger back for a fresh assessment, such as after access changed. False when the gate still refuses it. */
  reevaluate(triggerId: string): boolean {
    const trigger = this.state.triggers.get(triggerId);
    const disposition = this.state.dispositions.get(triggerId);
    if (!trigger || !disposition) throw new UserError("unknownTrigger");
    if (this.threadEvaluating(triggerId)) return false;
    disposition.requeued = true;
    delete disposition.decisionId;
    const queued = this.queueForEval(trigger, disposition);
    this.state.touch();
    return queued;
  }

  /** Hands a message back from a ticket's worker for a fresh assessment; once per ticket and message. */
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    const ticket = this.ticket(ticketId);
    const trigger = this.state.triggers.get(triggerId);
    const disposition = this.state.dispositions.get(triggerId);
    if (!trigger || !disposition) throw new UserError("unknownTrigger");
    const input = ticket.inputs.find((item) => item.kind === "trigger" && item.triggerId === triggerId);
    if (!input || input.kind !== "trigger") throw new UserError("notReached");
    if (disposition.handbacks?.some((item) => item.ticketId === ticketId)) return false;
    (disposition.handbacks ??= []).push({ ticketId, reason, at: this.now() });
    this.state.touch();
    if (!trigger.human || !humanTriggerInput(input)) return false;
    const others = disposition.fanout.filter((id) => id !== ticketId).flatMap((id) => this.state.tickets.get(id) ?? [])
      .filter((other) => !other.ended && other.inputs.some((item) => humanTriggerInput(item) && item.triggerId === triggerId))
      .filter((other) => !disposition.handbacks?.some((item) => item.ticketId === other.id));
    if (others.length > 0) return false;
    const queued = this.queueForEval(trigger, disposition);
    this.state.touch();
    return queued;
  }

  // ---- tickets -----------------------------------------------------------------------------------------------------

  private createTicket(decision: Decision, evaluation: Evaluation, outcome: Extract<Outcome, { kind: "accept" }>, mandate: Mandate): Ticket {
    const primary = this.state.triggers.get(evaluation.primary ?? evaluation.triggerIds[0]!)!;
    const batch = evaluation.triggerIds.flatMap((id) => this.state.triggers.get(id) ?? []);
    const id = this.state.nextId("t");
    const at = this.now();
    const taken = new Set([...this.state.tickets.values()].map((ticket) => ticket.execution?.name ?? "").filter(Boolean));
    const execution = this.deps.execution({ ticketId: id, title: outcome.title, scope: outcome.scope, ...(outcome.name ? { name: outcome.name } : {}), trigger: primary, mandate, taken });
    const channels = dedupeChannels(batch.flatMap((trigger) => (trigger.channel ? [trigger.channel] : [])));
    const ticket: Ticket = {
      id, title: outcome.title, decisionId: decision.id, mandate, channels, assignments: [], inputs: [], undelivered: [], follows: [], answers: [],
      createdAt: at, updatedAt: at, origin: { triggerId: primary.id, triggerIds: batch.map((trigger) => trigger.id) }, execution,
    };
    ticket.assignments.push(this.newAssignment());
    this.state.tickets.set(id, ticket);
    const allowed = (trigger: Trigger) => trigger.human && this.policy().allowedSender(trigger.actor);
    batch.forEach((trigger, index) => {
      this.addInput(ticket, trigger, { human: allowed(trigger), ...(index === 0 && outcome.note ? { note: outcome.note } : {}) });
      const disposition = this.state.dispositions.get(trigger.id);
      if (disposition && !disposition.fanout.includes(id)) disposition.fanout.push(id);
    });
    if (batch.length > 0 && outcome.note && !ticket.inputs.some((input) => input.kind === "trigger" && input.note)) {
      this.pushInput(ticket, (inputId, when) => ({ id: inputId, kind: "note", text: outcome.note!, at: when }));
    }
    const threads = new Map<string, Thread>();
    for (const trigger of batch) for (const ref of trigger.threads) threads.set(threadKey(ref), this.state.ensureThread(ref, at));
    for (const thread of threads.values()) {
      if (!thread.subscriptions.includes(id)) thread.subscriptions.push(id);
      delete thread.expired;
    }
    const origin = threads.get(threadKey(primary.threads[0]!));
    if (origin && primary.meta.isPr === true) ticket.follows!.push({ thread: origin.key, own: false });
    if (outcome.acknowledgement && primary.human && primary.channel) {
      this.queueReply({ purpose: "acknowledgement", ticketId: id, triggerId: primary.id, text: outcome.acknowledgement, internal: true });
    }
    return ticket;
  }

  private newAssignment(): Assignment {
    return { id: this.state.nextId("a"), state: "pending", createdAt: this.now() };
  }

  private endTicket(ticket: Ticket, by: TicketEndBy, outcome: TicketOutcome, reason?: string): void {
    const at = this.now();
    ticket.ended = { at, by, outcome, ...(reason ? { reason } : {}) };
    const live = liveAssignment(ticket);
    if (live) {
      live.state = "ended";
      live.endedAt = at;
      live.endedReason = by === "human" ? "stopped" : outcome;
    }
    delete ticket.attention;
    delete ticket.delivery;
    this.touch(ticket);
    this.emit({ type: "ticket.ended", ticketId: ticket.id });
  }

  /** A person stops a ticket; its worker is aborted by the executor. */
  stopTicket(ticketId: string, reason = "Stopped by a person"): void {
    const ticket = this.ticket(ticketId);
    if (ticket.ended) return;
    this.endTicket(ticket, "human", "stopped", reason);
  }

  /** Ends a ticket whose host removed it (for instance when the app resets); no worker survives. */
  closeTicket(ticketId: string, outcome: TicketOutcome, reason?: string): void {
    const ticket = this.ticket(ticketId);
    if (!ticket.ended) this.endTicket(ticket, "host", outcome, reason);
  }

  /** Starts a fresh assignment for a ticket whose worker failed, is blocked, or whose inputs could not be delivered. */
  retryTicket(ticketId: string): Ticket {
    const ticket = this.liveTicket(ticketId);
    const stage = ticketStage(ticket);
    if (stage !== "failed" && stage !== "blocked" && stage !== "delivery") {
      throw new UserError("replyRefused", `Ticket ${ticketId} is ${stage}; only a failed or blocked ticket, or one whose input was not delivered, is retried`);
    }
    const live = liveAssignment(ticket);
    if (live) {
      live.state = "ended";
      live.endedAt = this.now();
      live.endedReason = "retry";
    }
    delete ticket.delivery;
    ticket.assignments.push(this.newAssignment());
    this.pushInput(ticket, (id, at) => ({ id, kind: "text", text: "A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.", at }));
    this.emit({ type: "ticket.updated", ticketId });
    return ticket;
  }

  /** Asks the worker of an idle ticket for a status report. False when the worker is not waiting. */
  requestStatus(ticketId: string): boolean {
    const ticket = this.liveTicket(ticketId);
    const live = liveAssignment(ticket);
    if (!live || live.state !== "running" || !live.idleAt) return false;
    this.pushInput(ticket, (id, at) => ({ id, kind: "text", text: STATUS_REQUEST, at }));
    return true;
  }

  /** Tells a worker a fact from elsewhere; it grants no authority. */
  note(ticketId: string, text: string): void {
    const ticket = this.liveTicket(ticketId);
    this.pushInput(ticket, (id, at) => ({ id, kind: "note", text, at }));
  }

  /** Attaches a trigger to an existing ticket, which then follows its threads; ends the trigger's own evaluation. */
  attach(ticketId: string, triggerId: string, note?: string): Ticket {
    const ticket = this.ticket(ticketId);
    const trigger = this.state.triggers.get(triggerId);
    const disposition = this.state.dispositions.get(triggerId);
    if (!trigger || !disposition) throw new UserError("unknownTrigger");
    const thread = this.threadEvaluating(triggerId);
    if (ticket.ended && (ticket.ended.by === "human" || !trigger.human)) throw new UserError("ticketEnded");
    const at = this.now();
    for (const ref of trigger.threads) {
      const target = this.state.ensureThread(ref, at);
      if (!target.subscriptions.includes(ticket.id)) target.subscriptions.push(ticket.id);
    }
    const human = trigger.human && this.policy().allowedSender(trigger.actor);
    this.addInput(ticket, trigger, { human, ...(note ? { note } : {}) });
    if (!disposition.fanout.includes(ticket.id)) disposition.fanout.push(ticket.id);
    if (thread?.evaluating) {
      const evaluation = thread.evaluating;
      const remaining = evaluation.triggerIds.filter((id) => id !== triggerId);
      this.record(thread, { ...evaluation, triggerIds: [triggerId] }, { kind: "ignore", reason: { code: "routed" }, ticketId: ticket.id });
      if (remaining.length > 0) {
        thread.pending.unshift(...remaining);
        for (const id of remaining) delete this.state.dispositions.get(id)?.evalId;
      }
    }
    if (ticket.ended && human) this.tryResume(ticket, triggerId);
    this.touch(ticket);
    return ticket;
  }

  private tryResume(ticket: Ticket, triggerId: string): void {
    if (!ticket.ended || this.policy().paused) return;
    delete ticket.ended;
    delete ticket.delivery;
    ticket.assignments.push(this.newAssignment());
    this.pushInput(ticket, (id, at) => ({ id, kind: "resumed", triggerId, at }));
    this.emit({ type: "ticket.resumed", ticketId: ticket.id });
  }

  /** Resumes ended tickets a person's message reached while processing was paused or the ticket was waiting. */
  private resumeAnswered(): void {
    const policy = this.policy();
    for (const ticket of this.state.tickets.values()) {
      if (!ticket.ended || ticket.ended.by === "human" || ticket.undelivered.length === 0) continue;
      const pending = ticket.inputs.filter((input) => ticket.undelivered.includes(input.id) && humanTriggerInput(input));
      if (pending.length === 0) continue;
      const first = pending[0]!;
      if (first.kind !== "trigger") continue;
      if (policy.revalidate(ticket.mandate)) this.tryResume(ticket, first.triggerId);
      else this.releaseInputs(ticket, pending.flatMap((input) => (input.kind === "trigger" ? [input.triggerId] : [])));
    }
  }

  /** Removes undelivered inputs a ticket may no longer act on and hands their triggers to the gate. */
  private releaseInputs(ticket: Ticket, triggerIds: string[]): void {
    ticket.inputs = ticket.inputs.filter((input) => !(input.kind === "trigger" && triggerIds.includes(input.triggerId) && ticket.undelivered.includes(input.id)));
    ticket.undelivered = ticket.undelivered.filter((id) => ticket.inputs.some((input) => input.id === id));
    for (const id of triggerIds) {
      const trigger = this.state.triggers.get(id);
      const disposition = this.state.dispositions.get(id);
      if (!trigger || !disposition) continue;
      disposition.fanout = disposition.fanout.filter((item) => item !== ticket.id);
      this.queueForEval(trigger, disposition);
    }
    this.touch(ticket);
  }

  // ---- worker-facing -----------------------------------------------------------------------------------------------

  /**
   * Records a worker's report: progress, ready, blocked, failed or dropped, plus its pending question. `claim` is the pull request the
   * report names: it is bound first, so a ready report on it leaves the ticket waiting for the merge. Nothing changes when the report is refused.
   */
  report(ticketId: string, report: WorkerReport, claim?: { ref: ThreadRef; own: boolean }): Ticket {
    const ticket = this.liveTicket(ticketId);
    const assignment = liveAssignment(ticket);
    if (!assignment) throw new UserError("ticketEnded", "The ticket has no running assignment");
    if (report.answers) {
      const input = ticket.inputs.find((item) => item.kind === "trigger" && item.triggerId === report.answers && humanTriggerInput(item));
      if (!input) throw new UserError("notReached", "reply_to_trigger_id must be a person's message that reached this ticket");
    }
    if (report.question && report.askedBy) this.assertAsker(ticket, report.askedBy);
    if (claim) this.bindThread(ticketId, claim.ref, claim.own);
    if (report.answers) {
      if (!ticket.answers) ticket.answers = [];
      if (!ticket.answers.includes(report.answers)) ticket.answers.push(report.answers);
    }
    const before = ticket.attention;
    if (report.question !== undefined) {
      if (report.question === null) delete ticket.attention;
      else if (before?.question === report.question) ticket.attention = { ...before, ...(report.askedBy ? { triggerId: report.askedBy } : {}) };
      else ticket.attention = { id: this.state.nextId("q"), question: report.question, ...(report.askedBy ? { triggerId: report.askedBy } : {}) };
    }
    if (report.state === "ready") delete ticket.attention;
    assignment.report = { state: report.state, summary: report.summary, at: this.now() };
    this.touch(ticket);
    if (report.state === "dropped") this.endTicket(ticket, "executor", "dropped", report.summary);
    else if (report.state === "ready") {
      const follows = followsDone(ticket);
      if (follows.done) this.endTicket(ticket, "executor", follows.outcome ?? "completed", report.summary);
      else if ((ticket.follows ?? []).length === 0) this.endTicket(ticket, "executor", "completed", report.summary);
    }
    const notice = this.reportNotice(ticket, report, before?.id !== ticket.attention?.id);
    if (notice) this.addNotice({ kind: "report", ticketId, text: notice });
    this.emit({ type: "ticket.updated", ticketId });
    return ticket;
  }

  private assertAsker(ticket: Ticket, triggerId: string): void {
    const input = ticket.inputs.find((item) => item.kind === "trigger" && item.triggerId === triggerId && humanTriggerInput(item));
    if (!input) throw new UserError("notReached", "question_for_trigger_id must be a person's message that reached this ticket");
  }

  private reportNotice(ticket: Ticket, report: WorkerReport, newQuestion: boolean): string | undefined {
    const head = `Worker report for ticket ${ticket.id} (${ticket.title})`;
    if (report.state === "ready") return `${head}: ready.\n${clip(report.summary)}`;
    if (report.state === "blocked" || report.state === "failed") return `${head}: ${report.state}.\n${clip(report.summary)}`;
    if (ticket.attention && newQuestion) return `${head} needs a person to act: ${ticket.attention.question}\n${clip(report.summary)}`;
    return undefined;
  }

  /** Idle bookkeeping when a worker turn ends with nothing left to run. */
  turnEnded(ticketId: string, assignmentId: string, finalText: string): void {
    const ticket = this.state.tickets.get(ticketId);
    const assignment = ticket?.assignments.find((item) => item.id === assignmentId);
    if (!ticket || !assignment || assignment.state !== "running") return;
    assignment.idleAt = this.now();
    if ((!assignment.report || assignment.report.state === "progress") && finalText.trim()) {
      assignment.report = { state: "waiting", summary: clip(finalText.trim()), at: this.now() };
    }
    this.touch(ticket);
    this.emit({ type: "ticket.updated", ticketId });
  }

  assignmentStarted(ticketId: string, assignmentId: string): void {
    const ticket = this.state.tickets.get(ticketId);
    const assignment = ticket?.assignments.find((item) => item.id === assignmentId);
    if (!ticket || !assignment || assignment.state !== "pending") return;
    assignment.state = "running";
    assignment.startedAt = this.now();
    this.touch(ticket);
    this.emit({ type: "ticket.updated", ticketId });
  }

  /** Marks inputs as handed to the running worker. */
  inputsDelivered(ticketId: string, ids: readonly string[]): void {
    const ticket = this.state.tickets.get(ticketId);
    if (!ticket) return;
    const at = this.now();
    const assignment = liveAssignment(ticket);
    let human = false;
    for (const input of ticket.inputs) {
      if (!ids.includes(input.id)) continue;
      if (input.kind === "trigger") {
        input.deliveredAt = at;
        if (assignment) input.deliveredTo = assignment.id;
        if (humanTriggerInput(input)) human = true;
      }
    }
    ticket.undelivered = ticket.undelivered.filter((id) => !ids.includes(id));
    delete ticket.delivery;
    if (assignment) {
      assignment.deliveredAt = at;
      delete assignment.idleAt;
      const state = assignment.report?.state;
      if (state === "waiting" || (human && (state === "ready" || state === "blocked" || state === "failed"))) delete assignment.report;
    }
    this.touch(ticket);
  }

  /** Puts inputs back among those a worker has not been given, when the run that took them could not carry them. */
  restoreInputs(ticketId: string, ids: readonly string[]): void {
    const ticket = this.state.tickets.get(ticketId);
    if (!ticket || ticket.ended) return;
    for (const input of ticket.inputs) {
      if (!ids.includes(input.id) || ticket.undelivered.includes(input.id)) continue;
      ticket.undelivered.push(input.id);
      if (input.kind === "trigger") {
        delete input.deliveredAt;
        delete input.deliveredTo;
      }
    }
    this.touch(ticket);
  }

  deliveryFailed(ticketId: string, error: string): void {
    const ticket = this.state.tickets.get(ticketId);
    if (!ticket || ticket.ended) return;
    ticket.delivery = { error, at: this.now() };
    this.touch(ticket);
    this.emit({ type: "ticket.updated", ticketId });
  }

  /** The worker's loop stopped: a failure leaves the ticket open and failed; otherwise the assignment is simply over. */
  assignmentEnded(ticketId: string, assignmentId: string, reason: "failed" | "interrupted", message?: string): void {
    const ticket = this.state.tickets.get(ticketId);
    const assignment = ticket?.assignments.find((item) => item.id === assignmentId);
    if (!ticket || !assignment || assignment.state === "ended") return;
    const at = this.now();
    if (reason === "interrupted") {
      assignment.state = "pending";
      delete assignment.idleAt;
      this.touch(ticket);
      return;
    }
    assignment.state = "ended";
    assignment.endedAt = at;
    assignment.endedReason = "failed";
    assignment.report = { state: "failed", summary: message ? clip(message) : "The worker stopped with an error", at };
    this.touch(ticket);
    const notice = this.reportNotice(ticket, { state: "failed", summary: assignment.report.summary }, false);
    if (notice) this.addNotice({ kind: "report", ticketId, text: notice });
    this.emit({ type: "ticket.updated", ticketId });
  }

  // ---- threads -----------------------------------------------------------------------------------------------------

  /** Binds a thread (usually the PR a worker opened) to a ticket: it is subscribed and, being followed, ends the ticket when it closes. */
  bindThread(ticketId: string, ref: ThreadRef, own: boolean): boolean {
    const ticket = this.liveTicket(ticketId);
    const thread = this.state.ensureThread(ref, this.now());
    const subscribed = !thread.subscriptions.includes(ticketId);
    if (subscribed) thread.subscriptions.push(ticketId);
    if (!ticket.follows) ticket.follows = [];
    const existing = ticket.follows.find((follow) => follow.thread === thread.key);
    if (!existing) ticket.follows.push({ thread: thread.key, own });
    else if (own) existing.own = true;
    this.touch(ticket);
    return subscribed || !existing;
  }

  /** Follows a related thread for context only: its messages reach the worker but grant nothing. */
  followForContext(ticketId: string, ref: ThreadRef): boolean {
    const ticket = this.liveTicket(ticketId);
    const thread = this.state.ensureThread(ref, this.now());
    if (thread.subscriptions.includes(ticketId)) return false;
    thread.subscriptions.push(ticketId);
    (thread.context ??= []).push(ticketId);
    this.touch(ticket);
    return true;
  }

  /** A worker stops following a thread that is not about its ticket; the ticket's own threads stay. */
  markUnrelated(ticketId: string, threadName: string, reason: string): void {
    const ticket = this.liveTicket(ticketId);
    const ref = parseThreadKey(threadName);
    const thread = ref && this.state.threads.get(threadKey(ref));
    if (!thread || !thread.subscriptions.includes(ticketId)) throw new UserError("unknownThread", `Ticket ${ticketId} does not follow ${threadName}`);
    const ownOrigin = ticket.origin.triggerIds.some((id) => this.state.triggers.get(id)?.threads.some((item) => threadKey(item) === thread.key));
    const ownFollow = ticket.follows?.some((follow) => follow.thread === thread.key && follow.own);
    if (ownOrigin || ownFollow) throw new UserError("replyRefused", "A ticket's own threads cannot be dropped");
    thread.subscriptions = thread.subscriptions.filter((id) => id !== ticketId);
    if (thread.context) thread.context = thread.context.filter((id) => id !== ticketId);
    ticket.follows = (ticket.follows ?? []).filter((follow) => follow.thread !== thread.key);
    this.pushInput(ticket, (id, at) => ({ id, kind: "note", text: `Stopped following ${thread.key}: ${reason}`, at }));
  }

  /** Drops every ticket subscription on a thread; returns how many it removed. */
  unsubscribe(threadName: string): number {
    const thread = this.state.threads.get(threadName);
    if (!thread) throw new UserError("unknownThread", `Unknown thread ${threadName}`);
    const removed = thread.subscriptions.length;
    for (const id of thread.subscriptions) {
      const ticket = this.state.tickets.get(id);
      if (ticket) ticket.follows = (ticket.follows ?? []).filter((follow) => follow.thread !== thread.key);
    }
    thread.subscriptions = [];
    delete thread.context;
    this.state.touch();
    return removed;
  }

  /** A followed thread (a PR) closed or merged: tickets that follow only closed threads end. */
  threadClosed(ref: ThreadRef, outcome: "merged" | "closed"): void {
    const key = threadKey(ref);
    const at = this.now();
    for (const ticket of this.state.tickets.values()) {
      const follow = ticket.follows?.find((item) => item.thread === key);
      if (!follow || follow.closed) continue;
      follow.closed = { at, outcome };
      this.touch(ticket);
      if (ticket.ended) continue;
      const done = followsDone(ticket);
      if (done.done) this.endTicket(ticket, "executor", done.outcome ?? outcome, `Pull request ${outcome}`);
    }
  }

  /** A followed thread was reopened: the ticket follows it again. */
  threadReopened(ref: ThreadRef): void {
    const key = threadKey(ref);
    for (const ticket of this.state.tickets.values()) {
      const follow = ticket.follows?.find((item) => item.thread === key);
      if (follow?.closed) {
        delete follow.closed;
        this.touch(ticket);
      }
    }
  }

  // ---- replies -----------------------------------------------------------------------------------------------------

  /** Validates and queues an outbound message. @throws UserError when the replies rules refuse it. */
  reply(request: ReplyRequest): ReplyResult {
    return this.queueReply(request);
  }

  private queueReply(request: ReplyRequest): ReplyResult {
    if (!request.internal && this.policy().paused) throw new UserError("paused");
    const text = request.text.trim();
    if (!text) throw new UserError("invalid", "A reply needs text");
    const target = this.replyTarget(request);
    const dedupe = key("reply", request.purpose, target.dedupe, request.purpose === "acknowledgement" || request.purpose === "attention" ? "" : text);
    const existing = [...this.state.receipts.values()].find((receipt) => receipt.id === `r:${dedupe}`);
    if (existing) return { ...existing, reused: true };
    const receipt: Receipt = {
      id: `r:${dedupe}`, purpose: request.purpose, text, channel: target.channel, status: "pending", attempts: 0, createdAt: this.now(),
      ...(request.ticketId ? { ticketId: request.ticketId } : {}),
      ...(request.triggerId ? { triggerId: request.triggerId } : {}),
    };
    this.state.receipts.set(receipt.id, receipt);
    target.commit?.();
    this.state.touch();
    this.emit({ type: "reply.queued", receiptId: receipt.id });
    return { ...receipt, reused: false };
  }

  private replyTarget(request: ReplyRequest): { channel: NonNullable<Trigger["channel"]>; dedupe: string; commit?: () => void } {
    const humanQuestion = (triggerId: string | undefined) => {
      const trigger = triggerId ? this.state.triggers.get(triggerId) : undefined;
      if (!trigger) throw new UserError("unknownTrigger", `Unknown trigger ${triggerId ?? ""}`.trim());
      if (!trigger.human) throw new UserError("replyRefused", "Only a person's message is answered");
      if (!trigger.channel) throw new UserError("replyRefused", "The message has no channel to answer on");
      return trigger;
    };
    switch (request.purpose) {
      case "acknowledgement": {
        const ticket = this.ticket(request.ticketId ?? "");
        const trigger = humanQuestion(request.triggerId);
        const reached = ticket.inputs.some((input) => input.kind === "trigger" && input.triggerId === trigger.id && input.context !== true);
        if (!reached) throw new UserError("notReached");
        return { channel: trigger.channel!, dedupe: trigger.id };
      }
      case "answer": {
        const trigger = humanQuestion(request.triggerId);
        if (request.ticketId) {
          const ticket = this.ticket(request.ticketId);
          if (!ticket.answers?.includes(trigger.id)) {
            throw new UserError("replyRefused", "The ticket's worker has not taken this question up; ask it through the ticket, or answer a question it reported");
          }
          return { channel: trigger.channel!, dedupe: `${ticket.id}:${trigger.id}`, commit: () => { ticket.answers = ticket.answers?.filter((id) => id !== trigger.id); } };
        }
        if (!this.policy().allowedSender(trigger.actor)) throw new UserError("replyRefused", "Only an allowed sender's question is answered");
        return { channel: trigger.channel!, dedupe: trigger.id };
      }
      case "result": {
        const ticket = this.ticket(request.ticketId ?? "");
        const stage = ticketStage(ticket);
        if (stage !== "review" && !ticket.ended) throw new UserError("replyRefused", "A result is sent after a ready report or when the ticket has ended");
        if (ticket.ended?.outcome === "stopped") throw new UserError("replyRefused", "A stopped ticket has no result to send");
        const channel = ticket.channels[0];
        if (!channel) throw new UserError("replyRefused", "The ticket has no channel to reply on");
        return { channel, dedupe: ticket.id };
      }
      case "attention": {
        const ticket = this.liveTicket(request.ticketId ?? "");
        if (!ticket.attention) throw new UserError("replyRefused", "The ticket has no pending question for a person");
        if (request.question !== ticket.attention.question) throw new UserError("replyRefused", "human_action must repeat the ticket's current question exactly");
        const asked = ticket.attention.triggerId ? this.state.triggers.get(ticket.attention.triggerId) : undefined;
        const channel = asked?.channel ?? ticket.channels[0];
        if (!channel) throw new UserError("replyRefused", "The ticket has no channel to ask on");
        return { channel, dedupe: ticket.attention.id };
      }
      default: {
        const never: never = request.purpose;
        throw new Error(`Unhandled purpose ${String(never)}`);
      }
    }
  }

  receiptsPending(now: Date = this.deps.now?.() ?? new Date()): Receipt[] {
    return [...this.state.receipts.values()].filter((receipt) => receipt.status === "pending" && (!receipt.retryAt || Date.parse(receipt.retryAt) <= now.getTime()));
  }

  receiptSent(id: string): void {
    const receipt = this.state.receipts.get(id);
    if (!receipt) return;
    receipt.status = "sent";
    receipt.sentAt = this.now();
    delete receipt.error;
    delete receipt.retryAt;
    this.state.touch();
  }

  receiptFailed(id: string, error: string): void {
    const receipt = this.state.receipts.get(id);
    if (!receipt) return;
    receipt.attempts++;
    receipt.error = error;
    const backoff = Math.min(15 * 60_000, 15_000 * 2 ** Math.min(receipt.attempts, 6));
    receipt.retryAt = new Date((this.deps.now?.() ?? new Date()).getTime() + backoff).toISOString();
    if (receipt.attempts >= 8) {
      receipt.status = "dropped";
      receipt.droppedReason = "channelGone";
      delete receipt.retryAt;
    }
    this.state.touch();
  }

  receiptDropped(id: string, reason: NonNullable<Receipt["droppedReason"]>): void {
    const receipt = this.state.receipts.get(id);
    if (!receipt) return;
    receipt.status = "dropped";
    receipt.droppedReason = reason;
    this.state.touch();
  }

  // ---- notices & policy --------------------------------------------------------------------------------------------

  addNotice(notice: { kind: Notice["kind"]; ticketId?: string; triggerId?: string; text: string }): void {
    this.state.notices.push({
      id: this.state.nextId("n"), at: this.now(), kind: notice.kind, text: notice.text,
      ...(notice.ticketId ? { ticketId: notice.ticketId } : {}), ...(notice.triggerId ? { triggerId: notice.triggerId } : {}),
    });
    if (notice.kind === "follow_up") {
      // The oldest wait no longer: a stop is only ever asked of the latest messages.
      const waiting = this.state.notices.filter((item) => item.kind === "follow_up" && !item.delivered);
      for (const stale of waiting.slice(0, Math.max(0, waiting.length - MAX_PENDING_FOLLOWUPS))) this.state.notices.splice(this.state.notices.indexOf(stale), 1);
    }
    this.state.touch();
  }

  pendingNotices(): Notice[] {
    return this.state.notices.filter((notice) => !notice.delivered);
  }

  noticesDelivered(ids: readonly string[]): void {
    for (const notice of this.state.notices) if (ids.includes(notice.id)) notice.delivered = true;
    this.state.touch();
  }

  /** Tells each affected open ticket how a settings change bears on it. */
  applyPolicyEffects(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect>): void {
    for (const [ticketId, effect] of effects) {
      const ticket = this.state.tickets.get(ticketId);
      if (!ticket || ticket.ended) continue;
      this.pushInput(ticket, (id, at) => ({ id, kind: "policy-changed", from, to, at, effect }));
    }
  }

  /** Re-evaluates mandates after a settings change; the runtime calls this with the new policy already in force. */
  policyVersionApplied(version: string): void {
    this.state.policyVersion = version;
    this.state.touch();
  }
}

const clip = (text: string): string => (text.length > MAX_NOTICE ? `${text.slice(0, MAX_NOTICE)}…` : text);

function dedupeChannels(channels: readonly NonNullable<Trigger["channel"]>[]): NonNullable<Trigger["channel"]>[] {
  const seen = new Set<string>();
  return channels.filter((channel) => {
    const id = `${channel.source}:${channel.thread}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

