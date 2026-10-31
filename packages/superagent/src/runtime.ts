/**
 * Composition root: wires the store, engine, GitHub source and channel, orchestrator and worker drivers, and the loops that
 * keep them going. The host supplies the agent runner, secrets and fetch; everything else lives here.
 */
import { join } from "node:path";
import { Assessor } from "./agents/assessment.js";
import { blockedCommand } from "./agents/commands.js";
import { ExecutorDriver, buildExecution } from "./agents/executor.js";
import { ORCHESTRATOR_SESSION, OrchestratorDriver } from "./agents/orchestrator.js";
import { composePrompt } from "./agents/prompts.js";
import type { ResourceHost } from "./agents/resources.js";
import { orchestratorTools, workerTools, type ToolsHost } from "./agents/tools.js";
import { UserError } from "./core/errors.js";
import { Engine } from "./core/engine.js";
import { ticketStage } from "./core/model.js";
import type { State } from "./core/state.js";
import type { DomainEvent, Ticket, Trigger } from "./core/types.js";
import { sendReceipt } from "./github/channel.js";
import { GithubClient, GithubError, authenticatedAccount, canPush, type FetchLike, type GithubAccount } from "./github/client.js";
import { GithubReader } from "./github/read.js";
import { GithubSource, githubScope } from "./github/source.js";
import { policyEffects, policyVersion, settingsPolicy, type Policy } from "./policy.js";
import type { AgentRunner, Logger, Secrets, Workspace } from "./ports.js";
import { JsonStore } from "./store.js";
import { parseSettings, setupGaps, type Settings } from "./settings.js";
import { buildView, type SuperagentStatus, type SuperagentView } from "./view.js";
import { GitWorkspace } from "./workspace.js";

const TICK_MS = 1000;
const ACCOUNT_RETRY_MS = 60_000;
const POLL_FAILURE_MS = 60_000;
const PRUNE_MS = 60 * 60_000;

export interface SuperagentOptions {
  /** Where settings, state, managed clones and ticket worktrees live. */
  dataDir: string;
  runner: AgentRunner;
  secrets: Secrets;
  logger: Logger;
  fetch: FetchLike;
  /** Defaults to real git worktrees under `dataDir`. */
  workspace?: Workspace;
  now?: () => Date;
  /** Loop period in milliseconds; tests shorten it. */
  tickMs?: number;
  /** Debounce for writing state, in milliseconds. */
  saveDebounceMs?: number;
}

interface Components {
  state: State;
  engine: Engine;
  client: GithubClient;
  reader: GithubReader;
  source: GithubSource;
  orchestrator: OrchestratorDriver;
  executor: ExecutorDriver;
}

export class Superagent {
  private readonly store: JsonStore;
  private readonly workspace: Workspace;
  private parts!: Components;
  private account: GithubAccount | undefined;
  private accountError: string | undefined;
  private accountCheckedAt = 0;
  private poll: { at?: string; error?: string; nextAt: number; running?: Promise<void> | undefined } = { nextAt: 0 };
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastPrune = 0;
  private started = false;
  private waking = false;
  private readonly listeners = new Set<() => void>();
  private abort = new AbortController();

  constructor(private readonly options: SuperagentOptions) {
    this.store = new JsonStore(options.dataDir, { logger: options.logger, ...(options.saveDebounceMs !== undefined ? { debounceMs: options.saveDebounceMs } : {}) });
    this.workspace = options.workspace ?? new GitWorkspace({ root: join(options.dataDir, "repos"), ticketsRoot: () => this.ticketsRoot(), logger: options.logger });
    this.assemble();
  }

  // ---- composition ------------------------------------------------------------------------------------------------

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private settings(): Settings {
    return this.store.settings;
  }

  /** The root of ticket worktrees: the configured directory, else `<dataDir>/work`. */
  private ticketsRoot(): string {
    return this.store.settings.executor.directory || join(this.options.dataDir, "work");
  }

  private policy(): Policy {
    const settings = this.settings();
    return settingsPolicy(settings, githubScope(settings));
  }

  private agentLogin(): string {
    return this.account?.login ?? "";
  }

  /** (Re)builds everything that holds the loaded state; a reset calls it again after clearing the store. */
  private assemble(): void {
    const { state } = this.store.load();
    this.store.autosave();
    const settings = () => this.settings();
    const engine = new Engine(state, {
      policy: () => this.policy(),
      now: () => this.now(),
      execution: (request) => buildExecution(this.ticketsRoot())(request),
      emit: (event) => this.emit(event),
    });
    const client = new GithubClient({ fetch: this.options.fetch, token: () => this.options.secrets.githubToken(), now: () => this.now().getTime() });
    const reader = new GithubReader({ client, repository: () => settings().github.repository });
    const source = new GithubSource({ client, engine, state, settings, agentLogin: () => this.account?.login, now: () => this.now() });
    const assessor = new Assessor({ engine, state, reader });
    const resources: ResourceHost = { state, engine, settings, github: reader };
    const host: ToolsHost = {
      engine, state, settings, resources, assessor, client, agent: () => this.agentLogin(), logger: this.options.logger,
      wake: () => this.wake(),
      sendReplies: () => this.sendReplies(),
    };
    const allowed = (trigger: Trigger) => this.policy().allowedSender(trigger.actor);
    const agent = () => ({ login: this.agentLogin(), email: this.account?.email ?? "" });
    const orchestrator = new OrchestratorDriver({
      engine, state, runner: this.options.runner, tools: () => orchestratorTools(host), settings, allowed, logger: this.options.logger,
      prompt: () => composePrompt("orchestrator", { settings: settings(), agent: agent() }), now: () => this.now().getTime(),
    });
    const executor = new ExecutorDriver({
      engine, state, runner: this.options.runner, workspace: this.workspace, tools: (ticketId) => workerTools(host, ticketId), settings,
      token: () => this.options.secrets.githubToken(), agent, allowed, logger: this.options.logger, now: () => this.now().getTime(), idle: () => this.wake(),
    });
    this.parts = { state, engine, client, reader, source, orchestrator, executor };
    state.onChange(() => this.changed());
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.abort = new AbortController();
    // A stop disposed the store's autosave; starting again must save again.
    this.store.autosave();
    const { engine, orchestrator, executor, state } = this.parts;
    orchestrator.recover();
    executor.recover();
    state.prune(this.now());
    engine.policyVersionApplied(policyVersion(this.settings()));
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abort.abort();
    // Everything in flight finishes (aborted) before the store stops saving, so nothing it records is lost.
    await Promise.all([this.parts.orchestrator.stop(), this.parts.executor.stop(), this.poll.running, this.tickRun, this.sendRun]);
    this.store.dispose();
  }

  /** Asks for a loop turn now rather than at the next period. */
  wake(): void {
    if (!this.started || this.waking) return;
    this.waking = true;
    queueMicrotask(() => {
      this.waking = false;
      void this.tick();
    });
  }

  private tickRun: Promise<void> | undefined;
  private tick(): Promise<void> {
    if (this.tickRun || !this.started) return Promise.resolve();
    const run = this.runTick().finally(() => {
      this.tickRun = undefined;
    });
    this.tickRun = run;
    return run;
  }

  private async runTick(): Promise<void> {
    try {
      const { engine, orchestrator, executor } = this.parts;
      const settings = this.settings();
      if (settings.enabled) {
        void this.ensureAccount();
        this.startPoll();
        engine.evaluateDue();
        orchestrator.tick();
        executor.tick();
        await this.sendReplies();
        if (this.now().getTime() - this.lastPrune > PRUNE_MS) {
          this.lastPrune = this.now().getTime();
          this.parts.state.prune(this.now());
        }
      } else {
        // While off nothing new starts, and what was running is stopped.
        if (executor.running > 0) await executor.stop();
        if (orchestrator.running) await orchestrator.stop();
      }
    } catch (error) {
      this.options.logger.warn(`superagent loop error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- account and polling ----------------------------------------------------------------------------------------

  private async ensureAccount(): Promise<void> {
    if (this.account || !this.options.secrets.githubToken() || this.now().getTime() - this.accountCheckedAt < ACCOUNT_RETRY_MS) return;
    await this.refreshAccount();
  }

  /** Looks up the account the stored token belongs to; the host calls it after the token changed. */
  async refreshAccount(): Promise<{ login: string } | null> {
    this.accountCheckedAt = this.now().getTime();
    this.account = undefined;
    this.accountError = undefined;
    if (!this.options.secrets.githubToken()) {
      this.changed();
      return null;
    }
    try {
      this.account = await authenticatedAccount(this.parts.client, this.abort.signal);
    } catch (error) {
      this.accountError = error instanceof GithubError && error.status === 401 ? "GitHub rejected the token" : error instanceof Error ? error.message : String(error);
    }
    this.poll.nextAt = 0;
    this.changed();
    this.wake();
    return this.account ? { login: this.account.login } : null;
  }

  private startPoll(): void {
    if (this.poll.running || this.now().getTime() < this.poll.nextAt || !this.account || !this.settings().github.repository || !this.options.secrets.githubToken()) return;
    this.poll.running = this.pollOnce().finally(() => {
      this.poll.running = undefined;
    });
  }

  private async pollOnce(): Promise<void> {
    try {
      const report = await this.parts.source.poll(this.abort.signal);
      this.poll.at = report.at;
      this.poll.error = report.failures.length > 0 ? report.failures[0] : undefined;
      this.poll.nextAt = this.now().getTime() + report.intervalSeconds * 1000;
      if (report.failures.length > 0) this.options.logger.warn(`superagent poll: ${report.failures.join("; ")}`);
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.poll.error = error instanceof Error ? error.message : String(error);
      this.poll.nextAt = this.now().getTime() + POLL_FAILURE_MS;
      this.options.logger.warn(`superagent poll failed: ${this.poll.error}`);
    }
    this.parts.engine.evaluateDue();
    this.changed();
    this.wake();
  }

  // ---- outbound replies --------------------------------------------------------------------------------------------

  /** Delivers every receipt that is due; one at a time, so a second caller waits for the first. */
  sendReplies(): Promise<void> {
    if (!this.sendRun) {
      this.sendRun = this.deliverReplies().finally(() => {
        this.sendRun = undefined;
      });
    }
    return this.sendRun;
  }

  private sendRun: Promise<void> | undefined;

  private async deliverReplies(): Promise<void> {
    const { engine, client } = this.parts;
    const settings = this.settings();
    if (settings.paused || !settings.github.repository || !this.account) return;
    for (const receipt of engine.receiptsPending()) {
      try {
        const result = await sendReceipt(client, { repository: settings.github.repository, agent: this.account.login }, receipt, this.abort.signal);
        if (result === "sent") engine.receiptSent(receipt.id);
        else engine.receiptDropped(receipt.id, "channelGone");
      } catch (error) {
        if (this.abort.signal.aborted) return;
        engine.receiptFailed(receipt.id, error instanceof Error ? error.message : String(error));
      }
    }
  }

  // ---- settings and commands ---------------------------------------------------------------------------------------

  get currentSettings(): { settings: Settings; revision: number } {
    return { settings: this.settings(), revision: this.store.settingsRevision };
  }

  /**
   * Saves settings and tells each open ticket how the change bears on it.
   * @throws UserError when the settings are invalid, were changed meanwhile, or move the repository while tickets are open.
   */
  saveSettings(raw: unknown, baseRevision: number): { settings: Settings; revision: number } {
    const { state, engine } = this.parts;
    const before = this.settings();
    const openTickets = [...state.tickets.values()].filter((ticket) => !ticket.ended);
    // The repository is checked before anything is written: tickets belong to the repository they were accepted on.
    if (parseSettings(raw).github.repository.toLowerCase() !== before.github.repository.toLowerCase() && openTickets.length > 0) {
      throw new UserError("invalid", "Stop or finish the open tickets before changing the watched repository");
    }
    const result = this.store.saveSettings(raw, baseRevision);
    if (result.settings.github.repository.toLowerCase() !== before.github.repository.toLowerCase()) {
      state.cursors = {};
      state.touch();
    }
    const effects = policyEffects(openTickets, result.previous, result.settings, githubScope);
    engine.applyPolicyEffects(policyVersion(result.previous), policyVersion(result.settings), effects);
    engine.policyVersionApplied(policyVersion(result.settings));
    this.poll.nextAt = 0;
    this.changed();
    this.wake();
    return { settings: result.settings, revision: result.revision };
  }

  /** Checks the stored token against the repository: who it is, and whether it can push. */
  async verifyAccount(): Promise<{ login: string; canPush: boolean; repository: string }> {
    const account = await this.refreshAccount();
    if (!account) throw new UserError("setup", this.accountError ?? "No GitHub token is stored");
    const repository = this.settings().github.repository;
    if (!repository) throw new UserError("setup", "Set the repository to watch first");
    try {
      return { login: account.login, canPush: await canPush(this.parts.client, repository, this.abort.signal), repository };
    } catch (error) {
      if (error instanceof GithubError && error.status === 404) throw new UserError("setup", `${account.login} cannot see ${repository}`);
      throw error;
    }
  }

  private ticket(id: string): Ticket {
    const ticket = this.parts.state.tickets.get(id);
    if (!ticket) throw new UserError("unknownTicket");
    return ticket;
  }

  stopTicket(id: string): void {
    this.parts.engine.stopTicket(this.ticket(id).id);
    this.wake();
  }

  /** @throws UserError when the ticket is not failed, blocked or undelivered. */
  retryTicket(id: string): void {
    const ticket = this.ticket(id);
    if (ticket.ended) throw new UserError("ticketEnded");
    const stage = ticketStage(ticket);
    if (stage !== "failed" && stage !== "blocked" && stage !== "delivery") throw new UserError("replyRefused", `Ticket ${id} is ${stage}; only a failed or blocked ticket is retried`);
    this.parts.engine.retryTicket(id);
    this.wake();
  }

  /** Sends a trigger a decision gave up on (a timeout, say) to assessment again. */
  requeue(triggerId: string): boolean {
    const queued = this.parts.engine.reevaluate(triggerId);
    this.wake();
    return queued;
  }

  /** Deletes everything Superagent stored, ends its runs and starts again from defaults. The GitHub token is the host's to clear. */
  async reset(): Promise<void> {
    const wasStarted = this.started;
    await this.stop();
    const { state } = this.parts;
    for (const ticket of state.tickets.values()) await this.options.runner.forget(ticket.id);
    await this.options.runner.forget(ORCHESTRATOR_SESSION);
    this.store.reset();
    this.account = undefined;
    this.poll = { nextAt: 0 };
    this.assemble();
    this.changed();
    if (wasStarted) await this.start();
  }

  /** The command a worker's shell must refuse, or `undefined`; the host's bash tool asks it before running a command. */
  blockedCommand(line: string): string | undefined {
    return blockedCommand(line, this.settings().executor.blockedCommands);
  }

  // ---- view --------------------------------------------------------------------------------------------------------

  private status(): SuperagentStatus {
    const settings = this.settings();
    const token = this.options.secrets.githubToken();
    const gaps = setupGaps(settings, { hasToken: !!token, ...(this.account ? { login: this.account.login } : {}) });
    if (token && !this.account && this.accountError) gaps.unshift(`The GitHub token does not work: ${this.accountError}`);
    return {
      enabled: settings.enabled,
      paused: settings.paused,
      mode: settings.eval.mode,
      ready: gaps.length === 0 && this.account !== undefined,
      gaps,
      repository: settings.github.repository,
      account: this.account ? { login: this.account.login } : null,
      accountError: this.accountError ?? null,
      poll: { at: this.poll.at ?? null, error: this.poll.error ?? null },
      orchestrator: { running: this.parts.orchestrator.running },
      workers: { running: this.parts.executor.running, max: settings.executor.maxWorkers },
      storeError: this.store.lastError?.message ?? null,
    };
  }

  view(): SuperagentView {
    return buildView({
      state: this.parts.state, settings: this.settings(), settingsRevision: this.store.settingsRevision, candidates: this.parts.engine.candidates(), status: this.status(),
    });
  }

  /** Calls `listener` after anything the view shows may have changed; returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private emit(_event: DomainEvent): void {
    this.changed();
  }
}
