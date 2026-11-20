import {
  BotError,
  RUNTIME_LIMITS,
  buildBotPersona,
  isValidRoutineId,
  parseEngineRoutine,
  runModeForApproval,
  serverRuleConflict,
  type Automation,
  type AutomationRun,
  type BotPermissionSettings,
  type DeyinBot,
  type EngineRoutine,
  type EngineRoutineView,
  type EngineRunRecord,
  type EngineStatus,
  type BotSkillInput,
  type MemoryFact,
} from "@deyin/host-core";
import { buildServerPrompt } from "./server-prompt.js";

/** What the bridge needs of one server's engine. `EngineClient` is one. */
export interface EngineRoutinePort {
  status(signal?: AbortSignal): Promise<EngineStatus>;
  routines(botId: string, signal?: AbortSignal): Promise<EngineRoutineView[]>;
  saveRoutine(botId: string, routine: EngineRoutine, signal?: AbortSignal): Promise<EngineRoutineView>;
  removeRoutine(botId: string, routineId: string, signal?: AbortSignal): Promise<boolean>;
  routineRuns(botId: string, routineId: string, signal?: AbortSignal): Promise<EngineRunRecord[]>;
}

type Schedulable = Pick<Automation, "botId" | "trigger" | "payload">;

/**
 * Whether the engine on a Bot's server, not this app, is what starts a routine on its schedule. Decided from the
 * routine and the Bot alone, so it never waits on a network call and gives the same answer at start-up as later.
 * A routine this does not cover (one with no schedule, one at a set time, one built on a skill or subagent) stays
 * with the app, which runs it through the server when it is due.
 */
export function engineSchedules(automation: Schedulable, bot: Pick<DeyinBot, "harness" | "hostId"> | undefined, hasEngine: boolean): boolean {
  return (
    automation.botId !== undefined &&
    bot !== undefined &&
    bot.harness === "server" &&
    Boolean(bot.hostId) &&
    hasEngine &&
    automation.trigger.kind === "cron" &&
    automation.payload.kind === "prompt"
  );
}

export interface RoutineContext {
  bot: DeyinBot;
  permissions: BotPermissionSettings;
  /** The Bot's active facts; a server has no memory tools, so they are written into the prompt. */
  memory: readonly Pick<MemoryFact, "title" | "description" | "body">[];
  /** What the Bot has learned to do, written into the prompt the engine keeps. */
  skills?: readonly BotSkillInput[];
  /** The routine's model is served by the person's own endpoint, which a server is not signed in to. */
  customProvider: boolean;
}

export type EngineRoutineDecision = { ok: true; routine: EngineRoutine } | { ok: false; reason: string };

const NAME_LIMIT = 80;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The routine as the engine keeps it, or why it cannot be kept there. Words are for the person. */
export function engineRoutineFor(automation: Automation, context: RoutineContext): EngineRoutineDecision {
  const { bot } = context;
  if (automation.botId !== bot.id) return { ok: false, reason: "This routine belongs to another Bot." };
  if (automation.trigger.kind !== "cron") return { ok: false, reason: "Only a routine with a schedule runs on a server by itself." };
  if (automation.payload.kind !== "prompt") return { ok: false, reason: "A routine that uses a skill or a subagent runs only on this computer." };
  if (context.customProvider) return { ok: false, reason: "A routine on a server can only use models served by Openference." };
  if (!isValidRoutineId(automation.id)) return { ok: false, reason: "This routine's id cannot be kept on a server." };
  const conflict = serverRuleConflict(context.permissions, bot.autoReview.approvalMode);
  if (conflict) return { ok: false, reason: conflict };
  const name = oneLine(automation.name).slice(0, NAME_LIMIT) || "Routine";
  let prompt: string;
  try {
    prompt = buildServerPrompt({
      persona: buildBotPersona(bot, { memoryTools: false }),
      memory: context.memory,
      ...(context.skills ? { skills: context.skills } : {}),
      history: [],
      task: automation.payload.prompt,
      lead: `Your routine "${name}" is running on its schedule. Nobody is chatting with you now: do the task below, and finish with a short report of what you did.`,
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const minutes = automation.limits?.maxMinutes;
  const timeoutMs = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? Math.min(Math.round(minutes * 60_000), RUNTIME_LIMITS.runTimeoutMaxMs) : undefined;
  try {
    const routine = parseEngineRoutine(
      {
        name,
        cron: automation.trigger.expression,
        prompt,
        model: automation.model,
        mode: runModeForApproval(bot.autoReview.approvalMode),
        enabled: automation.enabled,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
      automation.id,
    );
    return { ok: true, routine };
  } catch (error) {
    if (error instanceof BotError) return { ok: false, reason: error.message };
    throw error;
  }
}

/* Runs ----------------------------------------------------------------------- */

export function mirroredRunId(record: Pick<EngineRunRecord, "id">): string {
  return `engine-${record.id}`;
}

/** A run the engine did, as a run in the app's history. The engine keeps no event log, so there are no events to show. */
export function mirroredRun(automationId: string, record: EngineRunRecord): AutomationRun {
  let status: AutomationRun["status"];
  let reason = record.reason;
  switch (record.status) {
    case "running":
      status = "running";
      break;
    case "completed":
      status = "completed";
      break;
    case "failed":
      status = "failed";
      break;
    case "aborted":
      status = "aborted";
      break;
    case "timeout":
      status = "failed";
      reason = reason ?? "The run took too long and was stopped.";
      break;
    case "skipped":
      status = "aborted";
      reason = `skipped: ${reason ?? "the previous run was still going"}`;
      break;
    default: {
      const unhandled: never = record.status;
      throw new Error(`Unhandled run status: ${String(unhandled)}`);
    }
  }
  return {
    id: mirroredRunId(record),
    automationId,
    status,
    startedAt: record.startedAt,
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(record.finalText !== undefined ? { finalText: record.finalText } : {}),
    events: [],
  };
}

/* Reconciling ------------------------------------------------------------------ */

function sameRoutine(a: EngineRoutine, b: EngineRoutine): boolean {
  return (
    a.name === b.name &&
    a.cron === b.cron &&
    a.prompt === b.prompt &&
    a.model === b.model &&
    a.mode === b.mode &&
    a.enabled === b.enabled &&
    (a.timeoutMs ?? null) === (b.timeoutMs ?? null)
  );
}

export interface ReconcileResult {
  saved: string[];
  removed: string[];
}

/**
 * Make a Bot's routines on the server exactly `desired`: save what is missing or different, remove what is not
 * wanted. What already matches is left alone, so a routine mid-run is not disturbed by an unrelated edit.
 */
export async function reconcileBotRoutines(port: EngineRoutinePort, botId: string, desired: readonly EngineRoutine[], signal?: AbortSignal): Promise<ReconcileResult> {
  const actual = new Map((await port.routines(botId, signal)).map((routine) => [routine.id, routine]));
  const result: ReconcileResult = { saved: [], removed: [] };
  for (const routine of desired) {
    const there = actual.get(routine.id);
    if (there && sameRoutine(there, routine)) continue;
    await port.saveRoutine(botId, routine, signal);
    result.saved.push(routine.id);
  }
  const wanted = new Set(desired.map((routine) => routine.id));
  for (const id of actual.keys()) {
    if (wanted.has(id)) continue;
    await port.removeRoutine(botId, id, signal);
    result.removed.push(id);
  }
  return result;
}

/* The bridge ------------------------------------------------------------------- */

export type RoutineServerState =
  /** The engine on this server has the routine and starts it on schedule. */
  | { state: "server"; hostId: string }
  /** The routine cannot be kept on the server as it is; `reason` says what to change. */
  | { state: "blocked"; hostId: string; reason: string }
  /** It should be on the server but the last attempt to put it there failed; the next sync tries again. */
  | { state: "waiting"; hostId: string; reason: string };

export interface RoutineBridgeDeps {
  automations: { list(): Automation[] };
  bots: { get(id: string): DeyinBot | undefined; list(options?: { includeArchived?: boolean }): DeyinBot[] };
  permissions: { get(): BotPermissionSettings };
  memoryOf(bot: DeyinBot): readonly Pick<MemoryFact, "title" | "description" | "body">[];
  /** What the Bot has learned to do. Failing to read them must not stop the routines from being kept. */
  skillsOf(bot: DeyinBot): Promise<readonly BotSkillInput[]>;
  isCustomProvider(providerId: string): boolean;
  engines: {
    /** Servers that have an engine set up. */
    hostIds(): string[];
    /** The engine on a server; a refusal (no engine, cannot connect) is thrown. */
    port(hostId: string): Promise<EngineRoutinePort>;
  };
  runs: { mirror(run: AutomationRun): boolean };
  /** Called when a pass finished, e.g. to refresh the routines list. */
  onChange?(): void;
  /** How long a burst of changes is waited out before syncing once. */
  debounceMs?: number;
}

export interface BridgeReport {
  saved: number;
  removed: number;
  mirrored: number;
  errors: Array<{ hostId: string; message: string }>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps the routines of Bots that live on a server on that server's engine, so they run on schedule while this app
 * is closed, and brings what the engine ran back into the app's run history. The app's own record of a routine stays
 * the source of truth: the engine's copy is made from it and corrected to match, never the other way round.
 */
export class RoutineBridge {
  private statuses = new Map<string, RoutineServerState>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly deps: RoutineBridgeDeps) {}

  /** Where a routine runs by itself, and why not when it cannot. Undefined for a routine the app starts. */
  stateOf(automationId: string): RoutineServerState | undefined {
    return this.statuses.get(automationId);
  }

  /** Whether the engine starts this routine on schedule, so the app's own scheduler leaves it alone. */
  schedulesOnServer(automation: Automation): boolean {
    const bot = automation.botId ? this.deps.bots.get(automation.botId) : undefined;
    if (!bot || bot.archived) return false;
    return engineSchedules(automation, bot, bot.hostId ? this.deps.engines.hostIds().includes(bot.hostId) : false);
  }

  /** Ask for a sync soon. Many changes in a short time become one. */
  schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncAll().catch(() => undefined);
    }, this.deps.debounceMs ?? 800);
    this.timer.unref?.();
  }

  /** Sync every server, one pass at a time: a pass asked for while one runs waits for it and then goes again. */
  syncAll(): Promise<BridgeReport> {
    const next = this.chain.then(() => this.pass(), () => this.pass());
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async pass(): Promise<BridgeReport> {
    const report: BridgeReport = { saved: 0, removed: 0, mirrored: 0, errors: [] };
    const automations = this.deps.automations.list();
    const permissions = this.deps.permissions.get();
    const statuses = new Map<string, RoutineServerState>();
    const allBots = this.deps.bots.list({ includeArchived: true });

    for (const hostId of this.deps.engines.hostIds()) {
      const here = allBots.filter((bot) => bot.harness === "server" && bot.hostId === hostId);
      const hereIds = new Set(here.map((bot) => bot.id));
      /** Routines that belong on this server's engine, by Bot: an archived Bot's are not wanted there. */
      const wanted = new Map<string, Automation[]>();
      for (const automation of automations) {
        const bot = automation.botId ? this.deps.bots.get(automation.botId) : undefined;
        if (!bot || bot.archived || !hereIds.has(bot.id) || !engineSchedules(automation, bot, true)) continue;
        wanted.set(bot.id, [...(wanted.get(bot.id) ?? []), automation]);
      }
      const waiting = (list: Automation[], message: string): void => {
        for (const automation of list) statuses.set(automation.id, { state: "waiting", hostId, reason: message });
      };
      // One line in the report per server, however many things on it went wrong: the first reason is the one that matters.
      const fail = (message: string): void => {
        if (!report.errors.some((entry) => entry.hostId === hostId)) report.errors.push({ hostId, message });
      };
      try {
        const port = await this.deps.engines.port(hostId);
        for (const bot of here) {
          const mine = wanted.get(bot.id) ?? [];
          const memory = mine.length > 0 ? this.deps.memoryOf(bot) : [];
          let skills: readonly BotSkillInput[];
          try {
            skills = mine.length > 0 ? await this.deps.skillsOf(bot) : [];
          } catch (error) {
            // Without its skills the routine would be put on the server as something it is not: keep what is there, try again next pass.
            fail(describe(error));
            waiting(mine, describe(error));
            continue;
          }
          const routines: EngineRoutine[] = [];
          const states = new Map<string, RoutineServerState>();
          for (const automation of mine) {
            const decision = engineRoutineFor(automation, { bot, permissions, memory, skills, customProvider: this.deps.isCustomProvider(automation.providerId) });
            if (decision.ok) {
              routines.push(decision.routine);
              states.set(automation.id, { state: "server", hostId });
            } else {
              states.set(automation.id, { state: "blocked", hostId, reason: decision.reason });
            }
          }
          try {
            const result = await reconcileBotRoutines(port, bot.id, routines);
            report.saved += result.saved.length;
            report.removed += result.removed.length;
            for (const [id, state] of states) statuses.set(id, state);
            for (const routine of routines) {
              for (const record of await port.routineRuns(bot.id, routine.id)) {
                if (this.deps.runs.mirror(mirroredRun(routine.id, record))) report.mirrored += 1;
              }
            }
          } catch (error) {
            fail(describe(error));
            waiting(mine, describe(error));
          }
        }

        // A Bot this app knows that has moved elsewhere must not keep firing here. A Bot it does not know belongs to
        // another computer using the same server, and is not this app's to touch.
        // Failing here says nothing about the routines already put on the server above, so it is reported and no more.
        try {
          for (const entry of (await port.status()).bots) {
            if (entry.routines === 0 || hereIds.has(entry.botId) || !this.deps.bots.get(entry.botId)) continue;
            report.removed += (await reconcileBotRoutines(port, entry.botId, [])).removed.length;
          }
        } catch (error) {
          fail(describe(error));
        }
      } catch (error) {
        fail(describe(error));
        waiting([...wanted.values()].flat(), describe(error));
      }
    }
    this.statuses = statuses;
    this.deps.onChange?.();
    return report;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
