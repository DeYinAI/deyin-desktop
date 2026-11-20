import type { ToolDefinition } from "@deyin/agent-core";
import { DEFAULT_BOT_ROLE, routinesOf, type AutomationInfo, type BotSkillStore, type BotStore, type DeyinBot } from "@deyin/host-core";
import { describeTrigger, parseTrigger, waitForRun } from "../automation-tools.js";
import { stamp } from "../automations/run-report.js";
import type { AutomationService } from "../automations/service.js";

/**
 * What a Bot can do for the person from inside a conversation: see their Bots, make a new one, set up and run its
 * own routines, and save what it was taught as a skill. There is no settings page to do this on; the person asks
 * in chat, and this is how the Bot does it.
 *
 * These tools only ever act for the Bot that is talking. A routine is always its own and in its own folder; a new
 * Bot starts with the default permissions and runs on this computer. Nothing here can raise a Bot's permissions,
 * pick a server, or touch another Bot's routines or skills.
 */

/** The part of the routine service the tools use. Left out where routines are not available. */
export type RoutineAccess = Pick<AutomationService, "list" | "create" | "update" | "remove" | "run" | "listRuns">;

export interface BotToolsDeps {
  /** The Bot that is talking. */
  botId: string;
  store: Pick<BotStore, "list" | "get" | "create">;
  skills: Pick<BotSkillStore, "save">;
  routines?: RoutineAccess;
  /** What a new routine runs with: the model this conversation is using. */
  model: { model: string; providerId: string };
  /** Wait for a run to finish. Left out, the real wait is used. */
  wait?: (automationId: string, runId: string, timeoutMs: number) => Promise<string>;
}

type Args = Record<string, unknown>;

const ABOUT_LIMIT = 140;
const ROUTINE_ACTION_LIMIT = 200;
const RESULT_LIMIT = 300;
const DEFAULT_WAIT_SECONDS = 90;
const MAX_WAIT_SECONDS = 300;

const SCHEDULE_NOTE =
  "cron is a 5-field expression in this computer's time zone (for example '0 8 * * 1-5' is 08:00 on weekdays); runAt is an ISO 8601 date-time with an offset for a single run. Give neither for a routine that only runs when asked. Runs can be at most once every 5 minutes.";

function str(args: Args, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

function botLine(bot: DeyinBot, selfId: string, store: Pick<BotStore, "get">, routineCount: number | undefined): string {
  const tags: string[] = [];
  if (bot.isPrimary) tags.push("primary");
  if (bot.id === selfId) tags.push("you");
  if (bot.kind === "room") {
    const members = bot.memberBotIds.map((id) => store.get(id)?.handle).filter((handle): handle is string => Boolean(handle));
    tags.push(`room with ${members.map((handle) => `@${handle}`).join(", ") || "no one"}`);
  }
  const about = oneLine(bot.purpose || bot.description || "", ABOUT_LIMIT);
  const label = bot.title || (bot.role === DEFAULT_BOT_ROLE ? "" : bot.role);
  const parts = [`- @${bot.handle}: ${bot.name}${label ? `, ${label}` : ""}${tags.length > 0 ? ` (${tags.join("; ")})` : ""}.`];
  if (about) parts.push(/[.!?…]$/.test(about) ? about : `${about}.`);
  if (routineCount !== undefined) parts.push(`${routineCount} routine${routineCount === 1 ? "" : "s"}.`);
  return parts.join(" ");
}

function routineSummary(routine: AutomationInfo): string {
  const state = !routine.enabled
    ? "paused"
    : routine.nextRunAt
      ? `next run ${stamp(routine.nextRunAt)}`
      : routine.trigger.kind === "manual"
        ? "runs only when asked"
        : "nothing scheduled";
  const does = routine.payload.kind === "prompt" ? oneLine(routine.payload.prompt, ROUTINE_ACTION_LIMIT) : `(${routine.payload.kind})`;
  const run = routine.lastRun;
  const how = run ? (run.status === "failed" ? (run.reason ?? "") : (run.finalText ?? "")) : "";
  const last = run ? ` Last run ${run.status}, ${stamp(run.startedAt)}${how ? `: ${oneLine(how, RESULT_LIMIT)}` : ""}.` : "";
  return `${routine.name} (id ${routine.id}): ${describeTrigger(routine.trigger)}, ${state}. Does: ${does}.${last}`;
}

/** One of this Bot's own routines, found by id, a unique start of an id, or its name. Another Bot's is never found. */
function ownRoutine(list: readonly AutomationInfo[], botId: string, ref: string): AutomationInfo {
  if (!ref) throw new Error("Say which routine, by its name or id. routine_list shows them.");
  const mine = routinesOf(list, botId);
  const byId = mine.filter((routine) => routine.id === ref);
  const byName = mine.filter((routine) => routine.name.toLowerCase() === ref.toLowerCase());
  const byStart = ref.length >= 4 ? mine.filter((routine) => routine.id.startsWith(ref)) : [];
  const found = byId.length > 0 ? byId : byName.length > 0 ? byName : byStart;
  if (found.length === 0) throw new Error(`You have no routine called "${ref}". routine_list shows yours.`);
  if (found.length > 1) throw new Error(`"${ref}" fits ${found.length} routines. Use the id from routine_list.`);
  return found[0]!;
}

const nameProp = { type: "string", description: "A short name the person will recognise, for example 'Morning brief'." };
const scheduleProps = {
  cron: { type: "string", description: `When it repeats. ${SCHEDULE_NOTE}` },
  runAt: { type: "string", description: "A single future time as an ISO 8601 date-time with an offset. Used instead of cron." },
};

export function createBotTools(deps: BotToolsDeps): ToolDefinition[] {
  const { botId, store, skills } = deps;

  const listBots: ToolDefinition = {
    name: "bot_list",
    description:
      "List the person's Bots: handle, name, what each is for, which one is primary and which is you, and how many routines each has. Use it to answer what is set up, or before suggesting a new Bot.",
    tier: "read",
    parameters: { type: "object", properties: {}, required: [] },
    summarize: () => "list Bots",
    execute: async () => {
      const bots = store.list();
      if (bots.length === 0) return "There are no Bots yet.";
      const routines = deps.routines?.list();
      return bots.map((bot) => botLine(bot, botId, store, routines ? routinesOf(routines, bot.id).length : undefined)).join("\n");
    },
  };

  const createBot: ToolDefinition = {
    name: "bot_create",
    description:
      "Create a new Bot for the person, with one focused job. Only after the person has agreed to it: say what you would call it and what its job is, and wait for a yes. The new Bot starts with the default permissions and runs on this computer; you cannot change that. It is ready from the person's next message, not in this turn.",
    tier: "write",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The Bot's name, for example 'Standup Scribe'." },
        job: {
          type: "string",
          description: "What the Bot is for, in plain words: its one job, the sources it uses, and what it must ask the person about before it acts. This becomes its standing instructions.",
        },
        title: { type: "string", description: "Optional short line under its name, for example 'Meeting notes'." },
      },
      required: ["name", "job"],
    },
    summarize: (args) => `create the Bot ${str(args, "name") || "(unnamed)"}`,
    execute: async (args) => {
      const name = str(args, "name");
      const job = str(args, "job");
      if (!name) throw new Error("Give the Bot a name.");
      if (!job) throw new Error("Say what the Bot is for. A Bot with no job has nothing to do.");
      const title = str(args, "title");
      const bot = store.create({ name, purpose: job, ...(title ? { title } : {}) });
      return `Created ${bot.name} (@${bot.handle}). It is ready from the person's next message: they can write @${bot.handle} to talk to it, and you can hand it work then. Tell the person it exists and what its job is.`;
    },
  };

  const saveSkill: ToolDefinition = {
    name: "skill_save",
    description:
      "Save a skill: a how-to you reuse, written as steps (what to open, what to check, what the result looks like). Use it when the person has shown or told you how they want a task done and wants it done that way every time. Saving under a name you already have replaces its instructions and keeps the earlier version in its history. It is available from the person's next message.",
    tier: "write",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lowercase words with hyphens, for example 'weekly-report'." },
        description: { type: "string", description: "One sentence on when to use it, so you know when it applies." },
        body: { type: "string", description: "The instructions, step by step." },
      },
      required: ["name", "description", "body"],
    },
    summarize: (args) => `save the skill ${str(args, "name") || "(unnamed)"}`,
    execute: async (args) => {
      const skill = await skills.save({ name: args.name, description: args.description, body: args.body }, { author: "bot", origin: "bot" });
      return `Saved the skill "${skill.name}" (version ${skill.version}). It is available from the person's next message.`;
    },
  };

  const tools = [listBots, createBot, saveSkill];
  const routines = deps.routines;
  if (!routines) return tools;

  const wait = deps.wait ?? ((automationId: string, runId: string, timeoutMs: number) => waitForRun(routines, automationId, runId, timeoutMs));

  const listRoutines: ToolDefinition = {
    name: "routine_list",
    description: "List your own routines: when each runs, whether it is paused, what it does, and how its last run went (with the start of what it said). Use it to answer what a routine did.",
    tier: "read",
    parameters: { type: "object", properties: {}, required: [] },
    summarize: () => "list routines",
    execute: async () => {
      const mine = routinesOf(routines.list(), botId);
      if (mine.length === 0) return "You have no routines yet.";
      return mine.map((routine) => `- ${routineSummary(routine)}`).join("\n");
    },
  };

  const createRoutine: ToolDefinition = {
    name: "routine_create",
    description:
      "Set up a routine: something you do on a schedule, on your own, with nobody in the chat. Its result is posted to your conversation. Before you create one, make sure you know when it runs and in which time zone, what it should read, what it should send back, what it must never do without asking, and what to do if a source is missing. Ask for whatever you do not know, and write all of it into the instruction, because the routine will not see this conversation.",
    tier: "write",
    parameters: {
      type: "object",
      properties: {
        name: nameProp,
        instruction: { type: "string", description: "Everything the routine needs, as if it were a new colleague reading it cold: the job, the sources, what to send back, what needs asking first, and what to do when something is missing." },
        ...scheduleProps,
      },
      required: ["name", "instruction"],
    },
    summarize: (args) => `create the routine ${str(args, "name") || "(unnamed)"}`,
    execute: async (args) => {
      const name = str(args, "name");
      const instruction = str(args, "instruction");
      if (!name) throw new Error("Give the routine a short name.");
      if (!instruction) throw new Error("Say what the routine should do each time it runs.");
      if (!deps.model.model) throw new Error("No model is selected, so a routine has nothing to run with. Pick a model first.");
      const trigger = parseTrigger(args);
      const { automation } = routines.create({
        botId,
        name,
        enabled: true,
        payload: { kind: "prompt", prompt: instruction },
        trigger,
        // The host replaces this with the Bot's own folder; a routine has no workspace of its own.
        target: { kind: "local", workspacePath: "" },
        model: deps.model.model,
        providerId: deps.model.providerId,
      });
      const when =
        trigger.kind === "manual"
          ? "It has no schedule, so it only runs when asked. Use routine_run to run it now, or routine_update to give it a schedule."
          : `It will run ${describeTrigger(trigger)}, and its result will be posted to this conversation.`;
      return `Created the routine "${automation.name}" (id ${automation.id}). ${when}`;
    },
  };

  const updateRoutine: ToolDefinition = {
    name: "routine_update",
    description: "Change one of your routines: rename it, rewrite its instruction, change when it runs, or pause or resume it. Only the fields you pass change.",
    tier: "write",
    parameters: {
      type: "object",
      properties: {
        routine: { type: "string", description: "The routine's name or id." },
        name: { ...nameProp, description: "A new name." },
        instruction: { type: "string", description: "The new instruction, written whole." },
        ...scheduleProps,
        enable: { type: "boolean", description: "false pauses it, true resumes it." },
      },
      required: ["routine"],
    },
    summarize: (args) => `change the routine ${str(args, "routine") || "(which?)"}`,
    execute: async (args) => {
      const existing = ownRoutine(routines.list(), botId, str(args, "routine"));
      const patch: Parameters<RoutineAccess["update"]>[1] = {};
      const name = str(args, "name");
      if (name) patch.name = name;
      const instruction = str(args, "instruction");
      if (instruction) patch.payload = { kind: "prompt", prompt: instruction };
      if (args.cron !== undefined || args.runAt !== undefined) patch.trigger = parseTrigger(args);
      if (args.enable !== undefined) patch.enabled = args.enable === true;
      if (Object.keys(patch).length === 0) return "Nothing to change. Pass a new name, instruction, schedule, or enable.";
      routines.update(existing.id, patch);
      const now = routines.list().find((routine) => routine.id === existing.id) ?? existing;
      return `Updated. Now: ${routineSummary(now)}`;
    },
  };

  const deleteRoutine: ToolDefinition = {
    name: "routine_delete",
    description: "Delete one of your routines for good. Its past runs stay in the history. Confirm with the person first.",
    tier: "write",
    parameters: { type: "object", properties: { routine: { type: "string", description: "The routine's name or id." } }, required: ["routine"] },
    summarize: (args) => `delete the routine ${str(args, "routine") || "(which?)"}`,
    execute: async (args) => {
      const existing = ownRoutine(routines.list(), botId, str(args, "routine"));
      routines.remove(existing.id);
      return `Deleted the routine "${existing.name}".`;
    },
  };

  const runRoutine: ToolDefinition = {
    name: "routine_run",
    description: "Run one of your routines now and wait briefly for it to finish, to try it or to answer a request for it right away.",
    tier: "execute",
    parameters: {
      type: "object",
      properties: {
        routine: { type: "string", description: "The routine's name or id." },
        waitSeconds: { type: "number", description: `How long to wait for it to finish (default ${DEFAULT_WAIT_SECONDS}, at most ${MAX_WAIT_SECONDS}).` },
      },
      required: ["routine"],
    },
    summarize: (args) => `run the routine ${str(args, "routine") || "(which?)"}`,
    execute: async (args) => {
      const existing = ownRoutine(routines.list(), botId, str(args, "routine"));
      const run = routines.run(existing.id);
      const asked = typeof args.waitSeconds === "number" && args.waitSeconds > 0 ? Math.floor(args.waitSeconds) : DEFAULT_WAIT_SECONDS;
      return wait(existing.id, run.id, Math.min(asked, MAX_WAIT_SECONDS) * 1000);
    },
  };

  return [...tools, listRoutines, createRoutine, updateRoutine, deleteRoutine, runRoutine];
}
