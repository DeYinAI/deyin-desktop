import { execFile } from "node:child_process";
import { join } from "node:path";
import type { SuperagentReply, SuperagentVerification } from "@deyin/contract";
import { Superagent, UserError, type FetchLike, type Logger, type SuperagentView } from "@deyin/superagent";
import { AgentCoreRunner, type RunnerDeps } from "./runner.js";
import { TokenStore, type Cipher } from "./token-store.js";

/** What the worker's shell needs on the machine. */
const REQUIRED_PROGRAMS = [
  { command: "git", gap: "Install git: workers use it for their worktrees" },
  { command: "gh", gap: "Install the GitHub CLI (gh): workers open and update pull requests with it" },
] as const;

const PUSH_DEBOUNCE_MS = 250;

export interface SuperagentServiceOptions {
  /** Everything Superagent keeps lives under here: settings, state, conversations, clones, worktrees, and the token. */
  dir: string;
  cipher: Cipher;
  /** What the agent runner needs from the app. */
  runner: Omit<RunnerDeps, "sessionsDir" | "logger" | "homeDir">;
  /** Sends the current view to the windows; called a moment after the view changed. */
  broadcast(view: SuperagentView): void;
  fetch: FetchLike;
  logger: Logger;
  /** Whether a program runs on this machine; replaceable for tests. */
  probe?: (command: string) => Promise<boolean>;
  tickMs?: number;
  saveDebounceMs?: number;
}

const defaultProbe = (command: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: 5000, windowsHide: true }, (error) => resolve(!error));
  });

/** Superagent inside the desktop app: the runtime, its agent runner and token, and the replies the window's calls expect. */
export class SuperagentService {
  private readonly tokens: TokenStore;
  private readonly runner: AgentCoreRunner;
  private readonly runtime: Superagent;
  private readonly probe: (command: string) => Promise<boolean>;
  private missing: string[] = [];
  private pushTimer: NodeJS.Timeout | undefined;
  private exclusive: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: SuperagentServiceOptions) {
    this.probe = options.probe ?? defaultProbe;
    this.tokens = new TokenStore(join(options.dir, "token.json"), options.cipher);
    this.runner = new AgentCoreRunner({ ...options.runner, sessionsDir: join(options.dir, "sessions"), homeDir: options.dir, logger: options.logger });
    this.runtime = new Superagent({
      dataDir: options.dir,
      runner: this.runner,
      secrets: { githubToken: () => this.tokens.get() },
      logger: options.logger,
      fetch: options.fetch,
      ...(options.tickMs !== undefined ? { tickMs: options.tickMs } : {}),
      ...(options.saveDebounceMs !== undefined ? { saveDebounceMs: options.saveDebounceMs } : {}),
    });
    this.runtime.onChange(() => this.queuePush());
  }

  async start(): Promise<void> {
    await this.checkPrograms();
    await this.runtime.start();
    // Even while switched off, the window should say whose account the stored token is.
    if (this.tokens.get()) void this.runtime.refreshAccount();
  }

  /** Stops every run and writes everything down; the app calls it as it quits. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = undefined;
    await this.runtime.stop();
    this.runner.flush();
  }

  private async checkPrograms(): Promise<void> {
    const found = await Promise.all(REQUIRED_PROGRAMS.map((program) => this.probe(program.command)));
    this.missing = REQUIRED_PROGRAMS.filter((_, index) => !found[index]).map((program) => program.gap);
  }

  private queuePush(): void {
    if (this.disposed || this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      if (!this.disposed) this.options.broadcast(this.view());
    }, PUSH_DEBOUNCE_MS);
    this.pushTimer.unref?.();
  }

  /** The runtime's view, with what this machine lacks added to the setup gaps. */
  view(): SuperagentView {
    const view = this.runtime.view();
    if (this.missing.length === 0) return view;
    return { ...view, status: { ...view.status, ready: false, gaps: [...view.status.gaps, ...this.missing] } };
  }

  private async reply<T>(run: () => Promise<T> | T): Promise<SuperagentReply<T>> {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof UserError)) this.options.logger.warn(`superagent call failed: ${message}`);
      return { ok: false, error: message };
    }
  }

  /** Runs `task` after every earlier exclusive task; token changes and resets must not overlap. */
  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.exclusive.then(task, task);
    this.exclusive = next.catch(() => undefined);
    return next;
  }

  current(): SuperagentReply {
    return { ok: true, value: this.view() };
  }

  saveSettings(raw: unknown, baseRevision: number): Promise<SuperagentReply> {
    return this.reply(() => {
      this.runtime.saveSettings(raw, baseRevision);
      return this.view();
    });
  }

  /** Stores the agent account's token if GitHub accepts it; otherwise keeps the one in place and says why. */
  setToken(token: string): Promise<SuperagentReply> {
    return this.serialized(() =>
      this.reply(async () => {
        const previous = this.tokens.get();
        try {
          this.tokens.set(token);
        } catch (error) {
          throw new UserError("invalid", error instanceof Error ? error.message : String(error));
        }
        if (await this.runtime.refreshAccount()) return this.view();
        const reason = this.view().status.accountError ?? "GitHub did not accept the token";
        if (previous) this.tokens.set(previous);
        else this.tokens.clear();
        await this.runtime.refreshAccount();
        throw new UserError("invalid", reason);
      }),
    );
  }

  /** Forgets the token and stops the agent's runs, so nothing keeps working under the account. */
  clearToken(): Promise<SuperagentReply> {
    return this.serialized(() =>
      this.reply(async () => {
        await this.runtime.stop();
        this.tokens.clear();
        await this.runtime.refreshAccount();
        await this.runtime.start();
        return this.view();
      }),
    );
  }

  verify(): Promise<SuperagentReply<SuperagentVerification>> {
    return this.reply(async () => {
      await this.checkPrograms();
      return this.runtime.verifyAccount();
    });
  }

  stopTicket(ticketId: string): Promise<SuperagentReply> {
    return this.reply(() => {
      this.runtime.stopTicket(ticketId);
      return this.view();
    });
  }

  retryTicket(ticketId: string): Promise<SuperagentReply> {
    return this.reply(() => {
      this.runtime.retryTicket(ticketId);
      return this.view();
    });
  }

  requeue(triggerId: string): Promise<SuperagentReply> {
    return this.reply(() => {
      if (!this.runtime.requeue(triggerId)) throw new UserError("invalid", "That message cannot be sent to assessment again");
      return this.view();
    });
  }

  reset(): Promise<SuperagentReply> {
    return this.serialized(() =>
      this.reply(async () => {
        await this.runtime.reset();
        return this.view();
      }),
    );
  }
}
