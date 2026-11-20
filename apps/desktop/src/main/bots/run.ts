import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  BotError,
  BotMemory,
  BotSkillStore,
  botResult,
  buildBotPersona,
  buildRoomPersona,
  roomMembers,
  type BotResult,
  type BotStore,
  type DeyinBot,
} from "@deyin/host-core";
import type { GuardPermissions } from "./tool-guard.js";
import type { VaultRunStore } from "./vault-run.js";

/** What the agent host needs to run as a Bot. `botsDir` is `<userData>/bots`. */
export interface BotRunSource {
  store: Pick<BotStore, "get" | "dataDir">;
  botsDir: string;
  /** The saved tool permissions every Bot run is held to. Left out, a Bot is held to the defaults. */
  permissions?: GuardPermissions;
  /** The Vault a Bot fills logins, cards and contacts from. Left out, a Bot has no Vault tools. */
  vault?: VaultRunStore;
}

/** Everything one Bot run swaps in for the open project's equivalents. */
export interface BotRunContext {
  bot: DeyinBot;
  /** The Bot's own files folder; kept apart from `memory/` so file tools never sit on the memory store. */
  cwd: string;
  /** Standing instructions appended to the system prompt. */
  persona: string;
  /** Private facts in the Bot's folder, shared facts across all Bots. */
  memory: BotMemory;
  /** What the Bot has learned to do, kept in its own folder, beside `files/` and `memory/`. */
  skills: BotSkillStore;
  /** For a room: the Bots that answer in it (never empty). A Bot that is not a room has none. */
  members: readonly DeyinBot[];
}

/**
 * Resolve a Bot for a run, or say why it cannot run. Refusals are text for the user, not exceptions,
 * because the caller reports them as a chat error.
 */
export function resolveBotRun(source: BotRunSource, botId: string): BotResult<BotRunContext> {
  return botResult(() => {
    const bot = source.store.get(botId);
    if (!bot) throw new BotError("not_found", "That Bot no longer exists.");
    if (bot.archived) throw new BotError("conflict", `${bot.name} is archived. Restore it to chat with it.`);
    // A room is run by a host that asks its members; it is told who they are and none of them is the voice.
    const members = bot.kind === "room" ? roomMembers(bot, (id) => source.store.get(id)) : [];
    if (bot.kind === "room" && members.length === 0) {
      throw new BotError("conflict", `None of the Bots in ${bot.name} can answer. Restore them, or add other Bots to the room.`);
    }
    const cwd = join(source.store.dataDir(bot.id), "files");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    return {
      bot,
      cwd,
      members,
      persona: bot.kind === "room" ? buildRoomPersona(bot, members) : buildBotPersona(bot),
      memory: new BotMemory(source.botsDir, bot.id),
      skills: new BotSkillStore(join(source.store.dataDir(bot.id), "skills")),
    };
  });
}

/** A routine has no conversation, so a room (which answers through its members in one) cannot be the one it runs as. */
function roomHasNoRoutines(bot: DeyinBot): string {
  return `${bot.name} is a room. Give the routine to one of its Bots.`;
}

/**
 * Resolve a Bot for a run that has no chat to report a refusal to (a routine): the refusal is thrown as an
 * ordinary error, which the automation runner records on the run.
 */
export function requireBotRun(source: BotRunSource | undefined, botId: string): BotRunContext {
  if (!source) throw new Error("Bots are not available in this window.");
  const resolved = resolveBotRun(source, botId);
  if (!resolved.ok) throw new Error(resolved.error);
  if (resolved.value.bot.kind === "room") throw new Error(roomHasNoRoutines(resolved.value.bot));
  return resolved.value;
}

/** Whether a routine can be given to this Bot, and the folder it would work in. A refusal says why. */
export function resolveRoutineBot(source: BotRunSource | undefined, botId: string): BotResult<{ cwd: string }> {
  if (!source) return { ok: false, error: "Bots are not available in this window.", code: "invalid" };
  const resolved = resolveBotRun(source, botId);
  if (!resolved.ok) return resolved;
  if (resolved.value.bot.kind === "room") return { ok: false, error: roomHasNoRoutines(resolved.value.bot), code: "invalid" };
  return { ok: true, value: { cwd: resolved.value.cwd } };
}

interface SourcedCaps {
  skills: { source: string }[];
  subagents: { source: string }[];
  hooks: { source: string }[];
  mcpServers: { source: string }[];
}

/**
 * A Bot is not working on the open project, so the project's own skills, subagents, hooks and MCP servers
 * (the ones read from its `.deyin/` folder) stay out of the run. The user's own and plugins' stay in.
 */
export function withoutWorkspaceCaps<T extends SourcedCaps>(caps: T): T {
  const user = <E extends { source: string }>(list: E[]): E[] => list.filter((entry) => entry.source !== "workspace");
  return {
    ...caps,
    skills: user(caps.skills),
    subagents: user(caps.subagents),
    hooks: user(caps.hooks),
    mcpServers: user(caps.mcpServers),
  };
}

/** Where a run works, and which folder (if any) must be trusted before the project's hooks and MCP servers load. */
export interface RunScope {
  cwd: string;
  trustRoot: string | null;
}

/**
 * A Bot works in its own folder and has no project to trust. Everything else works in the open project,
 * falling back to `fallbackCwd` (the home folder) when none is open.
 */
export function runScope(bot: Pick<BotRunContext, "cwd"> | null, workspaceRoot: string | null, fallbackCwd: string): RunScope {
  if (bot) return { cwd: bot.cwd, trustRoot: null };
  return { cwd: workspaceRoot ?? fallbackCwd, trustRoot: workspaceRoot };
}

/** Append a Bot's standing instructions after the agent's own prompt; without a persona the prompt is unchanged. */
export function withBotPersona(prompt: string, persona: string | undefined): string {
  return persona ? `${prompt}\n\n${persona}` : prompt;
}
