import type { DeyinApi } from "@deyin/contract";
import { CATALOG_CATEGORIES, type CatalogCard, type CatalogCategory, type ImportedBot, type MessageKey, type TemplateSummary } from "@deyin/host-core/shared";
import type { RoutineDefaults } from "./botRoutines.js";

/** The sharing and marketplace calls the panels need. Absent where there is no desktop host. */
export type TemplatesApi = NonNullable<DeyinApi["botTemplates"]>;

export interface TemplateLine {
  key: MessageKey;
  vars: Record<string, string | number>;
}

/** What is wrong with what was pasted, as a message key, or null when it can be looked at. */
export function pastedProblem(text: string): MessageKey | null {
  return text.trim() ? null : "bot.share.problem.empty";
}

/**
 * Why a Bot cannot be added yet, or null. Its routines run on a model the person has, so one is needed to add a Bot
 * that comes with any; a Bot with none is added without.
 */
export function importBlocked(routines: number, defaults: RoutineDefaults): MessageKey | null {
  if (routines > 0 && (!defaults.model || !defaults.providerId)) return "bot.share.problem.noModel";
  return null;
}

/** What a Bot comes with, in a sentence's parts: "2 skills", "1 routine". */
export function comesWithLine(counts: { skills: number; routines: number }): TemplateLine {
  const { skills, routines } = counts;
  if (skills === 0 && routines === 0) return { key: "bot.share.comesWithNothing", vars: {} };
  if (routines === 0) return { key: skills === 1 ? "bot.share.comesWithSkill" : "bot.share.comesWithSkills", vars: { skills } };
  if (skills === 0) return { key: routines === 1 ? "bot.share.comesWithRoutine" : "bot.share.comesWithRoutines", vars: { routines } };
  return { key: "bot.share.comesWithBoth", vars: { skills, routines } };
}

export function summaryCounts(summary: Pick<TemplateSummary, "skills" | "routines">): { skills: number; routines: number } {
  return { skills: summary.skills.length, routines: summary.routines.length };
}

/** What to say after an import: the Bot's name, then what came with it when anything did. */
export function importedLines(result: Pick<ImportedBot, "bot" | "skills" | "routines">): TemplateLine[] {
  const { bot, skills, routines } = result;
  const added: TemplateLine = { key: "bot.share.addedPlain", vars: { name: bot.name } };
  return skills === 0 && routines === 0 ? [added] : [added, comesWithLine({ skills, routines })];
}

export type CategoryFilter = CatalogCategory | "all";

export const CATEGORY_FILTERS: readonly CategoryFilter[] = ["all", ...CATALOG_CATEGORIES];

export function categoryKey(filter: CategoryFilter): MessageKey {
  switch (filter) {
    case "all":
      return "bot.market.category.all";
    case "work":
      return "bot.market.category.work";
    case "research":
      return "bot.market.category.research";
    case "writing":
      return "bot.market.category.writing";
    case "dev":
      return "bot.market.category.dev";
    default: {
      const unhandled: never = filter;
      throw new Error(`Unhandled category: ${String(unhandled)}`);
    }
  }
}

/** The category to ask the host for: none when every one is wanted. */
export function categoryArg(filter: CategoryFilter): CatalogCategory | undefined {
  return filter === "all" ? undefined : filter;
}

/** What a starter's button says: one made from it already exists, so another is a second one. */
export function getKey(card: Pick<CatalogCard, "have">): MessageKey {
  return card.have ? "bot.market.getAnother" : "bot.market.get";
}
