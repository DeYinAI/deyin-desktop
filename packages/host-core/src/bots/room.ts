import { BOT_LIMITS, cleanBotLine, cleanBotText, type DeyinBot } from "./types.js";

/** Tag that wraps what a room's host is told about the room. */
export const ROOM_PERSONA_TAG = "bot_room";

/** How much of a member's own description is shown to the room's host: enough to choose between members. */
export const ROOM_MEMBER_BRIEF = 160;

const TAGS = new RegExp(`</?${ROOM_PERSONA_TAG}[^>]*>`, "gi");

function inert(text: string): string {
  return text.replace(TAGS, "").trim();
}

function line(value: unknown): string {
  return inert(cleanBotLine(value));
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** A Bot that can sit in a room: active, and not a room itself. */
export function canSitInRoom(bot: DeyinBot | undefined): boolean {
  return bot !== undefined && bot.kind === "agent" && !bot.archived;
}

/** The members of a room that can answer now, in the order the room lists them, at most `maxRoomMembers`. */
export function roomMembers(room: DeyinBot, bots: ReadonlyMap<string, DeyinBot> | ((id: string) => DeyinBot | undefined)): DeyinBot[] {
  const find = typeof bots === "function" ? bots : (id: string) => bots.get(id);
  const members: DeyinBot[] = [];
  for (const id of room.memberBotIds) {
    const member = find(id);
    if (member && canSitInRoom(member)) members.push(member);
    if (members.length >= BOT_LIMITS.maxRoomMembers) break;
  }
  return members;
}

/** What one member is, for the host to choose by: its handle, its name and label, and a clipped description. */
export function roomMemberLine(member: DeyinBot): string {
  const label = line(member.title) || line(member.role);
  const about = clip(line(member.description) || line(member.purpose), ROOM_MEMBER_BRIEF);
  const head = `- @${line(member.handle)}: ${line(member.name) || "a Bot"}${label ? `, ${label}` : ""}`;
  return about ? `${head}. ${about}` : head;
}

/**
 * The standing instructions for the one agent that runs a room. A room has no single voice: this agent is its
 * host. It does not answer for a member. It hands each request to the member the person named, and each member
 * answers as itself (the host calls it as a subagent), so a room is several Bots, each in its own voice, in one
 * conversation. Pure, so the same text is previewed and sent.
 */
export function buildRoomPersona(room: DeyinBot, members: readonly DeyinBot[]): string {
  const name = line(room.name) || "this room";
  const about = cleanBotText(room.description) ? inert(cleanBotText(room.description)) : "";
  const roster = members.map(roomMemberLine).join("\n");
  const lines = [
    `You host the room "${name}", a conversation between the person and these Bots:`,
    roster,
    ...(about ? [`About the room:\n${about}`] : []),
    "You are not one of them and you never answer for them.",
    "When the person writes @handle, ask that Bot with the task tool, using its handle as the subagent. Give it the person's request in full and anything it needs from earlier in the conversation, because it cannot see the conversation. Then show its answer under its name, like **Name:** and the answer, without rewriting what it said.",
    "When the message names several Bots, ask each in turn and show every answer. When it names nobody, ask the Bot best placed to help, and say who you asked. When the person addresses the whole room, ask every Bot.",
    "Do not make up members, and do not claim a Bot said something it did not. If a Bot cannot answer, say so under its name.",
  ];
  return `<${ROOM_PERSONA_TAG}>\n${lines.join("\n")}\n</${ROOM_PERSONA_TAG}>`;
}

/** The composer text after adding `@handle` to it: after what is there, with a space between, and a space after. */
export function insertMention(input: string, handle: string): string {
  const mention = `@${handle} `;
  if (input === "") return mention;
  return /\s$/.test(input) ? `${input}${mention}` : `${input} ${mention}`;
}
