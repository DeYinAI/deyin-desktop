/**
 * How the roster is arranged: which Bots are pinned, which are hidden, and the named sections the
 * rest are grouped into. This is the viewer's arrangement, not part of any Bot, so it lives beside
 * the Bots rather than on them. Every function returns a new layout and never mutates its input.
 */
import { BOT_LIMITS, BotError, cleanBotLine, type DeyinBot } from "./types.js";

export interface BotSection {
  id: string;
  name: string;
  botIds: string[];
}

export interface BotRosterLayout {
  /** Pinned Bots in the order they were pinned. */
  pinned: string[];
  hidden: string[];
  sections: BotSection[];
}

export const EMPTY_BOT_LAYOUT: BotRosterLayout = { pinned: [], hidden: [], sections: [] };

const unique = (ids: unknown, valid: ReadonlySet<string>): string[] =>
  Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === "string" && valid.has(id)))] : [];

/** A layout that only mentions Bots that exist, each at most once, with no hidden Bot pinned. */
export function normalizeBotLayout(raw: unknown, validIds: ReadonlySet<string>): BotRosterLayout {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const hidden = unique(r.hidden, validIds);
  const hiddenSet = new Set(hidden);
  const pinned = unique(r.pinned, validIds).filter((id) => !hiddenSet.has(id));

  const seenSections = new Set<string>();
  const placed = new Set<string>();
  const sections: BotSection[] = [];
  for (const entry of Array.isArray(r.sections) ? r.sections : []) {
    if (sections.length >= BOT_LIMITS.maxSections) break;
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = cleanBotLine(e.name).slice(0, BOT_LIMITS.sectionName);
    if (typeof e.id !== "string" || !e.id || !name || seenSections.has(e.id)) continue;
    seenSections.add(e.id);
    // A Bot belongs to one section: the first one that lists it keeps it.
    const botIds = unique(e.botIds, validIds).filter((id) => !placed.has(id));
    for (const id of botIds) placed.add(id);
    sections.push({ id: e.id, name, botIds });
  }
  return { pinned, hidden, sections };
}

export function setBotPinned(layout: BotRosterLayout, botId: string, pinned: boolean): BotRosterLayout {
  const rest = layout.pinned.filter((id) => id !== botId);
  if (!pinned) return { ...layout, pinned: rest };
  // Hiding and pinning contradict each other; pinning a hidden Bot brings it back.
  return { ...layout, pinned: [...rest, botId], hidden: layout.hidden.filter((id) => id !== botId) };
}

export function setBotHidden(layout: BotRosterLayout, botId: string, hidden: boolean): BotRosterLayout {
  const rest = layout.hidden.filter((id) => id !== botId);
  if (!hidden) return { ...layout, hidden: rest };
  return { ...layout, hidden: [...rest, botId], pinned: layout.pinned.filter((id) => id !== botId) };
}

function checkSectionName(layout: BotRosterLayout, name: string, exceptId?: string): string {
  const clean = cleanBotLine(name);
  if (!clean) throw new BotError("invalid", "A section needs a name.");
  if (clean.length > BOT_LIMITS.sectionName) {
    throw new BotError("invalid", `A section's name can be at most ${BOT_LIMITS.sectionName} characters.`);
  }
  const clash = layout.sections.some((s) => s.id !== exceptId && s.name.toLowerCase() === clean.toLowerCase());
  if (clash) throw new BotError("conflict", `There is already a section called "${clean}".`);
  return clean;
}

export function addBotSection(layout: BotRosterLayout, id: string, name: string): BotRosterLayout {
  if (layout.sections.length >= BOT_LIMITS.maxSections) {
    throw new BotError("limit", `You can have at most ${BOT_LIMITS.maxSections} sections.`);
  }
  const clean = checkSectionName(layout, name);
  return { ...layout, sections: [...layout.sections, { id, name: clean, botIds: [] }] };
}

export function renameBotSection(layout: BotRosterLayout, sectionId: string, name: string): BotRosterLayout {
  if (!layout.sections.some((s) => s.id === sectionId)) throw new BotError("not_found", "That section no longer exists.");
  const clean = checkSectionName(layout, name, sectionId);
  return { ...layout, sections: layout.sections.map((s) => (s.id === sectionId ? { ...s, name: clean } : s)) };
}

/** Removing a section sends its Bots back to the unsectioned list; no Bot is lost. */
export function removeBotSection(layout: BotRosterLayout, sectionId: string): BotRosterLayout {
  if (!layout.sections.some((s) => s.id === sectionId)) throw new BotError("not_found", "That section no longer exists.");
  return { ...layout, sections: layout.sections.filter((s) => s.id !== sectionId) };
}

/** Moves a Bot into a section, or out of every section when `sectionId` is null. */
export function moveBotToSection(layout: BotRosterLayout, botId: string, sectionId: string | null): BotRosterLayout {
  if (sectionId !== null && !layout.sections.some((s) => s.id === sectionId)) {
    throw new BotError("not_found", "That section no longer exists.");
  }
  return {
    ...layout,
    sections: layout.sections.map((s) => {
      const without = s.botIds.filter((id) => id !== botId);
      return s.id === sectionId ? { ...s, botIds: [...without, botId] } : { ...s, botIds: without };
    }),
  };
}

export interface BotRosterGroup {
  /** The section, or null for Bots that are in no section. */
  section: BotSection | null;
  bots: DeyinBot[];
}

export interface BotRoster {
  pinned: DeyinBot[];
  groups: BotRosterGroup[];
  hidden: DeyinBot[];
  archived: DeyinBot[];
}

/**
 * What the sidebar draws. Pinned Bots lead in pin order; the rest follow in their section, the
 * primary first and the others oldest first so a Bot does not move around under the pointer.
 * Hidden and archived Bots are kept out of the main list but never lost.
 */
export function buildBotRoster(bots: readonly DeyinBot[], layout: BotRosterLayout): BotRoster {
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const hiddenSet = new Set(layout.hidden);
  const archived = bots.filter((bot) => bot.archived);
  const live = bots.filter((bot) => !bot.archived);

  const order = (a: DeyinBot, b: DeyinBot): number =>
    Number(b.isPrimary) - Number(a.isPrimary) || a.createdAt - b.createdAt || a.name.localeCompare(b.name);

  const pinned = layout.pinned.map((id) => byId.get(id)).filter((bot): bot is DeyinBot => !!bot && !bot.archived && !hiddenSet.has(bot.id));
  const pinnedSet = new Set(pinned.map((bot) => bot.id));
  const hidden = live.filter((bot) => hiddenSet.has(bot.id)).sort(order);

  const sectionOf = new Map<string, string>();
  for (const section of layout.sections) for (const id of section.botIds) sectionOf.set(id, section.id);

  const shown = live.filter((bot) => !hiddenSet.has(bot.id) && !pinnedSet.has(bot.id)).sort(order);
  const loose = shown.filter((bot) => !sectionOf.has(bot.id));
  const groups: BotRosterGroup[] = [];
  if (loose.length > 0) groups.push({ section: null, bots: loose });
  for (const section of layout.sections) {
    groups.push({ section, bots: shown.filter((bot) => sectionOf.get(bot.id) === section.id) });
  }
  return { pinned, groups, hidden, archived: archived.sort(order) };
}
