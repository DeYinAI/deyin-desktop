import {
  BOT_CATALOG,
  BotError,
  CATALOG_ORIGIN_PREFIX,
  botInputFromTemplate,
  botResultAsync,
  catalogEntry,
  catalogOriginOf,
  forYou,
  isCatalogCategory,
  isTemplateLink,
  makeBotTemplate,
  parseBotTemplate,
  parseTemplateLink,
  searchCatalog,
  stringifyBotTemplate,
  summarizeTemplate,
  templateLink,
  type Automation,
  type BotResult,
  type BotStore,
  type BotTemplate,
  type BotTemplateRoutine,
  type CatalogCard,
  type CatalogListing,
  type ExportedTemplate,
  type ImportOptions,
  type ImportedBot,
  type TemplatePreview,
  type CatalogEntry,
} from "@deyin/host-core";
import type { BotSkillStores } from "./skills-handlers.js";

type NewRoutine = Omit<Automation, "id" | "createdAt" | "updatedAt">;

/** What the template handlers need of the person's routines. */
export interface TemplateRoutines {
  /** The routines a Bot has. */
  of(botId: string): Automation[];
  /** Make one. A refusal (too many, too often) is thrown with words a person can read. */
  create(input: NewRoutine): void;
}

export interface TemplateHandlerDeps {
  store: Pick<BotStore, "get" | "list" | "create" | "delete">;
  stores: BotSkillStores;
  routines: TemplateRoutines;
}

export interface TemplateHandlers {
  export(botId: unknown, options?: unknown): Promise<BotResult<ExportedTemplate>>;
  preview(text: unknown): Promise<BotResult<TemplatePreview>>;
  import(text: unknown, options: unknown): Promise<BotResult<ImportedBot>>;
  catalog(query?: unknown, category?: unknown): BotResult<CatalogListing>;
  importCatalog(id: unknown, options: unknown): Promise<BotResult<ImportedBot>>;
}

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new BotError("invalid", `${what} must be text.`);
  return value;
};

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BotError("invalid", `${what} must be an object.`);
  return value as Record<string, unknown>;
}

function importOptions(value: unknown): ImportOptions {
  const source = record(value, "The import choices");
  const model = typeof source.model === "string" ? source.model.trim() : "";
  const providerId = typeof source.providerId === "string" ? source.providerId.trim() : "";
  return { model, providerId };
}

/** The template inside whatever a person pasted: the template text itself, or a link that carries it. */
export function templateFromPasted(input: string): BotTemplate {
  const trimmed = input.trim();
  if (isTemplateLink(trimmed)) {
    const carried = parseTemplateLink(trimmed);
    if (carried === null) throw new BotError("invalid", "That link does not carry a Bot. Ask for it again, or paste the Bot's text instead.");
    return parseBotTemplate(carried);
  }
  return parseBotTemplate(trimmed);
}

/** The routines of a Bot that can travel: a prompt, on a schedule or by hand. Others stay behind, and are counted. */
function routinesFor(automations: readonly Automation[]): { routines: BotTemplateRoutine[]; left: number } {
  const routines: BotTemplateRoutine[] = [];
  let left = 0;
  for (const automation of automations) {
    if (automation.payload.kind !== "prompt") {
      left += 1;
      continue;
    }
    const { trigger } = automation;
    if (trigger.kind === "cron") {
      routines.push({ name: automation.name, ...(automation.description ? { description: automation.description } : {}), prompt: automation.payload.prompt, schedule: { kind: "cron", expression: trigger.expression } });
    } else if (trigger.kind === "manual") {
      routines.push({ name: automation.name, ...(automation.description ? { description: automation.description } : {}), prompt: automation.payload.prompt, schedule: { kind: "manual" } });
    } else {
      left += 1;
    }
  }
  return { routines, left };
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

function card(entry: CatalogEntry, have: ReadonlySet<string>): CatalogCard {
  return {
    id: entry.id,
    name: entry.template.name,
    title: entry.template.title,
    blurb: entry.blurb,
    category: entry.category,
    tags: entry.tags,
    skills: entry.template.skills.length,
    routines: entry.template.routines.length,
    have: have.has(entry.id),
    ...(entry.derivedFrom ? { derivedFrom: entry.derivedFrom } : {}),
  };
}

/**
 * Handing a Bot on and taking one in. Everything is checked before anything is made, and a Bot that cannot be finished
 * (a skill that will not save) is taken away again, so an import leaves a whole Bot or nothing at all.
 */
export function createTemplateHandlers(deps: TemplateHandlerDeps): TemplateHandlers {
  const { store, stores, routines } = deps;

  async function bring(template: BotTemplate, options: ImportOptions, origin?: string): Promise<ImportedBot> {
    const bot = store.create({ ...botInputFromTemplate(template), ...(origin ? { legacyBotId: `${CATALOG_ORIGIN_PREFIX}${origin}` } : {}) });
    const warnings: string[] = [];
    let skills = 0;
    let made = 0;
    try {
      const skillStore = stores.of(bot.id);
      for (const skill of template.skills) {
        await skillStore.save(skill, { author: "person", origin: "template" });
        skills += 1;
      }
      for (const routine of template.routines) {
        if (!options.model || !options.providerId) {
          warnings.push(`"${routine.name}" was not added: pick a model first, then add it from the Routines page.`);
          continue;
        }
        try {
          routines.create({
            botId: bot.id,
            name: routine.name,
            ...(routine.description ? { description: routine.description } : {}),
            // Paused: a routine that arrives with a Bot starts only when its new owner has read it and turned it on.
            enabled: false,
            payload: { kind: "prompt", prompt: routine.prompt },
            trigger: routine.schedule.kind === "cron" ? { kind: "cron", expression: routine.schedule.expression } : { kind: "manual" },
            target: { kind: "local", workspacePath: "" },
            model: options.model,
            providerId: options.providerId,
          });
          made += 1;
        } catch (error) {
          warnings.push(`"${routine.name}" was not added: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      // A half-made Bot is worse than none: take it, and anything made for it, away again.
      try {
        store.delete(bot.id);
      } finally {
        stores.forget(bot.id);
      }
      throw error;
    }
    if (made > 0) warnings.push(`${plural(made, "routine was", "routines were")} added paused. Turn on the ones you want from the Routines page.`);
    return { bot, skills, routines: made, warnings };
  }

  return {
    export: (botId, options) =>
      botResultAsync(async () => {
        const id = text(botId, "The Bot id");
        const bot = store.get(id);
        if (!bot) throw new BotError("not_found", "That Bot no longer exists.");
        if (bot.kind === "room") throw new BotError("invalid", `${bot.name} is a room. Share one of its Bots instead.`);
        const withRoutines = options === undefined ? true : record(options, "The export choices").includeRoutines !== false;
        const skills = await stores.of(id).all();
        const found = withRoutines ? routinesFor(routines.of(id)) : { routines: [], left: 0 };
        const template = makeBotTemplate({
          name: bot.name,
          title: bot.title,
          description: bot.description,
          role: bot.role,
          purpose: bot.purpose ?? "",
          publicDescription: bot.publicDescription ?? "",
          avatarShape: bot.avatarShape,
          avatarColor: bot.avatarColor,
          skills,
          routines: found.routines,
        });
        const warnings: string[] = [];
        if (found.left > 0) warnings.push(`${plural(found.left, "routine was", "routines were")} left out: only a routine that sends a prompt, on a schedule or by hand, can be shared.`);
        const link = templateLink(template);
        if (!link) warnings.push("This Bot is too big to fit in a link, so share its text or save it as a file instead.");
        return { text: stringifyBotTemplate(template), link, summary: summarizeTemplate(template), warnings };
      }),

    preview: (pasted) => botResultAsync(async () => ({ summary: summarizeTemplate(templateFromPasted(text(pasted, "The Bot"))) })),

    import: (pasted, options) =>
      botResultAsync(async () => {
        const template = templateFromPasted(text(pasted, "The Bot"));
        return bring(template, importOptions(options));
      }),

    catalog: (query, category) => {
      try {
        const words = typeof query === "string" ? query : "";
        const filter = isCatalogCategory(category) ? category : undefined;
        const mine = store.list({ includeArchived: true });
        const have = new Set(mine.flatMap((bot) => catalogOriginOf(bot.legacyBotId) ?? []));
        const interests = mine.map((bot) => [bot.name, bot.title, bot.description, bot.purpose].join(" "));
        return {
          ok: true,
          value: {
            forYou: forYou(BOT_CATALOG, { have, interests }).map((entry) => card(entry, have)),
            browse: searchCatalog(BOT_CATALOG, words, filter).map((entry) => card(entry, have)),
          },
        };
      } catch (error) {
        if (error instanceof BotError) return { ok: false, error: error.message, code: error.code };
        throw error;
      }
    },

    importCatalog: (id, options) =>
      botResultAsync(async () => {
        const entry = catalogEntry(text(id, "The starter"));
        if (!entry) throw new BotError("not_found", "That starter is no longer in the catalog.");
        return bring(entry.template, importOptions(options), entry.id);
      }),
  };
}
