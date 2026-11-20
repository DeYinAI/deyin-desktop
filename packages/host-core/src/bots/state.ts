/**
 * The persisted shape of the Bots, and the rules that keep it consistent.
 *
 * `settleBotsState` is the single place those rules live. The store applies every change to a
 * draft and settles it, and loading a file settles it too, so a hand-edited or half-written file and a
 * freshly mutated one are held to exactly the same invariants:
 *
 *   - every Bot is well-formed and ids are unique;
 *   - handles are unique and well-formed;
 *   - an archived Bot or a room is never primary, and while any active agent exists exactly one is;
 *   - a room only lists existing Bots, and an active room only lists active agents (a room left with
 *     fewer than two is archived rather than deleted);
 *   - the roster layout mentions only Bots that exist.
 *
 * Pure and browser-safe: it returns a new state and never mutates its input.
 */
import { normalizeBotLayout, type BotRosterLayout } from "./layout.js";
import { BOT_LIMITS, normalizeBot, uniqueBotHandle, type DeyinBot } from "./types.js";

export const BOTS_STATE_VERSION = 1;

export interface BotsState {
  version: typeof BOTS_STATE_VERSION;
  bots: DeyinBot[];
  layout: BotRosterLayout;
}

/** The whole roster in one value: what `bots:list` returns and what change listeners receive. */
export interface BotsSnapshot {
  /** Every Bot including archived ones; the renderer groups them with `buildBotRoster`. */
  bots: DeyinBot[];
  layout: BotRosterLayout;
}

export const EMPTY_BOTS_STATE: BotsState = {
  version: BOTS_STATE_VERSION,
  bots: [],
  layout: { pinned: [], hidden: [], sections: [] },
};

const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function oldestFirst(a: DeyinBot, b: DeyinBot): number {
  return a.createdAt - b.createdAt;
}

/** Bring `draft` to a state that satisfies every invariant, changing as little as it can. */
export function settleBotsState(draft: { bots: readonly unknown[]; layout?: unknown }): BotsState {
  // 1. Well-formed Bots with unique ids; the first of any duplicate wins.
  const seen = new Set<string>();
  let bots: DeyinBot[] = [];
  for (const raw of draft.bots) {
    const bot = normalizeBot(raw);
    if (!bot || seen.has(bot.id)) continue;
    seen.add(bot.id);
    bots.push(bot);
  }

  // 2. Unique, well-formed handles, assigned in stored order so the earliest Bot keeps a contested one.
  const handles = new Set<string>();
  bots = bots.map((bot) => {
    const keep = HANDLE_PATTERN.test(bot.handle) && bot.handle.length <= BOT_LIMITS.handle && !handles.has(bot.handle);
    const handle = keep ? bot.handle : uniqueBotHandle(bot.name, handles);
    handles.add(handle);
    return handle === bot.handle ? bot : { ...bot, handle };
  });

  // 3. Rooms: members must exist; an active room may only hold active agents and needs enough of them.
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  bots = bots.map((bot) => {
    if (bot.kind !== "room") return bot;
    const existing = bot.memberBotIds.filter((id) => byId.get(id)?.kind === "agent");
    const members = bot.archived ? existing : existing.filter((id) => !byId.get(id)!.archived);
    const archived = bot.archived || members.length < BOT_LIMITS.minRoomMembers;
    const same = members.length === bot.memberBotIds.length && members.every((id, i) => id === bot.memberBotIds[i]);
    return same && archived === bot.archived ? bot : { ...bot, memberBotIds: members, archived };
  });

  // 4. Primary: only an active agent can be it; keep the oldest claimant, or promote the oldest agent.
  const eligible = bots.filter((bot) => bot.kind === "agent" && !bot.archived);
  const claimants = eligible.filter((bot) => bot.isPrimary).sort(oldestFirst);
  const primaryId = (claimants[0] ?? [...eligible].sort(oldestFirst)[0])?.id;
  bots = bots.map((bot) => {
    const isPrimary = bot.id === primaryId;
    return isPrimary === bot.isPrimary ? bot : { ...bot, isPrimary };
  });

  const layout = normalizeBotLayout(draft.layout, new Set(bots.map((bot) => bot.id)));
  return { version: BOTS_STATE_VERSION, bots, layout };
}

/**
 * Read a persisted state. `changed` is true when settling altered anything, so the store can write
 * the repaired file back once instead of repairing it on every launch.
 */
export function normalizeBotsState(raw: unknown): { state: BotsState; changed: boolean } {
  const input = (raw && typeof raw === "object" ? raw : {}) as { bots?: unknown; layout?: unknown };
  const state = settleBotsState({ bots: Array.isArray(input.bots) ? input.bots : [], layout: input.layout });
  // A file that was never written is not a repair. Only a stored list that settling altered is.
  const changed =
    Array.isArray(input.bots) &&
    JSON.stringify({ version: BOTS_STATE_VERSION, bots: input.bots, layout: input.layout ?? EMPTY_BOTS_STATE.layout }) !==
      JSON.stringify(state);
  return { state, changed };
}
