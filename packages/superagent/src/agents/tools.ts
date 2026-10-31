/**
 * The tools the two agent roles call. Names and meanings are the ones the embedded prompts use; every tool validates its
 * arguments with the schema it declares, then runs one engine command. A refusal is a thrown {@link UserError} the model reads.
 */
import { UserError } from "../core/errors.js";
import type { Engine } from "../core/engine.js";
import { humanTriggerInput, liveAssignment } from "../core/model.js";
import { reasonText } from "../core/reasons.js";
import type { State } from "../core/state.js";
import { IM_WORDS, NOTE_WORDS, wordCount } from "../core/text.js";
import type { Decision, Ticket, Trigger } from "../core/types.js";
import { parseThreadKey } from "../core/types.js";
import { claimPull } from "../github/channel.js";
import type { GithubClient } from "../github/client.js";
import type { AgentTool, Logger } from "../ports.js";
import * as s from "../schema.js";
import type { Infer, Schema } from "../schema.js";
import type { Settings } from "../settings.js";
import { Assessor, AssessmentSchema, EvalReadSchema, WorktreeNameSchema, AcknowledgementSchema, assessmentOutcome } from "./assessment.js";
import { ticketCard } from "./cards.js";
import { readResource, resourceGrammar, type ResourceHost } from "./resources.js";

export interface ToolsHost {
  engine: Engine;
  state: State;
  settings(): Settings;
  resources: ResourceHost;
  assessor: Assessor;
  client: GithubClient;
  /** The agent account's login, which a claimed pull request must belong to. */
  agent(): string;
  logger: Logger;
  /** Wakes the drivers after a command queued work (a ticket to start, a reply to send). */
  wake(): void;
  /** Delivers queued replies now, so a tool can report their outcome. */
  sendReplies(): Promise<void>;
}

/** Declares a tool whose arguments are parsed by `schema` before `run`. */
function tool<S extends Schema<unknown>>(name: string, description: string, schema: S, run: (args: Infer<S>, signal: AbortSignal) => Promise<unknown> | unknown): AgentTool {
  return {
    name,
    description,
    parameters: schema.json,
    execute: async (args, signal) => run(schema.parse(args === undefined ? {} : args) as Infer<S>, signal),
  };
}

const ReadSchema = (executor: boolean) =>
  s.object({
    resource: s.describe(s.string({ min: 1 }), `The resource, one of: ${resourceGrammar(executor)}.`),
    offset: s.describe(s.optional(s.number({ int: true, min: 0 })), "Copy next_offset from the previous page; it counts characters of a text and items of a list."),
    limit: s.describe(s.optional(s.number({ int: true, min: 1, max: 8000 })), "Characters of a text, 4000 by default and 8000 at most, or items of a list, 20 by default and 50 at most."),
  });

const RoutingNoteSchema = s.string({
  trim: true,
  description: `Optional routing background or explicit human constraint, at most ${NOTE_WORDS} words. Never add implementation instructions or replace the original source.`,
  check: (text) => (wordCount(text) <= NOTE_WORDS ? undefined : `a routing note has at most ${NOTE_WORDS} words; shorten it, do not split it across deliveries`),
});

const RouteKinds = ["accept", "attach", "ignore", "stop"] as const;
type RouteKind = (typeof RouteKinds)[number];

const RouteItemSchema = s.object({
  kind: s.enumeration(RouteKinds),
  trigger_id: s.describe(s.string({ min: 1 }), "The candidate card's trigger_id; deciding it decides its batch."),
  ticket_id: s.describe(s.nullish(s.string()), "attach and stop: the ticket."),
  title: s.describe(s.nullish(s.string()), "accept: a short label of at most 200 characters describing the original request; no added requirements or implementation advice."),
  worktree_name: s.describe(s.nullish(s.string()), `accept: ${String(WorktreeNameSchema.json.description ?? "")}`),
  acknowledgement: s.describe(
    s.nullish(s.string()),
    `accept: one brief sentence of at most ${IM_WORDS} words naming the concrete change and intended result in the source language. It is posted as a reply to the original source on acceptance, so do not quote the source. No generic "I will handle it".`,
  ),
  note: s.describe(s.nullish(s.string()), `accept and attach: ${String(RoutingNoteSchema.json.description ?? "")}`),
  reason: s.describe(s.nullish(s.string()), "ignore and stop: why, at most 500 characters; an ignore needs it."),
});
type RouteItem = Infer<typeof RouteItemSchema>;
type Field = Exclude<keyof RouteItem, "kind" | "trigger_id">;

/** Each field's check, the kinds that read it and the kinds that need it; an item of another kind leaves it unread. */
const FIELDS: Record<Field, { check: Schema<unknown>; reads: readonly RouteKind[]; needs: readonly RouteKind[] }> = {
  ticket_id: { check: s.string(), reads: ["attach", "stop"], needs: ["attach", "stop"] },
  title: { check: s.string({ max: 200 }), reads: ["accept"], needs: ["accept"] },
  worktree_name: { check: WorktreeNameSchema, reads: ["accept"], needs: ["accept"] },
  acknowledgement: { check: AcknowledgementSchema, reads: ["accept"], needs: ["accept"] },
  note: { check: RoutingNoteSchema, reads: ["accept", "attach"], needs: [] },
  reason: { check: s.string({ max: 500 }), reads: ["ignore", "stop"], needs: ["ignore"] },
};

/** Why an item cannot run: a field its kind needs is missing, or one it reads breaks its limit. */
function invalidItem(item: RouteItem): string | undefined {
  for (const field of Object.keys(FIELDS) as Field[]) {
    const { check, reads, needs } = FIELDS[field];
    if (!reads.includes(item.kind)) continue;
    const value = item[field];
    if (value === undefined || value === null || value.trim() === "") {
      if (needs.includes(item.kind)) return `${item.kind} needs ${field}`;
      continue;
    }
    try {
      check.parse(value, field);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return undefined;
}

interface Routed { decision?: Decision["kind"]; reason: string; ticketId?: string | undefined; triggerIds?: readonly string[] }

function fromDecision(decision: Decision): Routed {
  return { decision: decision.kind, reason: decision.reason.map(reasonText).join("; "), ticketId: decision.ticketId, triggerIds: decision.triggerIds };
}

/** Tickets whose worker owns a person's follow-up: it reached them as a message, so the worker decides whether it is theirs. */
function followupOwners(state: State, trigger: Trigger): string[] {
  const disposition = state.dispositions.get(trigger.id);
  if (!disposition) return [];
  return disposition.fanout.filter((id) => {
    const ticket = state.tickets.get(id);
    return !!ticket && !ticket.ended && ticket.inputs.some((input) => humanTriggerInput(input) && input.kind === "trigger" && input.triggerId === trigger.id);
  });
}

function route(host: ToolsHost, item: RouteItem, decided: ReadonlyMap<string, string>): Routed | { refused: string } {
  const { engine, state } = host;
  const earlier = decided.get(item.trigger_id);
  if (earlier && item.kind === "ignore") return { refused: `Decided in this call with ${earlier}, whose decision took its batch` };
  switch (item.kind) {
    case "accept": {
      const before = state.dispositions.get(item.trigger_id)?.decisionId;
      const decision = engine.decide(item.trigger_id, {
        kind: "accept", title: item.title!, scope: item.title!, reason: { code: "explicitRouted" }, acknowledgement: item.acknowledgement!, name: item.worktree_name!,
        ...(item.note ? { note: item.note } : {}),
      });
      if (decision.kind !== "accept" || !decision.ticketId) return { refused: `Ticket was not created: ${decision.reason.map(reasonText).join("; ")}` };
      if (decision.id === before) return { decision: "accept", reason: `Already accepted as ${decision.ticketId}; title and acknowledgement unchanged`, ticketId: decision.ticketId };
      return fromDecision(decision);
    }
    case "attach": {
      const ticket = engine.attach(item.ticket_id!, item.trigger_id, item.note ?? undefined);
      return { reason: "Attached: the ticket follows the trigger's thread and receives the trigger", ticketId: ticket.id };
    }
    case "stop":
      return fromDecision(engine.decide(item.trigger_id, { kind: "stop", ticketId: item.ticket_id!, reason: item.reason || { code: "humanStop" } }));
    case "ignore":
      return fromDecision(engine.decide(item.trigger_id, { kind: "ignore", reason: item.reason! }));
    default: {
      const never: never = item.kind;
      throw new Error(`Unhandled routing kind ${String(never)}`);
    }
  }
}

function routed(host: ToolsHost, result: Routed) {
  host.wake();
  const ticket = result.ticketId ? host.state.tickets.get(result.ticketId) : undefined;
  return { ...(result.decision ? { decision: result.decision } : {}), reason: result.reason, ...(ticket ? { ticket: ticketCard(ticket) } : {}) };
}

const HEAD = (item: RouteItem) => ({ trigger_id: item.trigger_id, kind: item.kind });

/** The orchestrator's tools: it routes, assesses and answers, and has no file or shell access. */
export function orchestratorTools(host: ToolsHost): AgentTool[] {
  const { engine, state } = host;
  return [
    tool(
      "orchestrator_read",
      "Read one page of a resource the resource parameter lists, such as the ticket list or a ticket. Follow next_offset, and next_resource where a page names one.",
      ReadSchema(false),
      (args, signal) => readResource(host.resources, args.resource, args.offset ?? 0, args.limit, undefined, signal),
    ),
    tool(
      "orchestrator_route",
      "Route candidates, one item each by the card's trigger_id, in one call: accept an explicit request as a new ticket, attach a trigger to an existing ticket, stop a ticket on a person's stop message, or ignore a candidate that needs no ticket or stop, as dispatch says. Items run in order and each is answered on its own; a refused item leaves the others. An inferred candidate may be ignored here; accepting one goes through orchestrator_eval_decide.",
      s.object({ decisions: s.array(RouteItemSchema, { min: 1, max: 20 }) }),
      ({ decisions }) => {
        const decided = new Map<string, string>();
        const results = decisions.map((item) => {
          const problem = invalidItem(item);
          if (problem) return { ...HEAD(item), refused: problem };
          try {
            const result = route(host, item, decided);
            if ("refused" in result) return { ...HEAD(item), ...result };
            for (const id of result.triggerIds ?? []) if (!decided.has(id)) decided.set(id, item.trigger_id);
            const ticket = result.ticketId ? state.tickets.get(result.ticketId) : undefined;
            return { ...HEAD(item), ...(result.decision ? { decision: result.decision } : {}), reason: result.reason, ...(ticket ? { ticket: ticketCard(ticket) } : {}) };
          } catch (error) {
            if (error instanceof UserError) return { ...HEAD(item), refused: error.message };
            host.logger.warn(`superagent could not route trigger ${item.trigger_id}: ${String(error)}`);
            return { ...HEAD(item), refused: `Not recorded: ${error instanceof Error ? error.message : String(error)}; retry this item` };
          }
        });
        host.wake();
        return { results };
      },
    ),
    tool(
      "orchestrator_ticket_retry",
      "Start a new assignment on an explicit human request to retry a ticket whose worker reported failed or blocked, or whose input was not delivered; the stalled one ends.",
      s.object({ ticket_id: s.string({ min: 1 }) }),
      (args) => routed(host, { reason: "Started a new assignment", ticketId: engine.retryTicket(args.ticket_id).id }),
    ),
    tool(
      "orchestrator_ticket_request_status",
      "Ask the worker of an idle ticket, one whose turn ended without a report, for a status report; for other tickets it sends nothing and returns the card.",
      s.object({ ticket_id: s.string({ min: 1 }) }),
      (args) => routed(host, { reason: engine.requestStatus(args.ticket_id) ? "Asked the worker for a status report" : "The worker is not waiting; nothing was sent", ticketId: args.ticket_id }),
    ),
    tool(
      "orchestrator_ticket_note",
      "Tell a ticket's worker a fact from other work, such as what another ticket found; it grants no authority.",
      s.object({
        ticket_id: s.string({ min: 1 }),
        text: s.string({ trim: true, min: 1, check: (text) => (wordCount(text) <= IM_WORDS ? undefined : `at most ${IM_WORDS} words`) }),
      }),
      (args) => {
        engine.note(args.ticket_id, args.text);
        return routed(host, { reason: "Noted for the worker", ticketId: args.ticket_id });
      },
    ),
    tool(
      "orchestrator_trigger_requeue",
      "Queue a trigger for a fresh assessment, such as after its Source's access changed; a follow-up that reached a ticket comes back only from its worker.",
      s.object({ trigger_id: s.string({ min: 1 }) }),
      (args) => {
        const trigger = state.triggers.get(args.trigger_id);
        const owners = trigger ? followupOwners(state, trigger) : [];
        if (owners.length > 0) throw new UserError("workerDecides", `A ticket's worker decides this follow-up (${owners.join(", ")}); only a stop is allowed here`);
        const queued = engine.reevaluate(args.trigger_id);
        host.wake();
        return { queued };
      },
    ),
    tool(
      "orchestrator_eval",
      "Load a proactive candidate's window and its thread's tickets; repeated calls reuse them.",
      s.object({ trigger_id: s.string({ min: 1 }) }),
      (args, signal) => host.assessor.context(args.trigger_id, signal),
    ),
    tool(
      "orchestrator_eval_read",
      "Read more of a candidate's context, always with its trigger_id: a message or stub whole by message_id, an image by image_id, the root, the parent, a thread page by cursor, or a file or directory by path.",
      EvalReadSchema,
      (read, signal) => host.assessor.read(read, signal),
    ),
    tool(
      "orchestrator_eval_decide",
      "Record the decision of an assessment, as admission describes it, after orchestrator_eval with the same trigger_id.",
      AssessmentSchema,
      (assessment) => {
        const candidate = engine.candidate(assessment.trigger_id);
        if (!candidate) throw new UserError("noAssessment");
        if (candidate.strength === "explicit") throw new UserError("notExplicit");
        if (!host.assessor.loaded(assessment.trigger_id)) throw new UserError("invalid", "Call orchestrator_eval with this trigger_id before deciding it");
        const decision = engine.decide(assessment.trigger_id, assessmentOutcome(assessment, host.settings(), candidate.strength));
        return routed(host, fromDecision(decision));
      },
    ),
    tool(
      "orchestrator_reply",
      `Send an answer to a human question, a ready result, or attention requiring human action, as the replies section says; the gate refuses anything else, such as progress. purpose=result needs a ticket in person/review after a ready report, a completed or merged one, or a dropped one whose matched rule asks for a closing message. Limit: ${IM_WORDS} words for an answer or acknowledgement.`,
      s.object({
        trigger_id: s.describe(s.optional(s.string()), "The original human question, for an answer only."),
        ticket_id: s.optional(s.string()),
        purpose: s.enumeration(["answer", "result", "attention"] as const),
        human_action: s.describe(s.optional(s.string({ trim: true, min: 1 })), "Required for attention: the ticket's current attention question."),
        text: s.string({ min: 1, max: 20000 }),
      }),
      async (args) => {
        const reply = engine.reply({
          purpose: args.purpose, text: args.text,
          ...(args.trigger_id ? { triggerId: args.trigger_id } : {}),
          ...(args.ticket_id ? { ticketId: args.ticket_id } : {}),
          ...(args.human_action ? { question: args.human_action } : {}),
        });
        await host.sendReplies();
        return { status: state.receipts.get(reply.id)?.status ?? reply.status };
      },
    ),
    tool(
      "orchestrator_thread_unsubscribe",
      "Drop every ticket subscription on a thread. Later messages there no longer reach those tickets as context; a new positive decision can subscribe it again.",
      s.object({ thread: s.describe(s.string({ min: 1 }), "Thread key, for example github:123") }),
      (args) => ({ removed: engine.unsubscribe(args.thread), thread: args.thread }),
    ),
  ];
}

/** A worker's tools for its own ticket, on top of the file and shell tools the host gives it. */
export function workerTools(host: ToolsHost, ticketId: string): AgentTool[] {
  const { engine, state } = host;
  return [
    tool(
      "orchestrator_read",
      "Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.",
      ReadSchema(true),
      (args, signal) => readResource(host.resources, args.resource, args.offset ?? 0, args.limit, ticketId, signal),
    ),
    tool(
      "orchestrator_ack",
      "Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.",
      s.object({ trigger_id: s.string({ min: 1 }), text: s.describe(AcknowledgementSchema, `At most ${IM_WORDS} words; Markdown is supported.`) }),
      async (args) => {
        const reply = engine.reply({ purpose: "acknowledgement", ticketId, triggerId: args.trigger_id, text: args.text });
        if (reply.status !== "sent") await host.sendReplies();
        return { trigger_id: args.trigger_id, acknowledgement: state.receipts.get(reply.id)?.status ?? reply.status, reused: reply.reused };
      },
    ),
    tool(
      "orchestrator_thread_unrelated",
      "Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.",
      s.object({
        thread: s.describe(s.string({ min: 1 }), "The thread key, which trigger/<id> of one of its messages shows as thread, such as github:<number>."),
        reason: s.describe(s.string({ trim: true, min: 1, max: 300 }), "One sentence on why the thread is not about this ticket."),
      }),
      (args) => {
        engine.markUnrelated(ticketId, args.thread, args.reason);
        return { removed: true, thread: args.thread };
      },
    ),
    tool(
      "orchestrator_thread_follow",
      "Follow a related thread, such as an Issue or another PR, for context only.",
      s.object({
        thread: s.describe(s.string({ min: 1 }), "Thread key, such as github:<number>."),
        reason: s.describe(s.string({ trim: true, min: 1, max: 300 }), "How it relates, in one sentence."),
      }),
      (args) => {
        const ref = parseThreadKey(args.thread);
        if (!ref) throw new UserError("invalid", "A thread key is <source>:<id>, such as github:<number>");
        const followed = engine.followForContext(ticketId, ref);
        if (followed) engine.addNotice({ kind: "text", ticketId, text: `Ticket ${ticketId} now follows ${args.thread} for context: ${args.reason}` });
        return { followed, thread: args.thread };
      },
    ),
    tool(
      "orchestrator_trigger_handback",
      "Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket's to decide, such as a bot's, which is assessed without it.",
      s.object({
        trigger_id: s.string({ min: 1 }),
        reason: s.describe(s.string({ trim: true, min: 1, max: 300 }), "One sentence on what it asks for beyond this ticket."),
      }),
      (args) => {
        const queued = engine.handback(ticketId, args.trigger_id, args.reason);
        if (queued) host.wake();
        return { trigger_id: args.trigger_id, queued };
      },
    ),
    tool(
      "orchestrator_report",
      "Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.",
      s.object({
        state: s.enumeration(["progress", "ready", "blocked", "failed", "dropped"] as const),
        summary: s.string({ min: 1 }),
        human_action: s.describe(s.nullish(s.string({ trim: true, min: 1, max: 1000 })), "One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it."),
        question_for_trigger_id: s.describe(s.optional(s.string()), "With human_action: the human message that raised the question, which is asked where that person wrote."),
        pr_number: s.describe(s.nullish(s.number({ int: true, min: 1 })), "The ticket's PR: its source PR, or one by the agent account from a branch named after this ticket (DSH_SUPERAGENT_NAME)."),
        reply_to_trigger_id: s.describe(s.optional(s.string()), "The explicit human question this report answers; never for ordinary progress."),
      }),
      async (args, signal) => {
        const ticket = state.tickets.get(ticketId);
        if (!ticket || ticket.ended) throw new UserError("ticketEnded", "Ticket ended (PR was closed or work finished); do not resume it");
        const claim = args.pr_number != null ? await claimTicketPull(host, ticket, args.pr_number, signal) : undefined;
        const updated = engine.report(
          ticketId,
          {
            state: args.state, summary: args.summary,
            ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}),
          },
          claim,
        );
        host.wake();
        const relayed = args.state !== "progress" || (updated.attention !== undefined && args.human_action !== undefined);
        return { reported: true, notification: relayed ? "orchestrator" : "internal_only", ...(updated.attention ? { attention: updated.attention } : {}) };
      },
    ),
  ];
}

/** Checks, against GitHub, that `ticket` may claim pull request `number`; the binding itself happens with the report. */
async function claimTicketPull(host: ToolsHost, ticket: Ticket, number: number, signal: AbortSignal) {
  const claim = await claimPull(host.client, { repository: host.settings().github.repository, agent: host.agent() }, ticket, number, signal);
  if (claim.refusal) throw new UserError("invalid", claim.refusal);
  // The ticket must still run an assignment once GitHub answered; the engine re-checks it when the report lands.
  if (!liveAssignment(ticket)) throw new UserError("ticketEnded", "The ticket has no running assignment");
  const own = !ticket.follows?.some((follow) => follow.thread === `github:${number}` && !follow.own);
  return { ref: { source: "github", id: String(number) }, own };
}
