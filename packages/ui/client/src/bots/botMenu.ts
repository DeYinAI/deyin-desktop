import type { BotRosterLayout, DeyinBot } from "@deyin/host-core/shared";

/** One entry in a Bot's row menu. */
export type BotMenuAction =
  | { kind: "details" }
  | { kind: "pin" }
  | { kind: "unpin" }
  | { kind: "hide" }
  | { kind: "show" }
  | { kind: "section"; sectionId: string; name: string; current: boolean }
  | { kind: "newSection" }
  | { kind: "noSection" }
  | { kind: "makePrimary" }
  | { kind: "archive" }
  | { kind: "restore" }
  | { kind: "delete" };

/** The section a Bot is filed under, if any. */
export function sectionOfBot(layout: BotRosterLayout, botId: string): string | null {
  return layout.sections.find((section) => section.botIds.includes(botId))?.id ?? null;
}

/**
 * What a Bot's row menu offers right now. An archived Bot can only be inspected, restored or deleted
 * (it cannot be pinned, moved or made primary); an active one never offers an action that would change
 * nothing, such as "Make primary" on the primary Bot or "No section" when it has none.
 */
export function botMenuActions(bot: DeyinBot, layout: BotRosterLayout): BotMenuAction[] {
  if (bot.archived) return [{ kind: "details" }, { kind: "restore" }, { kind: "delete" }];

  const actions: BotMenuAction[] = [{ kind: "details" }];
  actions.push({ kind: layout.pinned.includes(bot.id) ? "unpin" : "pin" });
  actions.push({ kind: layout.hidden.includes(bot.id) ? "show" : "hide" });

  const current = sectionOfBot(layout, bot.id);
  for (const section of layout.sections) {
    actions.push({ kind: "section", sectionId: section.id, name: section.name, current: section.id === current });
  }
  actions.push({ kind: "newSection" });
  if (current !== null) actions.push({ kind: "noSection" });

  if (bot.kind === "agent" && !bot.isPrimary) actions.push({ kind: "makePrimary" });
  actions.push({ kind: "archive" });
  actions.push({ kind: "delete" });
  return actions;
}

/**
 * The section that exists in `after` but not in `before`, i.e. the one a just-finished "add section"
 * created. Several sections may share a name, so the new one is found by id, never by name.
 */
export function addedSectionId(before: BotRosterLayout, after: BotRosterLayout): string | null {
  const known = new Set(before.sections.map((section) => section.id));
  return after.sections.find((section) => !known.has(section.id))?.id ?? null;
}
