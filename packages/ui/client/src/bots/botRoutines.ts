import type { Automation, AutomationInfo, DeyinApi } from "@deyin/contract";
import { ROUTINE_LIMITS, routinesOf, type DeyinBot, type MessageKey } from "@deyin/host-core/shared";
import { defaultSchedule, scheduleIssue, scheduleToTrigger, triggerToSchedule, type ScheduleDraft } from "../automationSchedule.js";

/** The automation calls a routine needs; a Bot's routines are automations the Bot owns. */
export type RoutinesApi = Pick<NonNullable<DeyinApi["automations"]>, "list" | "create" | "update" | "toggle" | "run" | "remove" | "onChange">;

/** What the editor holds. The Bot, its folder and the run limits are not the user's to set here. */
export interface RoutineForm {
  name: string;
  instruction: string;
  schedule: ScheduleDraft;
}

/** The model a routine runs with: the one the user has selected now. */
export interface RoutineDefaults {
  model: string;
  providerId: string;
}

export function emptyRoutineForm(now?: Date): RoutineForm {
  return { name: "", instruction: "", schedule: defaultSchedule(now) };
}

/** Routines that are not plain prompts (a skill or subagent) are edited in Automations; this editor only holds prompts. */
export function isEditableRoutine(info: AutomationInfo): boolean {
  return info.payload.kind === "prompt";
}

export function routineFormFromInfo(info: AutomationInfo, now?: Date): RoutineForm {
  return {
    name: info.name,
    instruction: info.payload.kind === "prompt" ? info.payload.prompt : "",
    schedule: triggerToSchedule(info.trigger, now),
  };
}

/** The shortest repeat this editor can produce, in minutes; a minutely schedule below the limit is refused before saving. */
function minutelyBelowLimit(schedule: ScheduleDraft): boolean {
  if (schedule.repeat !== "minutely") return false;
  const n = Number(schedule.interval);
  return Number.isInteger(n) && n >= 1 && n < ROUTINE_LIMITS.minSpacingMinutes;
}

/**
 * What is wrong with the schedule, as a message key, or null. A custom cron that is too frequent is not
 * caught here (that needs the schedule expanded); the host refuses it with its own message.
 */
function scheduleProblem(schedule: ScheduleDraft, now: number): MessageKey | null {
  const issue = scheduleIssue(schedule, now);
  if (issue) return `automations.issue.${issue}`;
  if (minutelyBelowLimit(schedule)) return "bot.routines.err.spacing";
  return null;
}

/** What stops a routine being saved, as a message key, or null. */
export function routineProblem(form: RoutineForm, now: number = Date.now()): MessageKey | null {
  if (!form.name.trim()) return "bot.routines.err.name";
  if (!form.instruction.trim()) return "bot.routines.err.instruction";
  return scheduleProblem(form.schedule, now);
}

/**
 * The problem to show while the user is still typing. An empty name or instruction is just an unfinished form,
 * so only the schedule is called out; Save stays disabled until `routineProblem` is null.
 */
export function routineHint(form: RoutineForm, now: number = Date.now()): MessageKey | null {
  return scheduleProblem(form.schedule, now);
}

export function routineInput(botId: string, form: RoutineForm, defaults: RoutineDefaults): Omit<Automation, "id" | "createdAt" | "updatedAt"> {
  return {
    botId,
    name: form.name.trim(),
    enabled: true,
    payload: { kind: "prompt", prompt: form.instruction.trim() },
    trigger: scheduleToTrigger(form.schedule),
    // The host replaces this with the Bot's own folder; a routine has no workspace of its own.
    target: { kind: "local", workspacePath: "" },
    model: defaults.model,
    providerId: defaults.providerId,
  };
}

/** A Bot's routines, by name, then id, so the list does not reshuffle when one runs. */
export function routineRows(automations: readonly AutomationInfo[], botId: string): AutomationInfo[] {
  return routinesOf(automations, botId).sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id),
  );
}

/** Whether the Bot has room for another routine. */
export function canAddRoutine(automations: readonly AutomationInfo[], botId: string): boolean {
  return routinesOf(automations, botId).length < ROUTINE_LIMITS.perBot;
}

/** Why "New routine" is not on offer, when it is not. */
export type AddBlock = null | "limit" | "archived" | "noModel";

/** An archived Bot cannot run, so it takes no new routines; after that the limit, then a model to run them with. */
export function addBlockFor(list: readonly AutomationInfo[], bot: Pick<DeyinBot, "id" | "archived">, defaults: RoutineDefaults): AddBlock {
  if (bot.archived) return "archived";
  if (!canAddRoutine(list, bot.id)) return "limit";
  if (!defaults.model) return "noModel";
  return null;
}

export type RoutineSaveOutcome = { ok: true; list: AutomationInfo[]; id: string } | { ok: false; error: string };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create a routine (`existing` null) or change one. An edit that leaves the schedule as it was does not send it,
 * so a one-shot that already ran is not re-armed by renaming it. Never throws: a refusal comes back as text.
 */
export async function saveRoutine(
  api: Pick<RoutinesApi, "create" | "update">,
  botId: string,
  form: RoutineForm,
  existing: AutomationInfo | null,
  defaults: RoutineDefaults,
): Promise<RoutineSaveOutcome> {
  try {
    const input = routineInput(botId, form, defaults);
    if (!existing) {
      const created = await api.create(input);
      return { ok: true, list: created.list, id: created.automation.id };
    }
    const { trigger, botId: _botId, target: _target, model: _model, providerId: _providerId, enabled: _enabled, ...rest } = input;
    const sameTrigger = JSON.stringify(trigger) === JSON.stringify(existing.trigger);
    const updated = await api.update(existing.id, sameTrigger ? rest : { ...rest, trigger });
    return { ok: true, list: updated.list, id: updated.automation.id };
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
}

export type RoutineActionOutcome = { ok: true; list?: AutomationInfo[] } | { ok: false; error: string };

/** Run any routine call, turning a thrown refusal into text for the panel. */
export async function attemptRoutineAction(run: () => Promise<AutomationInfo[] | unknown>): Promise<RoutineActionOutcome> {
  try {
    const value = await run();
    return Array.isArray(value) ? { ok: true, list: value as AutomationInfo[] } : { ok: true };
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
}
