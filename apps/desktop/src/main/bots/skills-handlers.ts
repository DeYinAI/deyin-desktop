import { join } from "node:path";
import {
  BotError,
  BotSkillStore,
  botResultAsync,
  type BotResult,
  type BotSkill,
  type BotSkillSummary,
  type BotStore,
  type SkillRevision,
} from "@deyin/host-core";

type BotLookup = Pick<BotStore, "get" | "dataDir">;

/**
 * Each Bot's skill store, made once. A store lines up the changes made through it so two saves cannot both start
 * from the same version; two stores over one folder would not, so everything that changes a Bot's skills in this
 * app (the Skills panel, an imported template, a task the person taught) goes through the one made here.
 */
export class BotSkillStores {
  private readonly stores = new Map<string, BotSkillStore>();

  constructor(private readonly bots: BotLookup) {}

  /** The Bot's skills. A Bot that is gone, or a room (which never works on its own), has none to keep. */
  of(botId: unknown): BotSkillStore {
    if (typeof botId !== "string") throw new BotError("invalid", "The Bot id must be text.");
    const bot = this.bots.get(botId);
    if (!bot) throw new BotError("not_found", "That Bot no longer exists.");
    if (bot.kind === "room") throw new BotError("invalid", `${bot.name} is a room. Skills belong to the Bots in it.`);
    let store = this.stores.get(botId);
    if (!store) {
      store = new BotSkillStore(join(this.bots.dataDir(botId), "skills"));
      this.stores.set(botId, store);
    }
    return store;
  }

  /** Let go of a Bot's store once the Bot is gone. */
  forget(botId: string): void {
    this.stores.delete(botId);
  }

  /** Keep the stores of these Bots only: for after the roster changed, so a deleted Bot's store does not stay held. */
  retain(botIds: Iterable<string>): void {
    const keep = new Set(botIds);
    for (const botId of [...this.stores.keys()]) if (!keep.has(botId)) this.stores.delete(botId);
  }
}

export interface BotSkillsHandlerDeps {
  stores: BotSkillStores;
  /** A Bot's skills changed: bring whatever keeps a copy of them (its routines on a server) up to date. */
  changed?(botId: string): void;
}

export interface BotSkillsHandlers {
  list(botId: unknown): Promise<BotResult<BotSkillSummary[]>>;
  get(botId: unknown, name: unknown): Promise<BotResult<BotSkill>>;
  save(botId: unknown, input: unknown, expectedVersion?: unknown): Promise<BotResult<BotSkill>>;
  remove(botId: unknown, name: unknown): Promise<BotResult<null>>;
  revisions(botId: unknown, name: unknown): Promise<BotResult<SkillRevision[]>>;
  revert(botId: unknown, name: unknown, revisionId: unknown): Promise<BotResult<BotSkill>>;
}

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new BotError("invalid", `${what} must be text.`);
  return value;
};

/**
 * The skills IPC handlers as plain functions. Arguments come from the renderer, so none is trusted to have the
 * declared type, and every outcome, a refusal included, is a `BotResult` rather than something thrown across IPC.
 */
export function createBotSkillsHandlers(deps: BotSkillsHandlerDeps): BotSkillsHandlers {
  const { stores } = deps;
  const announce = (botId: string): void => {
    try {
      deps.changed?.(botId);
    } catch {
      // Telling others is not part of the change: it is already made.
    }
  };
  return {
    list: (botId) => botResultAsync(() => stores.of(botId).list()),
    get: (botId, name) => botResultAsync(() => stores.of(botId).get(text(name, "The skill name"))),
    save: (botId, input, expectedVersion) =>
      botResultAsync(async () => {
        const version = typeof expectedVersion === "number" && Number.isInteger(expectedVersion) ? expectedVersion : undefined;
        const skill = await stores.of(botId).save(input, { author: "person", origin: "person", ...(version !== undefined ? { expectedVersion: version } : {}) });
        announce(botId as string);
        return skill;
      }),
    remove: (botId, name) =>
      botResultAsync(async () => {
        await stores.of(botId).remove(text(name, "The skill name"));
        announce(botId as string);
        return null;
      }),
    revisions: (botId, name) => botResultAsync(() => stores.of(botId).revisions(text(name, "The skill name"))),
    revert: (botId, name, revisionId) =>
      botResultAsync(async () => {
        const skill = await stores.of(botId).revert(text(name, "The skill name"), text(revisionId, "The earlier version"));
        announce(botId as string);
        return skill;
      }),
  };
}
