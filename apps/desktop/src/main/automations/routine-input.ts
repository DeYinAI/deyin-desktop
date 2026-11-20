import { routineQuotaError, type Automation, type BotResult } from "@deyin/host-core";
import { routineScheduleError } from "./routine-gate.js";

type NewAutomation = Omit<Automation, "id" | "createdAt" | "updatedAt">;
type AutomationPatch = Partial<Omit<Automation, "id" | "createdAt">>;

export interface RoutineEnv {
  /** Every automation saved so far, for the per-Bot quota. */
  existing: readonly Pick<Automation, "botId">[];
  /** The Bot a routine would run as; the error says why it cannot. `cwd` is the Bot's own folder. */
  resolveBot: (botId: string) => BotResult<{ cwd: string }>;
  now: number;
}

/**
 * Check a new routine and pin what the Bot owns. A routine always works in its Bot's folder, whatever target the
 * caller sent, so a Bot's files never end up in someone else's workspace. Throws a message a person can read.
 */
export function prepareNewRoutine(input: NewAutomation, env: RoutineEnv): NewAutomation {
  const botId = input.botId;
  if (typeof botId !== "string" || botId.length === 0) throw new Error("A routine needs a Bot.");
  const bot = env.resolveBot(botId);
  if (!bot.ok) throw new Error(bot.error);
  const quota = routineQuotaError(env.existing, botId);
  if (quota) throw new Error(quota);
  const schedule = routineScheduleError(input.trigger, env.now);
  if (schedule) throw new Error(schedule);
  return { ...input, target: { kind: "local", workspacePath: bot.value.cwd } };
}

/** What an edit may change: a routine keeps its Bot and its folder, and an ordinary automation cannot become one. */
export function prepareRoutinePatch(existing: Pick<Automation, "botId">, patch: AutomationPatch, env: Pick<RoutineEnv, "now">): AutomationPatch {
  if (existing.botId === undefined) {
    if (patch.botId !== undefined) throw new Error("An automation cannot be turned into a routine.");
    return patch;
  }
  if (patch.botId !== undefined && patch.botId !== existing.botId) throw new Error("A routine cannot move to another Bot.");
  if (patch.trigger) {
    const schedule = routineScheduleError(patch.trigger, env.now);
    if (schedule) throw new Error(schedule);
  }
  const { target: _target, ...rest } = patch;
  return rest;
}
