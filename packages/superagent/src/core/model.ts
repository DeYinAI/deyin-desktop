/** Pure predicates and projections over the domain model. */
import type { Assignment, Follow, Ticket, TicketInput, TriggerDisposition } from "./types.js";

export const isOpen = (ticket: Ticket): boolean => !ticket.ended;

export const latestAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments[ticket.assignments.length - 1];
export const liveAssignment = (ticket: Ticket): Assignment | undefined => {
  const last = latestAssignment(ticket);
  return last && last.state !== "ended" ? last : undefined;
};

/** The trigger input a person sent, as opposed to context or machine traffic. */
export const humanTriggerInput = (input: TicketInput): input is Extract<TicketInput, { kind: "trigger" }> =>
  input.kind === "trigger" && input.human === true && input.context !== true;

/** Outcome of a ticket's work as seen from the latest assignment's report. */
export type TicketStage =
  | "queued"
  | "working"
  | "waiting"
  | "review"
  | "person"
  | "blocked"
  | "failed"
  | "delivery"
  | "ended";

/** Where a ticket stands, for the UI and the retry rule. */
export function ticketStage(ticket: Ticket): TicketStage {
  if (ticket.ended) return "ended";
  if (ticket.delivery) return "delivery";
  const last = latestAssignment(ticket);
  if (!last || last.state === "pending") return "queued";
  const report = last.report;
  if (report?.state === "failed") return "failed";
  if (report?.state === "blocked") return ticket.attention ? "person" : "blocked";
  if (report?.state === "ready") return "review";
  if (ticket.attention) return "person";
  if (last.state === "running" && last.idleAt) return "waiting";
  return last.state === "running" ? "working" : "queued";
}

/** True when the ticket waits on a person (a question is open or the result awaits review). */
export const waitsForPerson = (ticket: Ticket): boolean => {
  const stage = ticketStage(ticket);
  return stage === "person" || stage === "review";
};

/** A ticket's follows, with their thread keys. */
export const followOf = (ticket: Ticket, thread: string): Follow | undefined => ticket.follows?.find((follow) => follow.thread === thread);

/** True when every thread the ticket follows has ended. */
export const followsDone = (ticket: Ticket): { done: boolean; outcome?: "merged" | "closed" } => {
  const follows = ticket.follows ?? [];
  if (follows.length === 0 || follows.some((follow) => !follow.closed)) return { done: false };
  const latest = [...follows].sort((a, b) => a.closed!.at.localeCompare(b.closed!.at)).at(-1)!;
  return { done: true, outcome: latest.closed!.outcome };
};

/** A trigger's dispositions that mean no ticket's worker has taken it up yet. */
export const unhandled = (disposition: TriggerDisposition | undefined): boolean =>
  !disposition || (disposition.fanout.length === 0 && !disposition.filtered && !disposition.decisionId);

/** Whether the ticket still has inputs waiting for a worker. */
export const hasUndelivered = (ticket: Ticket): boolean => ticket.undelivered.length > 0;
