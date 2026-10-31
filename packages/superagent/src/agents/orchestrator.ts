/**
 * Drives the orchestrator agent: one serialized run at a time, fed with the candidates and notices the engine holds for it.
 * State is durable (a candidate's `delivered` mark, a notice's `delivered` flag), so a crashed or failed run just delivers again.
 */
import type { Engine } from "../core/engine.js";
import type { State } from "../core/state.js";
import type { Trigger } from "../core/types.js";
import { AgentRunError, type AgentRunner, type AgentTool, type Logger } from "../ports.js";
import type { Settings } from "../settings.js";
import { candidateCard, followUpNotice } from "./cards.js";

export const ORCHESTRATOR_SESSION = "orchestrator";
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const SHUTDOWN = "shutdown";

export interface OrchestratorDeps {
  engine: Engine;
  state: State;
  runner: AgentRunner;
  tools(): AgentTool[];
  prompt(): string;
  settings(): Settings;
  /** Whether the sender of a trigger may start work, as the cards show it to the model. */
  allowed(trigger: Trigger): boolean;
  logger: Logger;
  now?: () => number;
}

export class OrchestratorDriver {
  private active: { controller: AbortController; done: Promise<void> } | undefined;
  private failures = 0;
  private retryAt = 0;

  constructor(private readonly deps: OrchestratorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private runnable(): boolean {
    const settings = this.deps.settings();
    return settings.enabled && !settings.paused;
  }

  /** Forgets deliveries a previous process made: its run is gone, so what it held is delivered again. */
  recover(): void {
    for (const candidate of this.deps.engine.candidates()) if (candidate.delivered) this.deps.engine.candidateUndelivered(candidate.evalId);
  }

  /** True while the engine holds something the orchestrator has not been given. */
  hasWork(): boolean {
    const { engine } = this.deps;
    return engine.pendingNotices().length > 0 || engine.candidates().some((candidate) => !candidate.delivered);
  }

  get running(): boolean {
    return this.active !== undefined;
  }

  /** Starts a run when there is work and none is active; never throws. */
  tick(): void {
    if (this.active || !this.runnable() || this.now() < this.retryAt || !this.hasWork()) return;
    const controller = new AbortController();
    const done = this.run(controller.signal).catch((error: unknown) => this.deps.logger.warn(`superagent orchestrator stopped unexpectedly: ${String(error)}`)).finally(() => {
      this.active = undefined;
    });
    this.active = { controller, done };
  }

  /** Resolves when the active run, if any, has finished. */
  async settle(): Promise<void> {
    while (this.active) await this.active.done;
  }

  async stop(): Promise<void> {
    this.active?.controller.abort(SHUTDOWN);
    await this.settle();
  }

  private async run(signal: AbortSignal): Promise<void> {
    const { engine, state, runner } = this.deps;
    const settings = this.deps.settings();
    const sentEvals = new Set<string>();
    const sentNotices = new Set<string>();
    const context = { state, allowed: this.deps.allowed };
    const collect = (): string[] => {
      const messages: string[] = [];
      if (!this.runnable()) return messages;
      for (const candidate of engine.candidates()) {
        if (candidate.delivered || sentEvals.has(candidate.evalId)) continue;
        sentEvals.add(candidate.evalId);
        engine.candidateDelivered(candidate.evalId);
        messages.push(JSON.stringify(candidateCard(context, candidate, this.deps.settings())));
      }
      for (const notice of engine.pendingNotices()) {
        if (sentNotices.has(notice.id)) continue;
        sentNotices.add(notice.id);
        const text = notice.kind === "follow_up" ? (notice.triggerId ? followUpNotice(state, notice.triggerId) : undefined) : notice.text;
        if (text) messages.push(text);
        // Nothing to tell any more (the ticket ended before the orchestrator got to it): done, not waiting for ever.
        else engine.noticesDelivered([notice.id]);
      }
      return messages;
    };
    const first = collect();
    if (first.length === 0) return;
    try {
      await runner.run({
        role: "orchestrator", sessionId: ORCHESTRATOR_SESSION, systemPrompt: this.deps.prompt(), tools: this.deps.tools(), env: {}, blockedCommands: [],
        model: settings.eval.model, messages: first, drain: collect, signal,
      });
      // A runner that stops for the abort signal may return instead of throwing; the run was cut short either way.
      if (signal.aborted) throw new Error("The run was aborted");
      engine.noticesDelivered([...sentNotices]);
      this.failures = 0;
      this.retryAt = 0;
    } catch (error) {
      for (const evalId of sentEvals) engine.candidateUndelivered(evalId);
      if (signal.aborted && signal.reason === SHUTDOWN) return;
      this.failures += 1;
      const retryable = !(error instanceof AgentRunError) || error.retryable;
      this.retryAt = this.now() + (retryable ? Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (this.failures - 1)) : BACKOFF_MAX_MS);
      this.deps.logger.warn(`superagent orchestrator run failed (attempt ${this.failures}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
