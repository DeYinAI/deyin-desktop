/**
 * Drives the workers: one agent run per ticket that has something to do, bounded by `maxWorkers`, in a git worktree of its own.
 * Durable state decides what to run: a pending assignment, or a running one with inputs its worker has not been given.
 */
import { join } from "node:path";
import type { Engine, ExecutionRequest } from "../core/engine.js";
import { humanTriggerInput, liveAssignment } from "../core/model.js";
import type { State } from "../core/state.js";
import type { Execution, Ticket, Trigger } from "../core/types.js";
import { AgentRunError, type AgentRunner, type AgentTool, type Logger, type Workspace } from "../ports.js";
import type { Settings } from "../settings.js";
import { assignmentMessage, inputMessage, type InputContext } from "./cards.js";
import { composePrompt, environmentVariables, workerShellEnvironment, type EnvironmentInput } from "./prompts.js";

const SHUTDOWN = "shutdown";
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [3_000, 15_000];
const RESTARTED = "The app restarted while you were working. Inspect the worktree, git history and PR state, then continue the assignment without repeating completed work.";
const INTERRUPTED = "The previous attempt stopped on a temporary error. Continue where you left off.";

/** `name-slug` of a title, for a ticket whose assessor gave no name: lowercase words, at most four. */
export function slug(title: string): string {
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 4);
  const first = words.findIndex((word) => /^[a-z]/.test(word));
  return first < 0 ? "ticket" : words.slice(first).join("-").slice(0, 24).replace(/-+$/, "");
}

/** Builds a ticket's execution: a unique name ending in the ticket id, its directory under `root`, and the assignment text. */
export function buildExecution(root: string): (request: ExecutionRequest) => Execution {
  return ({ ticketId, title, scope, name }) => {
    const unique = `${name && /^[a-z]+(?:-[a-z0-9]+){0,3}$/.test(name) ? name : slug(title)}-${ticketId}`;
    return { name: unique, directory: join(root, unique), assignment: scope };
  };
}

export interface ExecutorDeps {
  engine: Engine;
  state: State;
  runner: AgentRunner;
  workspace: Workspace;
  tools(ticketId: string): AgentTool[];
  settings(): Settings;
  token(): string | undefined;
  agent(): { login: string; email: string };
  /** Whether the sender of a trigger may start work, as inputs show it to the worker. */
  allowed(trigger: Trigger): boolean;
  logger: Logger;
  now?: () => number;
  /** Called when a run finished, so the host can look for the next piece of work at once. */
  idle?(): void;
}

interface Active {
  controller: AbortController;
  assignmentId: string;
  done: Promise<void>;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export class ExecutorDriver {
  private readonly active = new Map<string, Active>();

  constructor(private readonly deps: ExecutorDeps) {}

  get running(): number {
    return this.active.size;
  }

  /** Puts right a previous process's runs: a worker that was mid-turn starts over, one that was waiting keeps waiting. */
  recover(): void {
    for (const ticket of this.deps.state.tickets.values()) {
      const live = ticket.ended ? undefined : liveAssignment(ticket);
      if (live?.state === "running" && !live.idleAt && !live.report) this.deps.engine.assignmentEnded(ticket.id, live.id, "interrupted");
    }
  }

  private get context(): InputContext {
    return { state: this.deps.state, allowed: this.deps.allowed };
  }

  /** Whether a ticket has inputs that should wake its worker: anything but messages followed for context only. */
  private wakes(ticket: Ticket): boolean {
    return ticket.inputs.some((input) => ticket.undelivered.includes(input.id) && !(input.kind === "trigger" && input.context === true));
  }

  private needsRun(ticket: Ticket): boolean {
    if (ticket.ended || ticket.delivery) return false;
    const live = liveAssignment(ticket);
    if (!live) return false;
    return live.state === "pending" || (live.state === "running" && this.wakes(ticket));
  }

  /** Aborts runs whose ticket ended or whose assignment was replaced, then starts runs for waiting tickets, people's first. */
  tick(): void {
    for (const [ticketId, run] of this.active) {
      const ticket = this.deps.state.tickets.get(ticketId);
      const live = ticket && !ticket.ended ? liveAssignment(ticket) : undefined;
      if (live?.id !== run.assignmentId && !run.controller.signal.aborted) run.controller.abort("replaced");
    }
    const settings = this.deps.settings();
    const agent = this.deps.agent();
    if (!settings.enabled || settings.paused || !this.deps.token() || !agent.login) return;
    const slots = settings.executor.maxWorkers - this.active.size;
    if (slots <= 0) return;
    const waiting = [...this.deps.state.tickets.values()].filter((ticket) => !this.active.has(ticket.id) && this.needsRun(ticket));
    const human = (ticket: Ticket) => ticket.inputs.some((input) => ticket.undelivered.includes(input.id) && humanTriggerInput(input));
    waiting.sort((a, b) => Number(human(b)) - Number(human(a)) || a.updatedAt.localeCompare(b.updatedAt));
    for (const ticket of waiting.slice(0, slots)) this.start(ticket);
  }

  private start(ticket: Ticket): void {
    const assignment = liveAssignment(ticket)!;
    const controller = new AbortController();
    const entry: Active = { controller, assignmentId: assignment.id, done: Promise.resolve() };
    this.active.set(ticket.id, entry);
    entry.done = this.work(ticket.id, entry).catch((error: unknown) => this.deps.logger.warn(`superagent worker for ${ticket.id} stopped unexpectedly: ${String(error)}`)).finally(() => {
      this.active.delete(ticket.id);
      this.deps.idle?.();
    });
  }

  async settle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active.values()].map((run) => run.done));
  }

  async stop(): Promise<void> {
    for (const run of this.active.values()) run.controller.abort(SHUTDOWN);
    await this.settle();
  }

  /** The messages for a worker: the inputs it has not been given, handed over by marking them delivered. */
  private take(ticketId: string, taken: string[]): string[] {
    const ticket = this.deps.state.tickets.get(ticketId);
    if (!ticket || ticket.undelivered.length === 0) return [];
    const ids = [...ticket.undelivered];
    const messages = ids.flatMap((id) => {
      const input = ticket.inputs.find((item) => item.id === id);
      const text = input && inputMessage(this.context, ticket, input);
      return text ? [text] : [];
    });
    this.deps.engine.inputsDelivered(ticketId, ids);
    taken.push(...ids);
    return messages;
  }

  private environment(ticket: Ticket): EnvironmentInput {
    const origin = this.deps.state.triggers.get(ticket.origin.triggerId);
    const number = Number(origin?.meta.number);
    return {
      settings: this.deps.settings(),
      agent: this.deps.agent(),
      ticket: { id: ticket.id, name: ticket.execution!.name, directory: ticket.execution!.directory },
      ...(Number.isInteger(number) && number > 0 ? { origin: { number, isPr: origin?.meta.isPr === true } } : {}),
    };
  }

  private async work(ticketId: string, run: Active): Promise<void> {
    const { engine, state } = this.deps;
    const { signal } = run.controller;
    const assignmentId = run.assignmentId;
    let prepared = false;
    let attempt = 0;
    /** Inputs given to the worker since a run last finished, which a failed delivery puts back. */
    const taken: string[] = [];
    let retryMessage: string | undefined;
    /** True when this run only delivers inputs to a worker that was already running, so a failure leaves its work intact. */
    let wakeOnly: boolean | undefined;
    const fail = (message: string) => {
      engine.assignmentEnded(ticketId, assignmentId, "failed", message);
      this.deps.logger.warn(`superagent worker for ${ticketId} failed: ${message}`);
    };
    try {
      for (;;) {
        const ticket = state.tickets.get(ticketId);
        const assignment = ticket && !ticket.ended ? liveAssignment(ticket) : undefined;
        if (!ticket || !assignment || assignment.id !== assignmentId || signal.aborted) return;
        const execution = ticket.execution;
        const token = this.deps.token();
        if (!execution || !token) return fail(!execution ? "The ticket has no execution directory" : "No GitHub token is stored for the agent account");
        const settings = this.deps.settings();
        const input = this.environment(ticket);
        const variables = environmentVariables(input);
        const env = workerShellEnvironment(variables, { token, login: input.agent.login, email: input.agent.email });
        if (!prepared) {
          try {
            await this.deps.workspace.prepare({
              name: execution.name, directory: execution.directory, branch: `${settings.github.branchPrefix}${execution.name}`, repository: settings.github.repository,
              checkout: settings.executor.checkout, env, signal,
            });
            prepared = true;
          } catch (error) {
            if (signal.aborted) throw error;
            return fail(`Could not prepare the worktree: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const starting = assignment.state === "pending";
        wakeOnly ??= !starting;
        const restarted = starting && assignment.startedAt !== undefined;
        if (starting) engine.assignmentStarted(ticketId, assignmentId);
        const messages = retryMessage
          ? [retryMessage, ...this.take(ticketId, taken)]
          : [...(starting ? [assignmentMessage(ticket, { first: ticket.assignments.length === 1 }), ...(restarted ? [RESTARTED] : [])] : []), ...this.take(ticketId, taken)];
        retryMessage = undefined;
        try {
          const result = await this.deps.runner.run({
            role: "worker", sessionId: ticketId, systemPrompt: composePrompt("worker", input), tools: this.deps.tools(ticketId), cwd: execution.directory, env,
            blockedCommands: settings.executor.blockedCommands, model: settings.executor.model, messages, drain: () => this.take(ticketId, taken), signal,
          });
          // A runner that stops for the abort signal may return instead of throwing; the run was cut short either way.
          if (signal.aborted) throw new Error("The run was aborted");
          attempt = 0;
          taken.length = 0;
          engine.turnEnded(ticketId, assignmentId, result.finalText);
        } catch (error) {
          if (signal.aborted) throw error;
          const retryable = !(error instanceof AgentRunError) || error.retryable;
          attempt += 1;
          const message = error instanceof Error ? error.message : String(error);
          if (!retryable || attempt >= MAX_ATTEMPTS) {
            const current = state.tickets.get(ticketId);
            if (wakeOnly && current && liveAssignment(current)?.id === assignmentId) {
              // A wake run that could not deliver: the work is intact, so only the inputs wait for a retry.
              engine.restoreInputs(ticketId, taken);
              engine.deliveryFailed(ticketId, message);
              this.deps.logger.warn(`superagent could not deliver inputs to ${ticketId}: ${message}`);
              return;
            }
            return fail(message);
          }
          this.deps.logger.warn(`superagent worker for ${ticketId} will retry after: ${message}`);
          retryMessage = INTERRUPTED;
          await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 15_000, signal);
          continue;
        }
        const after = state.tickets.get(ticketId);
        if (!after || !this.wakes(after)) return;
      }
    } catch (error) {
      if (!signal.aborted) throw error;
      // Shutting down leaves the assignment to start over next time; a stopped or replaced one is already over.
      if (signal.reason === SHUTDOWN) engine.assignmentEnded(ticketId, assignmentId, "interrupted");
    }
  }
}
