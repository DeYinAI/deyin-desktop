/** Serves paginated context resources to orchestrator_read so large bodies stay out of model prompts until requested. */
import { UserError } from "../core/errors.js";
import type { Engine } from "../core/engine.js";
import { latestAssignment } from "../core/model.js";
import type { State } from "../core/state.js";
import { textPage } from "../core/text.js";
import type { Ticket, Trigger } from "../core/types.js";
import { parseThreadKey, threadKey } from "../core/types.js";
import type { GithubReader } from "../github/read.js";
import type { Settings } from "../settings.js";
import {
  ASSIGNMENT_PAGE, INPUT_PAGE, assignmentLine, decisionCard, decisionDetails, inputLine, newestPage, threadCard, ticketCard, ticketDetails, triggerCard,
} from "./cards.js";

/** Resource descriptors; `executor` marks those a worker may read for its own ticket. */
export const RESOURCES: readonly { name: string; holds: string; executor?: true }[] = [
  { name: "tickets", holds: "ticket cards, newest first; a card's state is person/review after a ready report, person/blocked after a blocked report, person/answer with a question, person/delivery when an input could not reach the worker, working or working/queued while it works, idle once the worker ended its turn without a report, failed after a failure, else how the ticket ended" },
  { name: "triggers", holds: "trigger cards with where each went, newest first" },
  { name: "threads", holds: "subscribed threads, newest activity first, with their tickets and current assessment" },
  { name: "thread/<key>", holds: "one thread: its tickets, latest decisions and triggers, newest first", executor: true },
  { name: "decisions", holds: "decisions, newest first" },
  { name: "decision/<id>", holds: "one decision with its audit" },
  { name: "ticket/<id>", holds: "a ticket's card, the threads it is tied to, its latest assignments with the start of each report, and its inputs, newest first", executor: true },
  { name: "ticket/<id>/assignment", holds: "its assignment text", executor: true },
  { name: "ticket/<id>/assignments", holds: "its assignments, newest first, with the start of each report", executor: true },
  { name: "ticket/<id>/inputs", holds: "its inputs, newest first", executor: true },
  { name: "ticket/<id>/result", holds: "its latest report", executor: true },
  { name: "ticket/<id>/report/<id>", holds: "the report of one of its assignments", executor: true },
  { name: "ticket/<id>/input/<id>", holds: "one input it was delivered", executor: true },
  { name: "trigger/<id>", holds: "a trigger's text and where it went", executor: true },
  { name: "settings", holds: "the accept mode, enabled rules, watched repository and who may originate work (read-only)" },
  { name: "github/…", holds: "a GitHub original, as the GitHub skill describes", executor: true },
];

export const resourceGrammar = (executor: boolean): string => RESOURCES.filter((resource) => !executor || resource.executor).map((resource) => `${resource.name}: ${resource.holds}`).join("; ");

export interface ResourceHost {
  state: State;
  engine: Engine;
  settings(): Settings;
  github: GithubReader;
}

const LIST_DEFAULT = 20;
const LIST_MAX = 50;
const TEXT_DEFAULT = 4000;

function list<T, L>(items: readonly T[], offset: number, limit: number | undefined, line: (item: T) => L, next: string) {
  const size = Math.min(limit ?? LIST_DEFAULT, LIST_MAX);
  const more = offset + size < items.length;
  return { total: items.length, items: items.slice(offset, offset + size).map(line), ...(more ? { next_resource: next, next_offset: offset + size } : {}) };
}

/** Newest first; items of the same time come latest-added first, since the sort is stable over the reversed order. */
const byTime = <T>(items: Iterable<T>, time: (item: T) => string): T[] => [...items].reverse().sort((a, b) => time(b).localeCompare(time(a)));

export async function readResource(host: ResourceHost, resource: string, offset: number, limit: number | undefined, ticketId?: string, signal?: AbortSignal): Promise<unknown> {
  const { state } = host;
  const worker = ticketId !== undefined;
  const own = (ticket: Ticket) => {
    if (worker && ticket.id !== ticketId) throw new UserError("invalid", `A worker reads only its own ticket (${ticketId})`);
    return ticket;
  };
  const ticketOf = (id: string): Ticket => {
    const ticket = state.tickets.get(id);
    if (!ticket) throw new UserError("unknownTicket", `Unknown ticket ${id}`);
    return own(ticket);
  };
  const text = (value: string) => textPage(resource, value, offset, Math.min(limit ?? TEXT_DEFAULT, 8000));
  const staffOnly = (name: string) => {
    if (worker) throw new UserError("invalid", `${name} is not readable by a worker; read ticket/${ticketId ?? ""} or github/…`);
  };

  if (resource.startsWith("github/")) return host.github.resource(resource.slice("github/".length), offset, limit, signal);
  if (resource === "tickets") {
    staffOnly("tickets");
    return list(byTime(state.tickets.values(), (t) => t.createdAt), offset, limit, ticketCard, "tickets");
  }
  if (resource === "triggers") {
    staffOnly("triggers");
    return list(byTime(state.triggers.values(), (t) => t.at), offset, limit, (trigger) => triggerCard(trigger, state.disposition(trigger.id)), "triggers");
  }
  if (resource === "threads") {
    staffOnly("threads");
    return list(byTime(state.threads.values(), (t) => t.lastAt ?? t.createdAt), offset, limit, threadCard, "threads");
  }
  if (resource === "decisions") {
    staffOnly("decisions");
    return list(byTime(state.decisions.values(), (d) => d.at), offset, limit, decisionCard, "decisions");
  }
  if (resource === "settings") {
    staffOnly("settings");
    const settings = host.settings();
    const github = settings.policy.sources.github;
    return {
      mode: settings.eval.mode,
      paused: settings.paused,
      repository: settings.github.repository,
      rules: settings.policy.rules.map(({ id, name, enabled }) => ({ id, name, enabled })),
      allowed: (github?.allowed ?? []).map((entry) => entry.name ?? entry.id),
      bots: (github?.bots ?? []).map((entry) => entry.name ?? entry.id),
      observe: { issues: settings.github.observeIssues, pulls: settings.github.observePulls, comments: settings.github.observeComments },
      workers: settings.executor.maxWorkers,
      note: "Settings are changed by a person in the panel, never by the agents.",
    };
  }
  let match: RegExpExecArray | null;
  if ((match = /^decision\/([^/]+)$/.exec(resource))) {
    staffOnly("decision");
    const decision = state.decisions.get(match[1]!);
    if (!decision) throw new UserError("invalid", `Unknown decision ${match[1]}`);
    return decisionDetails(decision);
  }
  if ((match = /^thread\/(.+)$/.exec(resource))) {
    const ref = parseThreadKey(match[1]!);
    const thread = ref && state.threads.get(threadKey(ref));
    if (!thread) throw new UserError("unknownThread", `Unknown thread ${match[1]}`);
    if (worker && !thread.subscriptions.includes(ticketId)) throw new UserError("invalid", "A worker reads only threads its ticket follows");
    const triggers = byTime(state.triggersOfThread(thread.key), (t) => t.at);
    return {
      ...threadCard(thread),
      tickets_detail: thread.subscriptions.flatMap((id) => state.tickets.get(id) ?? []).map(ticketCard),
      decisions: byTime([...state.decisions.values()].filter((d) => d.threadKey === thread.key), (d) => d.at).slice(0, 5).map(decisionCard),
      triggers: triggers.slice(offset, offset + Math.min(limit ?? 10, LIST_MAX)).map((trigger) => triggerCard(trigger, state.disposition(trigger.id))),
      triggers_total: triggers.length,
    };
  }
  if ((match = /^trigger\/([^/]+)$/.exec(resource))) {
    const trigger = state.triggers.get(match[1]!);
    if (!trigger) throw new UserError("unknownTrigger", `Unknown trigger ${match[1]}`);
    if (worker) assertReached(state.tickets.get(ticketId), trigger);
    return { ...triggerCard(trigger, state.disposition(trigger.id)), ...text(trigger.text) };
  }
  if ((match = /^ticket\/([^/]+)(?:\/(assignment|assignments|inputs|result|report|input)(?:\/([^/]+))?)?$/.exec(resource))) {
    const ticket = ticketOf(match[1]!);
    const [, , part, arg] = match;
    if (!part) return ticketDetails(ticket, threadsOf(state, ticket), worker);
    switch (part) {
      case "assignment": return text(ticket.execution?.assignment ?? "");
      case "assignments": return list(ticket.assignments.slice().reverse(), offset, limit ?? ASSIGNMENT_PAGE, (item) => assignmentLine(ticket, item), `ticket/${ticket.id}/assignments`);
      case "inputs": return newestPage(ticket.inputs, offset, Math.min(limit ?? INPUT_PAGE, LIST_MAX), (input) => inputLine(ticket, input), `ticket/${ticket.id}/inputs`);
      case "result": return text(latestAssignment(ticket)?.report?.summary ?? "");
      case "report": {
        const assignment = ticket.assignments.find((item) => item.id === arg);
        if (!assignment) throw new UserError("invalid", `Unknown assignment ${arg ?? ""}`);
        return text(assignment.report?.summary ?? "");
      }
      case "input": {
        const input = ticket.inputs.find((item) => item.id === arg);
        if (!input) throw new UserError("invalid", `Unknown input ${arg ?? ""}`);
        return text(JSON.stringify(input));
      }
      default: throw new UserError("invalid", `Unknown resource "${resource}"`);
    }
  }
  throw new UserError("invalid", `Unknown resource "${resource}"; read one of: ${resourceGrammar(worker)}`);
}

function threadsOf(state: State, ticket: Ticket): { thread: string; context?: true; own?: true }[] {
  return [...state.threads.values()]
    .filter((thread) => thread.subscriptions.includes(ticket.id))
    .map((thread) => ({
      thread: thread.key,
      ...(thread.context?.includes(ticket.id) ? { context: true as const } : {}),
      ...(ticket.follows?.some((follow) => follow.thread === thread.key && follow.own) ? { own: true as const } : {}),
    }));
}

function assertReached(ticket: Ticket | undefined, trigger: Trigger): void {
  const reached = ticket && (ticket.origin.triggerIds.includes(trigger.id) || ticket.inputs.some((input) => input.kind === "trigger" && input.triggerId === trigger.id));
  if (!reached) throw new UserError("notReached", "A worker reads only messages that reached its ticket");
}
