import { Engine } from "../src/core/engine.js";
import { State } from "../src/core/state.js";
import type { Trigger } from "../src/core/types.js";
import { Assessor } from "../src/agents/assessment.js";
import type { ResourceHost } from "../src/agents/resources.js";
import { orchestratorTools, workerTools, type ToolsHost } from "../src/agents/tools.js";
import { buildExecution } from "../src/agents/executor.js";
import { GithubClient } from "../src/github/client.js";
import { GithubReader } from "../src/github/read.js";
import { GithubSource, githubScope } from "../src/github/source.js";
import { settingsPolicy } from "../src/policy.js";
import type { AgentRunRequest, AgentRunResult, AgentRunner, AgentTool, Logger, PrepareInput, Workspace } from "../src/ports.js";
import type { Settings } from "../src/settings.js";
import { FakeGithub } from "./fake-github.js";
import { AGENT, makeSettings } from "./helpers.js";

export const silent: Logger & { warnings: string[] } = {
  warnings: [],
  info() {},
  warn(message) {
    this.warnings.push(message);
  },
};

/** An agent runner whose behavior a test scripts per run. */
export class ScriptedRunner implements AgentRunner {
  readonly runs: AgentRunRequest[] = [];
  readonly forgotten: string[] = [];
  constructor(public handler: (request: AgentRunRequest, index: number) => Promise<string | void> | string | void = () => "") {}
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const index = this.runs.push(request) - 1;
    const finalText = await this.handler(request, index);
    return { finalText: finalText ?? "" };
  }
  async forget(sessionId: string): Promise<void> {
    this.forgotten.push(sessionId);
  }
}

export class FakeWorkspace implements Workspace {
  readonly prepared: PrepareInput[] = [];
  readonly removed: string[] = [];
  failWith: string | undefined;
  async prepare(input: PrepareInput): Promise<void> {
    if (this.failWith) throw new Error(this.failWith);
    this.prepared.push(input);
  }
  async remove({ directory }: { directory: string }): Promise<void> {
    this.removed.push(directory);
  }
}

export function call(tools: readonly AgentTool[], name: string, args: unknown = {}, signal: AbortSignal = new AbortController().signal): Promise<any> {
  const found = tools.find((tool) => tool.name === name);
  if (!found) throw new Error(`No tool ${name}`);
  return found.execute(args, signal);
}

export interface AgentsWorld {
  fake: FakeGithub;
  state: State;
  engine: Engine;
  client: GithubClient;
  reader: GithubReader;
  source: GithubSource;
  assessor: Assessor;
  host: ToolsHost;
  current: { settings: Settings };
  woken: { count: number };
  /** Whether the trigger's sender may start work under the current settings. */
  allowed(trigger: Trigger): boolean;
  orchestrator(): AgentTool[];
  worker(ticketId: string): AgentTool[];
  /** Receives a request through intake so it is evaluated next. */
  receive(trigger: Trigger): void;
  /** Accepts the explicit request `trigger` through the orchestrator's route tool and returns its ticket id. */
  accept(trigger: Trigger, name?: string): Promise<string>;
  /** Marks the ticket's first assignment as running, as the executor does. */
  start(ticketId: string): void;
}

export function agentsWorld(settings: Settings = makeSettings(), root = "/work"): AgentsWorld {
  const fake = new FakeGithub();
  const current = { settings };
  const state = new State();
  const engine = new Engine(state, {
    policy: () => settingsPolicy(current.settings, githubScope(current.settings)),
    now: () => fake.clock.now,
    execution: buildExecution(root),
  });
  const client = new GithubClient({ fetch: fake.fetch, token: () => "token", now: () => fake.clock.now.getTime() });
  const reader = new GithubReader({ client, repository: () => current.settings.github.repository });
  const source = new GithubSource({ client, engine, state, settings: () => current.settings, agentLogin: () => AGENT, now: () => fake.clock.now });
  const assessor = new Assessor({ engine, state, reader });
  const resources: ResourceHost = { state, engine, settings: () => current.settings, github: reader };
  const woken = { count: 0 };
  const host: ToolsHost = {
    engine, state, settings: () => current.settings, resources, assessor, client, agent: () => AGENT, logger: silent,
    wake: () => {
      woken.count += 1;
    },
    sendReplies: async () => {},
  };
  const world: AgentsWorld = {
    fake, state, engine, client, reader, source, assessor, host, current, woken,
    allowed: (trigger) => settingsPolicy(current.settings, githubScope(current.settings)).allowedSender(trigger.actor),
    orchestrator: () => orchestratorTools(host),
    worker: (ticketId) => workerTools(host, ticketId),
    receive(trigger) {
      engine.receive(trigger);
      engine.evaluateDue();
    },
    async accept(trigger, name = "fix-typo") {
      world.receive(trigger);
      const answer = await call(world.orchestrator(), "orchestrator_route", {
        decisions: [{ kind: "accept", trigger_id: trigger.id, title: "Fix typo", worktree_name: name, acknowledgement: "Fixing the README typo." }],
      });
      const ticketId = answer.results[0]?.ticket?.ticket_id;
      if (!ticketId) throw new Error(`Not accepted: ${JSON.stringify(answer)}`);
      return ticketId as string;
    },
    start(ticketId) {
      const ticket = state.tickets.get(ticketId)!;
      engine.assignmentStarted(ticketId, ticket.assignments.at(-1)!.id);
    },
  };
  return world;
}
