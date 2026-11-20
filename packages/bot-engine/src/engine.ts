import { execFile, type spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  BotError,
  ENGINE_API_VERSION,
  RUNTIME_LIMITS,
  clipOutput,
  isValidRoutineId,
  isValidRuntimeBotId,
  listBotFiles,
  parseEngineRoutine,
  runFailureMessage,
  readBotFile,
  removeBotFile,
  streamBotCommand,
  writeBotFile,
  type EngineExecLine,
  type EngineRoutine,
  type EngineRoutineView,
  type EngineRunEnd,
  type EngineRunRecord,
  type EngineRunStatus,
  type EngineStatus,
  type RuntimeExecRequest,
  type RuntimeFileEntry,
  type RuntimeRunReason,
  type RuntimeRunRequest,
} from "@deyin/host-core";
import { runAgent, type DeyinCommand } from "./agent-run.js";
import { checkSchedule, type JobFactory } from "./cron.js";
import { RoutineScheduler, type RoutineTrigger } from "./scheduler.js";
import type { EngineStore } from "./store.js";

export interface BotEngineOptions {
  store: EngineStore;
  deyin: DeyinCommand;
  version: string;
  jobFactory?: JobFactory;
  spawnImpl?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** How long a look at the agent (its version, whether it is signed in) is trusted. */
  probeTtlMs?: number;
  /** Agent runs at once, across every Bot. */
  maxConcurrentRuns?: number;
}

const PROBE_TIMEOUT_MS = 15_000;

function things(count: number): string {
  return count === 1 ? "1 thing" : `${count} things`;
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function execFileText(command: string, args: string[], env: NodeJS.ProcessEnv | undefined): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: PROBE_TIMEOUT_MS, env: env ?? process.env, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout) });
      const code = typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}

const STATUS_BY_REASON: Record<RuntimeRunReason, EngineRunStatus> = {
  completed: "completed",
  "max-steps": "completed",
  aborted: "aborted",
  timeout: "timeout",
  failed: "failed",
};

/**
 * The engine itself, apart from its HTTP skin: a Bot's files, commands and agent runs, and the routines that run
 * on their own. Everything it does for a Bot happens in that Bot's folder, and at most `maxConcurrentRuns` agent
 * runs go at once, so a server is never asked for more than a small machine can give.
 */
export class BotEngine {
  readonly startedAt: number;
  private readonly scheduler: RoutineScheduler;
  private readonly now: () => number;
  private readonly controllers = new Set<AbortController>();
  private readonly runningByBot = new Map<string, number>();
  private readonly runningRoutines = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly maxRuns: number;
  private runs = 0;
  private probe: { at: number; value: EngineStatus["agent"] } | undefined;
  private stopped = false;

  constructor(private readonly options: BotEngineOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.maxRuns = options.maxConcurrentRuns ?? RUNTIME_LIMITS.concurrentRuns;
    this.scheduler = new RoutineScheduler({
      store: options.store,
      now: this.now,
      ...(options.jobFactory ? { jobFactory: options.jobFactory } : {}),
      fire: (botId, routine, trigger) => {
        // A schedule fires with nobody listening; a refusal is recorded on the routine, not thrown.
        void this.startRoutineRun(botId, routine, trigger).catch(() => undefined);
      },
    });
  }

  /** Get going: mark runs a crash left half-done, and start every routine's schedule. */
  start(): void {
    this.options.store.ensure();
    for (const botId of this.options.store.botIds()) {
      for (const routine of this.options.store.routines(botId)) {
        for (const run of this.options.store.runs(botId, routine.id)) {
          if (run.status !== "running") continue;
          this.options.store.recordRun(botId, {
            ...run,
            status: "failed",
            finishedAt: this.now(),
            reason: "The engine stopped before this run finished.",
          });
        }
      }
    }
    this.scheduler.syncAll();
  }

  /** Stop every schedule and every run in flight, and wait for them to wind up. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.scheduler.stop();
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.pending]);
  }

  /** Resolves when every run that has started has been recorded. For tests, and for a clean shutdown. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /* Status ---------------------------------------------------------------------- */

  async status(): Promise<EngineStatus> {
    const store = this.options.store;
    return {
      apiVersion: ENGINE_API_VERSION,
      version: this.options.version,
      startedAt: this.startedAt,
      agent: await this.agent(),
      bots: store.botIds().map((botId) => ({
        botId,
        routines: store.routines(botId).length,
        running: this.runningByBot.get(botId) ?? 0,
      })),
      runningNow: this.runs,
    };
  }

  private async agent(): Promise<EngineStatus["agent"]> {
    const ttl = this.options.probeTtlMs ?? 60_000;
    if (this.probe && this.now() - this.probe.at < ttl) return this.probe.value;
    const { deyin, env } = this.options;
    const version = await execFileText(deyin.command, [...deyin.args, "--version"], env);
    let value: EngineStatus["agent"];
    if (version.code !== 0) {
      value = { found: false, signedIn: false };
    } else {
      const who = await execFileText(deyin.command, [...deyin.args, "whoami"], env);
      const found = /\d+\.\d+\.\d+\S*/.exec(version.stdout)?.[0];
      // 2 is "not signed in"; 1 is signed in but the profile could not be fetched, which is still signed in.
      value = { found: true, ...(found ? { version: found } : {}), signedIn: who.code === 0 || who.code === 1 };
    }
    this.probe = { at: this.now(), value };
    return value;
  }

  /* Gate ------------------------------------------------------------------------ */

  /** Take one of the places for an agent run, or null when they are all taken. Release it when the run ends. */
  private acquire(botId: string): (() => void) | null {
    if (this.stopped || this.runs >= this.maxRuns) return null;
    this.runs += 1;
    this.runningByBot.set(botId, (this.runningByBot.get(botId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.runs -= 1;
      const left = (this.runningByBot.get(botId) ?? 1) - 1;
      if (left <= 0) this.runningByBot.delete(botId);
      else this.runningByBot.set(botId, left);
    };
  }

  /* Files and commands ---------------------------------------------------------- */

  private root(botId: string): string {
    this.options.store.ensureBot(botId);
    return this.options.store.filesDir(botId);
  }

  listFiles(botId: string, path: string): Promise<RuntimeFileEntry[]> {
    return listBotFiles(this.root(botId), path);
  }

  readFile(botId: string, path: string): Promise<string> {
    return readBotFile(this.root(botId), path);
  }

  writeFile(botId: string, path: string, content: string): Promise<void> {
    return writeBotFile(this.root(botId), path, content);
  }

  removeFile(botId: string, path: string, recursive: boolean): Promise<void> {
    return removeBotFile(this.root(botId), path, { recursive });
  }

  exec(botId: string, request: RuntimeExecRequest, emit: (line: EngineExecLine) => void, signal: AbortSignal): Promise<void> {
    return streamBotCommand(this.root(botId), request, emit, { signal, ...(this.options.env ? { env: this.options.env } : {}) });
  }

  /* Agent runs ------------------------------------------------------------------ */

  /**
   * Run the agent as a Bot for a person who is waiting on the answer (the desktop's chat). Every line it prints is
   * handed on as it comes. Refuses at once when the engine is already running as many things as it will.
   */
  async runChat(botId: string, request: RuntimeRunRequest, onLine: (line: string) => void, signal: AbortSignal): Promise<EngineRunEnd> {
    const filesDir = this.root(botId);
    const release = this.acquire(botId);
    if (!release) throw new BotError("limit", `This server is already running ${things(this.maxRuns)} for your Bots. Try again in a moment.`);
    const controller = new AbortController();
    this.controllers.add(controller);
    const onAbort = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      const outcome = await runAgent({
        deyin: this.options.deyin,
        filesDir,
        request,
        onLine,
        signal: controller.signal,
        ...(this.options.env ? { env: this.options.env } : {}),
        ...(this.options.spawnImpl ? { spawnImpl: this.options.spawnImpl } : {}),
      });
      return outcome.end;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.controllers.delete(controller);
      release();
    }
  }

  /* Routines -------------------------------------------------------------------- */

  routineViews(botId: string): EngineRoutineView[] {
    const store = this.options.store;
    return store.routines(botId).map((routine) => {
      const lastRun = store.runs(botId, routine.id)[0];
      const nextRunAt = this.scheduler.nextRunAt(botId, routine.id);
      return { ...routine, ...(nextRunAt !== undefined ? { nextRunAt } : {}), ...(lastRun ? { lastRun } : {}) };
    });
  }

  /** Keep a routine, and schedule it if it is on. The schedule is checked first, so a bad one is never stored. */
  saveRoutine(botId: string, routineId: string, body: unknown): EngineRoutineView {
    if (!isValidRuntimeBotId(botId)) throw new BotError("invalid", "That is not a Bot id.");
    const routine = parseEngineRoutine(body, routineId);
    const check = checkSchedule(routine.cron, this.now());
    if (!check.ok) throw new BotError("invalid", check.error);
    this.options.store.saveRoutine(botId, routine);
    this.scheduler.syncBot(botId);
    const view = this.routineViews(botId).find((r) => r.id === routineId);
    if (!view) throw new BotError("conflict", "The routine was not kept.");
    return view;
  }

  removeRoutine(botId: string, routineId: string): boolean {
    const removed = this.options.store.removeRoutine(botId, routineId);
    if (removed) this.scheduler.syncBot(botId);
    return removed;
  }

  routineRuns(botId: string, routineId: string): EngineRunRecord[] {
    if (!isValidRoutineId(routineId)) throw new BotError("invalid", "That is not a routine id.");
    return this.options.store.runs(botId, routineId);
  }

  removeBot(botId: string): boolean {
    this.scheduler.dropBot(botId);
    return this.options.store.removeBot(botId);
  }

  /** Run a routine now, by hand. Answers as soon as it has started; the record says how it goes. */
  runRoutineNow(botId: string, routineId: string): Promise<EngineRunRecord> {
    const routine = this.options.store.routines(botId).find((r) => r.id === routineId);
    if (!routine) return Promise.reject(new BotError("not_found", "There is no such routine on this server."));
    return this.startRoutineRun(botId, routine, "manual");
  }

  private async startRoutineRun(botId: string, routine: EngineRoutine, trigger: RoutineTrigger): Promise<EngineRunRecord> {
    const store = this.options.store;
    const key = `${botId}/${routine.id}`;
    const base = { id: newId("run"), routineId: routine.id, startedAt: this.now(), trigger } as const;
    const skip = (reason: string): EngineRunRecord => {
      const record: EngineRunRecord = { ...base, status: "skipped", finishedAt: this.now(), reason };
      store.recordRun(botId, record);
      return record;
    };

    if (this.runningRoutines.has(key)) {
      if (trigger === "manual") throw new BotError("conflict", "That routine is already running.");
      return skip("The previous run was still going.");
    }
    const release = this.acquire(botId);
    if (!release) {
      if (trigger === "manual") throw new BotError("limit", `This server is already running ${things(this.maxRuns)} for your Bots. Try again in a moment.`);
      return skip(`The server was already running ${things(this.maxRuns)}.`);
    }

    this.runningRoutines.add(key);
    const record: EngineRunRecord = { ...base, status: "running" };
    store.recordRun(botId, record);
    const controller = new AbortController();
    this.controllers.add(controller);
    const settled = (async (): Promise<void> => {
      let finished: EngineRunRecord;
      try {
        const outcome = await runAgent({
          deyin: this.options.deyin,
          filesDir: store.filesDir(botId),
          request: {
            prompt: routine.prompt,
            model: routine.model,
            mode: routine.mode,
            ...(routine.timeoutMs !== undefined ? { timeoutMs: routine.timeoutMs } : {}),
          },
          onLine: () => undefined,
          signal: controller.signal,
          ...(this.options.env ? { env: this.options.env } : {}),
          ...(this.options.spawnImpl ? { spawnImpl: this.options.spawnImpl } : {}),
        });
        const status = STATUS_BY_REASON[outcome.reason];
        const reason =
          outcome.reason === "completed"
            ? undefined
            : outcome.reason === "max-steps"
              ? "The Bot stopped at its step limit."
              : outcome.reason === "aborted"
                ? "The run was stopped."
                : runFailureMessage(outcome.end);
        finished = {
          ...record,
          status,
          finishedAt: this.now(),
          ...(reason ? { reason } : {}),
          ...(outcome.finalText ? { finalText: clipOutput(outcome.finalText, RUNTIME_LIMITS.finalText).text } : {}),
        };
      } catch (error) {
        finished = { ...record, status: "failed", finishedAt: this.now(), reason: error instanceof Error ? error.message : "The run failed." };
      } finally {
        this.controllers.delete(controller);
        this.runningRoutines.delete(key);
        release();
      }
      // A routine deleted while it ran leaves no record behind.
      if (store.routines(botId).some((r) => r.id === routine.id)) store.recordRun(botId, finished);
    })();
    const tracked: Promise<void> = settled
      // Recording a run can fail (a full disk); that must not take the whole engine down with an unhandled rejection.
      .catch((error: unknown) => console.error(`deyin bot-engine: could not record a run: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return record;
  }
}
