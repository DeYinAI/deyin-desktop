import {
  BotError,
  BotMemory,
  botResult,
  type BotInput,
  type BotMemoryFactView,
  type BotPatch,
  type BotResult,
  type BotRosterLayout,
  type BotStore,
  type BotsSnapshot,
  type DeyinBot,
  type MemoryFact,
} from "@deyin/host-core";

export interface BotsHandlerDeps {
  store: BotStore;
  /** `<userData>/bots`, the directory holding one folder per Bot. */
  botsDir: string;
  /** Delete every conversation a Bot had, returning how many. Called after the Bot is gone. */
  removeSessions(botId: string): number;
  /** Delete every routine a Bot owned, stopping any in flight, returning how many. Called after the Bot is gone. */
  removeRoutines(botId: string): number;
  /** Take back every permission the Bot had in the Vault. Called after the Bot is gone. */
  removeVaultGrants?(botId: string): void;
  /** Close every way into a Bot from outside, and forget its connections, secrets and waiting posts. Called after the Bot is gone. */
  removeSurfaces?(botId: string): void;
  /** Forget a Bot that lived on a server there: its files, routines and records. Called after the Bot is gone; best effort. */
  removeFromServer?(bot: DeyinBot): void;
}

export interface BotsHandlers {
  list(): BotsSnapshot;
  create(input: unknown): BotResult<DeyinBot>;
  update(id: unknown, patch: unknown): BotResult<DeyinBot>;
  archive(id: unknown): BotResult<DeyinBot>;
  restore(id: unknown): BotResult<DeyinBot>;
  delete(id: unknown): BotResult<null>;
  setPrimary(id: unknown): BotResult<DeyinBot>;
  setPinned(id: unknown, pinned: unknown): BotResult<BotRosterLayout>;
  setHidden(id: unknown, hidden: unknown): BotResult<BotRosterLayout>;
  addSection(name: unknown): BotResult<BotRosterLayout>;
  renameSection(sectionId: unknown, name: unknown): BotResult<BotRosterLayout>;
  removeSection(sectionId: unknown): BotResult<BotRosterLayout>;
  moveToSection(id: unknown, sectionId: unknown): BotResult<BotRosterLayout>;
  memoryList(id: unknown): BotResult<BotMemoryFactView[]>;
  memoryForget(id: unknown, ref: unknown): BotResult<null>;
  memoryShare(id: unknown, ref: unknown, shared: unknown): BotResult<BotMemoryFactView>;
}

function toMemoryView(fact: MemoryFact): BotMemoryFactView {
  return {
    id: fact.id,
    name: fact.name,
    title: fact.title,
    description: fact.description,
    type: fact.type,
    shared: fact.scope === "global",
    revision: fact.revision,
    updatedAt: fact.updatedAt,
    body: fact.body,
  };
}

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new BotError("invalid", `${what} must be text.`);
  return value;
};

const record = <T extends object>(value: unknown, what: string): T => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BotError("invalid", `${what} must be an object.`);
  return value as T;
};

/**
 * The Bot IPC handlers as plain functions over their dependencies.
 *
 * IPC arguments come from the renderer, so none is trusted to have the declared type: each is checked
 * before it reaches the store, and every outcome, including a refusal, is returned as a `BotResult`
 * rather than thrown across the IPC boundary.
 */
export function createBotsHandlers(deps: BotsHandlerDeps): BotsHandlers {
  const { store } = deps;

  /** Memory is only opened for a Bot that exists, so a bad id cannot create directories. */
  const memoryOf = (id: unknown): BotMemory => {
    const botId = text(id, "The Bot id");
    if (!store.get(botId)) throw new BotError("not_found", "That Bot no longer exists.");
    return new BotMemory(deps.botsDir, botId);
  };

  return {
    list: () => store.snapshot(),
    create: (input) => botResult(() => store.create(record<BotInput>(input, "The Bot"))),
    update: (id, patch) => botResult(() => store.update(text(id, "The Bot id"), record<BotPatch>(patch, "The changes"))),
    archive: (id) => botResult(() => store.archive(text(id, "The Bot id"))),
    restore: (id) => botResult(() => store.restore(text(id, "The Bot id"))),
    delete: (id) =>
      botResult(() => {
        const botId = text(id, "The Bot id");
        const gone = store.get(botId);
        store.delete(botId);
        // The Bot is gone first, so a failure cleaning up conversations cannot leave a Bot with none. Its routines
        // go next so none fires against a Bot that no longer exists; a failure there must not strand its conversations.
        try {
          deps.removeRoutines(botId);
        } finally {
          try {
            deps.removeVaultGrants?.(botId);
          } finally {
            try {
              deps.removeSurfaces?.(botId);
            } finally {
              try {
                if (gone) deps.removeFromServer?.(gone);
              } finally {
                deps.removeSessions(botId);
              }
            }
          }
        }
        return null;
      }),
    setPrimary: (id) => botResult(() => store.setPrimary(text(id, "The Bot id"))),
    setPinned: (id, pinned) => botResult(() => store.setPinned(text(id, "The Bot id"), pinned === true)),
    setHidden: (id, hidden) => botResult(() => store.setHidden(text(id, "The Bot id"), hidden === true)),
    addSection: (name) => botResult(() => store.addSection(text(name, "The section name"))),
    renameSection: (sectionId, name) =>
      botResult(() => store.renameSection(text(sectionId, "The section id"), text(name, "The section name"))),
    removeSection: (sectionId) => botResult(() => store.removeSection(text(sectionId, "The section id"))),
    moveToSection: (id, sectionId) =>
      botResult(() => store.moveToSection(text(id, "The Bot id"), sectionId === null ? null : text(sectionId, "The section id"))),
    memoryList: (id) => botResult(() => memoryOf(id).list().map(toMemoryView)),
    memoryForget: (id, ref) =>
      botResult(() => {
        memoryOf(id).forget(text(ref, "The memory reference"));
        return null;
      }),
    memoryShare: (id, ref, shared) =>
      botResult(() => toMemoryView(memoryOf(id).update(text(ref, "The memory reference"), { scope: shared === true ? "global" : "project" }))),
  };
}
