import { join } from "node:path";
import { MemoryStore, rankMemoryFacts, type MemoryFact, type MemoryInput, type MemoryRecallHit, type MemoryScope } from "../memory.js";
import { BotError, isSafeBotId } from "./types.js";

/** Directory (under a storage dir) that holds the facts every Bot can see. Not a valid Bot id. */
export const SHARED_BOT_MEMORY_DIR = "_shared";

type FactPatch = Partial<Pick<MemoryFact, "title" | "description" | "type" | "scope" | "body">>;

/** MemoryStore reports problems as plain errors; a Bot's callers expect a `BotError` with the same words. */
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof BotError) throw error;
    throw new BotError("conflict", error instanceof Error ? error.message : String(error));
  }
}

/**
 * One Bot's view of memory: its own facts plus the few facts shared across all Bots (name, timezone).
 *
 * It reuses the memory tools' existing vocabulary instead of adding a new one. A fact with scope
 * `project` belongs to this Bot alone; a fact with scope `global` is shared by every Bot. So the
 * `remember` tool, recall and the memory UI work unchanged, and a Bot saying `scope: "global"` is exactly
 * a Bot choosing to share something.
 *
 * Two Bots never see each other's own facts, and a Bot never sees Deyin Code's workspace memory. The
 * scope written inside a fact file is always forced to match where the file lives, so a hand-edited
 * file cannot make a private fact claim to be shared.
 *
 * Structurally satisfies agent-core's `MemoryBridge`.
 */
export class BotMemory {
  private readonly own: MemoryStore;
  private readonly shared: MemoryStore;

  /** `botsDir` is `<storage>/bots`, the directory holding one folder per Bot. */
  constructor(botsDir: string, botId: string) {
    if (!isSafeBotId(botId)) throw new BotError("invalid", "That is not a valid Bot id.");
    this.own = new MemoryStore(join(botsDir, botId));
    this.shared = new MemoryStore(join(botsDir, SHARED_BOT_MEMORY_DIR));
  }

  private tag(fact: MemoryFact, scope: MemoryScope): MemoryFact {
    return fact.scope === scope ? fact : { ...fact, scope };
  }

  private activeOwn(): MemoryFact[] {
    return this.own.list().map((fact) => this.tag(fact, "project"));
  }

  private activeShared(): MemoryFact[] {
    return this.shared.list().map((fact) => this.tag(fact, "global"));
  }

  /** The store a ref lives in (this Bot's own first), or undefined. */
  private locate(ref: string): { store: MemoryStore; scope: MemoryScope; fact: MemoryFact } | undefined {
    const own = this.own.read(ref);
    if (own) return { store: this.own, scope: "project", fact: this.tag(own, "project") };
    const shared = this.shared.read(ref);
    if (shared) return { store: this.shared, scope: "global", fact: this.tag(shared, "global") };
    return undefined;
  }

  list(): MemoryFact[] {
    return [...this.activeOwn(), ...this.activeShared()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  read(ref: string): MemoryFact | undefined {
    return this.locate(ref)?.fact;
  }

  search(query: string, limit = 8): MemoryRecallHit[] {
    return rankMemoryFacts(query, this.list()).slice(0, limit);
  }

  create(input: MemoryInput): MemoryFact {
    const scope: MemoryScope = input.scope === "global" ? "global" : "project";
    const store = scope === "global" ? this.shared : this.own;
    const probe = input.name ?? input.title;
    // A name is unique across what this Bot can see, so a ref never means two facts.
    if (probe && this.read(probe)) throw new BotError("conflict", `A memory fact named "${probe}" already exists.`);
    return this.tag(guarded(() => store.create({ ...input, scope })), scope);
  }

  update(ref: string, patch: FactPatch, expectedRevision?: number): MemoryFact {
    const found = this.locate(ref);
    if (!found) throw new BotError("not_found", `Memory fact "${ref}" not found.`);
    const target: MemoryScope = patch.scope === "global" ? "global" : patch.scope === "project" ? "project" : found.scope;
    if (target === found.scope) {
      return this.tag(guarded(() => found.store.update(ref, { ...patch, scope: found.scope }, expectedRevision)), found.scope);
    }

    // Sharing or unsharing moves the fact between stores. The copy is made before the original is
    // archived, so a failure part-way leaves the fact in both places rather than in neither.
    if (expectedRevision !== undefined && found.fact.revision !== expectedRevision) {
      throw new BotError("conflict", `Memory fact "${ref}" changed (revision ${found.fact.revision}, expected ${expectedRevision}).`);
    }
    const destination = target === "global" ? this.shared : this.own;
    if (destination.read(found.fact.name)) {
      throw new BotError("conflict", `A ${target === "global" ? "shared" : "private"} fact named "${found.fact.name}" already exists.`);
    }
    const moved = guarded(() =>
      destination.create({
        name: found.fact.name,
        title: patch.title ?? found.fact.title,
        description: patch.description ?? found.fact.description,
        type: patch.type ?? found.fact.type,
        scope: target,
        body: patch.body ?? found.fact.body,
      }),
    );
    guarded(() => found.store.forget(found.fact.name));
    return this.tag(moved, target);
  }

  forget(ref: string): void {
    const found = this.locate(ref);
    if (!found) throw new BotError("not_found", `Memory fact "${ref}" not found.`);
    guarded(() => found.store.forget(found.fact.name));
  }

  archived(): MemoryFact[] {
    return [...this.own.archived().map((f) => this.tag(f, "project")), ...this.shared.archived().map((f) => this.tag(f, "global"))].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  recover(ref: string): MemoryFact {
    const own = this.own.archived().find((f) => f.id === ref || f.name === ref);
    if (own) return this.tag(guarded(() => this.own.recover(own.id)), "project");
    const shared = this.shared.archived().find((f) => f.id === ref || f.name === ref);
    if (shared) return this.tag(guarded(() => this.shared.recover(shared.id)), "global");
    throw new BotError("not_found", `Archived memory fact "${ref}" not found.`);
  }

  /** Number of active facts this Bot can see. */
  count(): number {
    return this.own.count() + this.shared.count();
  }
}
