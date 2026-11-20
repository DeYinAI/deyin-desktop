import { BOT_LIMITS, canSitInRoom, cleanBotLine, type BotInput, type BotPatch, type DeyinBot } from "@deyin/host-core/shared";

/** What the "New room" dialog holds. The name is kept as typed and cleaned only when sent. */
export interface RoomForm {
  name: string;
  /** The Bots chosen, in the order they were chosen: the order the room lists them in. */
  memberIds: string[];
}

export function newRoomForm(): RoomForm {
  return { name: "", memberIds: [] };
}

/** One line in the member picker. */
export interface MemberRow {
  bot: DeyinBot;
  selected: boolean;
  /** A member that is archived: still in the room, but cannot answer until it is restored. Shown so it can be taken out. */
  unavailable: boolean;
}

/** The Bots a room can be made of: every active Bot, plus any archived one the room still has, so it can be removed. */
export function memberRows(bots: readonly DeyinBot[], selectedIds: readonly string[]): MemberRow[] {
  const selected = new Set(selectedIds);
  return bots
    .filter((bot) => bot.kind === "agent" && (canSitInRoom(bot) || selected.has(bot.id)))
    .map((bot) => ({ bot, selected: selected.has(bot.id), unavailable: !canSitInRoom(bot) }));
}

/** Add the Bot if it is not chosen, take it out if it is. Adding past the room's limit changes nothing. */
export function toggleMember(ids: readonly string[], botId: string): string[] {
  if (ids.includes(botId)) return ids.filter((id) => id !== botId);
  if (ids.length >= BOT_LIMITS.maxRoomMembers) return [...ids];
  return [...ids, botId];
}

export function roomIsFull(ids: readonly string[]): boolean {
  return ids.length >= BOT_LIMITS.maxRoomMembers;
}

export type RoomProblem = "name" | "members";

/** What is missing before a room can be made, or null when it can. Only Bots that can answer count as members. */
export function roomProblem(name: string, ids: readonly string[], bots: readonly DeyinBot[]): RoomProblem | null {
  if (cleanBotLine(name).length === 0) return "name";
  const active = new Set(bots.filter(canSitInRoom).map((bot) => bot.id));
  return ids.filter((id) => active.has(id)).length < BOT_LIMITS.minRoomMembers ? "members" : null;
}

/** The request that makes a room from the form. */
export function roomFormToInput(form: RoomForm): BotInput {
  return { name: cleanBotLine(form.name), kind: "room", memberBotIds: [...form.memberIds] };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** The change that gives a room these members, or null when they are the ones it already has. */
export function membersPatch(room: DeyinBot, ids: readonly string[]): BotPatch | null {
  return sameIds(room.memberBotIds, ids) ? null : { memberBotIds: [...ids] };
}

/**
 * The chosen members after the saved room changed underneath the picker. An untouched picker follows the
 * change; one with edits keeps them, so choosing is never overwritten.
 */
export function followSavedMembers(previous: DeyinBot, next: DeyinBot, chosen: readonly string[]): string[] {
  return sameIds(previous.memberBotIds, chosen) ? [...next.memberBotIds] : [...chosen];
}
