import { join } from "node:path";
import { BotMemory, BotSkillStore, buildBotPersona, skillsPromptSection, type CoordinatedBots, type DeyinBot } from "@deyin/host-core";
import type { SubagentDefinition } from "@deyin/agent-core";
import { inert, renderMemory } from "./engine/server-prompt.js";
import { primaryTeam, type BotRunSource } from "./run.js";
import type { ToolGuard } from "./tool-guard.js";

/** Where a member's answers come from in the host's transcript: the subagent cards carry the Bot's own handle. */
export const ROOM_MEMBER_SOURCE = "room";

/** What a member is asked to do beside its own persona: answer the person directly, in its own voice. */
const ROOM_MEMBER_LEAD =
  "You are answering in a room, where the host passes you what a person asked you. Answer the person directly, in your own voice, and say what you did. You see only what you are given here, not the rest of the room.";

/** The same for a Bot the person's primary Bot hands work to: it too answers as itself, and sees only what it is given. */
export const DELEGATE_LEAD =
  "The person's primary Bot is passing you something the person asked. Answer the person directly, in your own voice, and say what you did. You see only what you are given here, not the rest of their conversation.";

/**
 * The members of a room as subagents the host can ask. Each is its own Bot: its own persona, what it remembers
 * (when memory is on) and what it has been taught, so it answers as itself and not as the room. A subagent has no
 * memory tools, so what a member remembers is written into its prompt, as for a Bot on a server.
 */
export async function roomSubagents(source: Pick<BotRunSource, "store" | "botsDir">, members: readonly DeyinBot[], options: { memoryEnabled: boolean; lead?: string }): Promise<SubagentDefinition[]> {
  const out: SubagentDefinition[] = [];
  for (const member of members) {
    const memory = options.memoryEnabled ? renderMemory(new BotMemory(source.botsDir, member.id).list()) : "";
    const taught = await new BotSkillStore(join(source.store.dataDir(member.id), "skills")).all();
    const skills = skillsPromptSection(taught.map((skill) => ({ name: skill.name, description: inert(skill.description), body: inert(skill.body) })));
    out.push({
      name: member.handle,
      description: [member.name, member.title || member.role, member.description].filter(Boolean).join(" - ").slice(0, 300),
      prompt: [buildBotPersona(member, { memoryTools: false }), memory, skills, options.lead ?? ROOM_MEMBER_LEAD].filter(Boolean).join("\n\n"),
      readonly: false,
      isBackground: false,
      source: ROOM_MEMBER_SOURCE,
    });
  }
  return out;
}

/** Who the person's primary Bot coordinates, and each of them as a subagent it can ask. */
export interface PrimaryDelegation {
  team: CoordinatedBots;
  delegates: SubagentDefinition[];
}

/**
 * What a run needs to hand work to the Bots the person's primary Bot coordinates, in a chat or in a routine: who they
 * are, for its persona, and each as a subagent that answers as itself. Undefined for any Bot that is not the primary
 * one, and for a primary Bot with no other Bots to ask.
 */
export async function primaryDelegation(bot: DeyinBot, source: Pick<BotRunSource, "store" | "botsDir">, options: { memoryEnabled: boolean }): Promise<PrimaryDelegation | undefined> {
  const team = primaryTeam(bot, source.store);
  if (!team || team.bots.length === 0) return undefined;
  return { team, delegates: await roomSubagents(source, team.bots, { memoryEnabled: options.memoryEnabled, lead: DELEGATE_LEAD }) };
}

/** In a room the host asks its members and nobody else: the subagents the person or a plugin added stay out. */
export function withRoomMembers<T extends { subagents: SubagentDefinition[] }>(caps: T, members: readonly SubagentDefinition[]): T {
  return { ...caps, subagents: [...members] };
}

/**
 * The primary Bot keeps whatever subagents the run has (the person's own and plugins') and adds the Bots it
 * coordinates. A Bot's handle wins over a subagent of the same name: the person who wrote `@ada` means the Bot.
 */
export function withBotDelegates<T extends { subagents: SubagentDefinition[] }>(caps: T, delegates: readonly SubagentDefinition[]): T {
  const taken = new Set(delegates.map((delegate) => delegate.name.toLowerCase()));
  return { ...caps, subagents: [...delegates, ...caps.subagents.filter((subagent) => !taken.has(subagent.name.toLowerCase()))] };
}

/**
 * Asking a member is the room's own work, so the host is not stopped for approval to do it: that would put a card
 * in front of the person for every question. What the member then does is another matter. Each member runs under
 * the room's own guard, so its tool calls are held to the same permissions as any Bot's. Only a `task` call that
 * names a member goes through unchecked; anything else, including a `task` call for another name, is the guard's.
 */
export function allowRoomDelegation(guard: ToolGuard, members: readonly DeyinBot[]): ToolGuard {
  const handles = new Set(members.map((member) => member.handle));
  return (call, args, summary) => {
    const asked = typeof args.subagent === "string" ? args.subagent.trim().toLowerCase() : "";
    if (call.name === "task" && handles.has(asked)) return Promise.resolve(undefined);
    return guard(call, args, summary);
  };
}
