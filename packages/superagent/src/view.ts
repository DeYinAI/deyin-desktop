/** Plain, bounded, JSON-serializable projections of the state for a UI; no secrets and no raw agent transcripts. */
import { ticketCard, policyMessage, type TicketCardState } from "./agents/cards.js";
import { ticketStage } from "./core/model.js";
import { reasonText } from "./core/reasons.js";
import type { State } from "./core/state.js";
import { preview } from "./core/text.js";
import type { Candidate, Decision, Receipt, Ticket, TicketInput, Trigger } from "./core/types.js";
import type { Settings } from "./settings.js";

export interface SuperagentStatus {
  enabled: boolean;
  paused: boolean;
  mode: Settings["eval"]["mode"];
  /** Nothing blocks running: the token, repository and allow-list are set up. */
  ready: boolean;
  gaps: string[];
  repository: string;
  account: { login: string } | null;
  accountError: string | null;
  poll: { at: string | null; error: string | null };
  orchestrator: { running: boolean };
  workers: { running: number; max: number };
  storeError: string | null;
}

export interface AssignmentView {
  id: string;
  state: "pending" | "running" | "ended";
  startedAt?: string;
  endedAt?: string;
  endedReason?: string;
  report?: { state: string; summary: string; at: string };
}

export interface InputView {
  id: string;
  at: string;
  kind: TicketInput["kind"];
  from?: string;
  text: string;
  delivered: boolean;
}

export interface TicketView {
  id: string;
  title: string;
  state: TicketCardState;
  strength: "explicit" | "inferred";
  requestedBy: string;
  rules: string[];
  threads: string[];
  prNumber?: number;
  url?: string;
  branch: string;
  directory: string;
  attention?: string;
  delivery?: string;
  ended?: { at: string; by: string; reason: string };
  createdAt: string;
  updatedAt: string;
  assignments: AssignmentView[];
  inputs: InputView[];
  undelivered: number;
  /** Whether a person can stop, retry or resume it now. */
  canStop: boolean;
  canRetry: boolean;
}

export interface CandidateView {
  triggerId: string;
  thread: string;
  strength: "explicit" | "inferred";
  from: string;
  text: string;
  url?: string;
  delivered: boolean;
  since: string;
}

export interface DecisionView {
  id: string;
  at: string;
  kind: Decision["kind"];
  strength: "explicit" | "inferred";
  thread: string;
  reason: string;
  from?: string;
  text?: string;
  url?: string;
  ticketId?: string;
  wouldAccept: boolean;
  /** The first trigger, which can be sent to assessment again. */
  triggerId?: string;
}

export interface ReceiptView {
  id: string;
  at: string;
  purpose: Receipt["purpose"];
  status: Receipt["status"];
  text: string;
  thread: string;
  ticketId?: string;
  error?: string;
}

export interface SuperagentView {
  /** Changes whenever the state does, so a client can skip an unchanged one. */
  revision: number;
  status: SuperagentStatus;
  settings: Settings;
  settingsRevision: number;
  tickets: TicketView[];
  candidates: CandidateView[];
  decisions: DecisionView[];
  receipts: ReceiptView[];
}

const LIMITS = { tickets: 100, decisions: 60, receipts: 40, inputs: 25, assignments: 8, text: 600 };
const newest = <T>(items: Iterable<T>, time: (item: T) => string): T[] => [...items].reverse().sort((a, b) => time(b).localeCompare(time(a)));

function inputView(state: State, ticket: Ticket, input: TicketInput): InputView {
  const base = { id: input.id, at: input.at, kind: input.kind, delivered: !ticket.undelivered.includes(input.id) };
  switch (input.kind) {
    case "trigger": {
      const trigger = state.triggers.get(input.triggerId);
      return { ...base, ...(trigger ? { from: trigger.actor.id } : {}), text: preview(trigger?.text ?? `(message ${input.triggerId} was pruned)`, LIMITS.text) };
    }
    case "policy-changed": return { ...base, text: preview(policyMessage(input.effect), LIMITS.text) };
    case "resumed": return { ...base, text: "The ticket was resumed by a message on its thread" };
    case "text":
    case "note": return { ...base, text: preview(input.text, LIMITS.text) };
    default: {
      const never: never = input;
      throw new Error(`Unhandled input ${JSON.stringify(never)}`);
    }
  }
}

export function ticketView(state: State, repository: string, ticket: Ticket): TicketView {
  const card = ticketCard(ticket);
  const stage = ticketStage(ticket);
  const origin = state.triggers.get(ticket.origin.triggerId);
  const number = card.pr_number ?? Number(origin?.meta.number);
  return {
    id: ticket.id,
    title: ticket.title,
    state: card.state,
    strength: ticket.mandate.strength,
    requestedBy: ticket.mandate.actor.id,
    rules: ticket.mandate.basis.rules ?? [],
    threads: [...state.threads.values()].filter((thread) => thread.subscriptions.includes(ticket.id)).map((thread) => thread.key),
    ...(card.pr_number ? { prNumber: card.pr_number } : {}),
    ...(Number.isInteger(number) && number > 0 && repository ? { url: `https://github.com/${repository}/${card.pr_number ? "pull" : "issues"}/${number}` } : {}),
    branch: ticket.execution?.name ?? "",
    directory: ticket.execution?.directory ?? "",
    ...(ticket.attention ? { attention: ticket.attention.question } : {}),
    ...(ticket.delivery ? { delivery: ticket.delivery.error } : {}),
    ...(ticket.ended ? { ended: { at: ticket.ended.at, by: ticket.ended.by, reason: ticket.ended.reason ?? ticket.ended.outcome } } : {}),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    assignments: ticket.assignments.slice(-LIMITS.assignments).reverse().map((assignment) => ({
      id: assignment.id, state: assignment.state,
      ...(assignment.startedAt ? { startedAt: assignment.startedAt } : {}),
      ...(assignment.endedAt ? { endedAt: assignment.endedAt } : {}),
      ...(assignment.endedReason ? { endedReason: assignment.endedReason } : {}),
      ...(assignment.report ? { report: { state: assignment.report.state, summary: preview(assignment.report.summary, 1500), at: assignment.report.at } } : {}),
    })),
    inputs: ticket.inputs.slice(-LIMITS.inputs).reverse().map((input) => inputView(state, ticket, input)),
    undelivered: ticket.undelivered.length,
    canStop: !ticket.ended,
    canRetry: !ticket.ended && (stage === "failed" || stage === "blocked" || stage === "delivery"),
  };
}

function candidateView(candidate: Candidate): CandidateView {
  const primary: Trigger = candidate.triggers.at(-1) ?? candidate.triggers[0]!;
  return {
    triggerId: primary.id, thread: candidate.thread.key, strength: candidate.strength, from: primary.actor.id, text: preview(primary.text, LIMITS.text),
    ...(primary.url ? { url: primary.url } : {}), delivered: candidate.delivered !== undefined, since: candidate.thread.evaluating?.startedAt ?? primary.at,
  };
}

function decisionView(state: State, decision: Decision): DecisionView {
  const trigger = state.triggers.get(decision.triggerIds[0] ?? "");
  return {
    id: decision.id, at: decision.at, kind: decision.kind, strength: decision.strength, thread: decision.threadKey, reason: reasonText(decision.reason),
    ...(trigger ? { from: trigger.actor.id, text: preview(trigger.text, 280), ...(trigger.url ? { url: trigger.url } : {}) } : {}),
    ...(decision.ticketId ? { ticketId: decision.ticketId } : {}),
    wouldAccept: decision.audit?.would_accept === true,
    ...(trigger ? { triggerId: trigger.id } : {}),
  };
}

function receiptView(receipt: Receipt): ReceiptView {
  return {
    id: receipt.id, at: receipt.sentAt ?? receipt.createdAt, purpose: receipt.purpose, status: receipt.status, text: preview(receipt.text, LIMITS.text), thread: receipt.channel.thread,
    ...(receipt.ticketId ? { ticketId: receipt.ticketId } : {}), ...(receipt.error ? { error: receipt.error } : {}),
  };
}

export interface ViewInput {
  state: State;
  settings: Settings;
  settingsRevision: number;
  candidates: Candidate[];
  status: SuperagentStatus;
}

export function buildView({ state, settings, settingsRevision, candidates, status }: ViewInput): SuperagentView {
  const repository = settings.github.repository;
  const open = (ticket: Ticket) => (ticket.ended ? 1 : 0);
  const tickets = [...state.tickets.values()].reverse().sort((a, b) => open(a) - open(b) || b.updatedAt.localeCompare(a.updatedAt));
  return {
    revision: state.revision,
    status,
    settings,
    settingsRevision,
    tickets: tickets.slice(0, LIMITS.tickets).map((ticket) => ticketView(state, repository, ticket)),
    candidates: candidates.map(candidateView),
    decisions: newest(state.decisions.values(), (decision) => decision.at).slice(0, LIMITS.decisions).map((decision) => decisionView(state, decision)),
    receipts: newest(state.receipts.values(), (receipt) => receipt.sentAt ?? receipt.createdAt).slice(0, LIMITS.receipts).map(receiptView),
  };
}
