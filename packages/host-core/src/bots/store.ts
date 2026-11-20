import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "../storage.js";
import { defaultBotAvatar } from "./avatar.js";
import {
  addBotSection,
  moveBotToSection,
  removeBotSection,
  renameBotSection,
  setBotHidden,
  setBotPinned,
  type BotRosterLayout,
} from "./layout.js";
import { EMPTY_BOTS_STATE, normalizeBotsState, settleBotsState, type BotsSnapshot, type BotsState } from "./state.js";
import {
  BOT_LIMITS,
  DEFAULT_BOT_ROLE,
  BotError,
  checkBotFields,
  cleanBotLine,
  cleanBotText,
  isSafeBotId,
  uniqueBotHandle,
  type BotInput,
  type BotPatch,
  type DeyinBot,
} from "./types.js";

const FILE = "bots.json";

export interface BotStoreOptions {
  now?: () => number;
  /** Id source, injectable so tests do not depend on randomness. */
  newId?: () => string;
}

type StorageLike = Pick<Storage, "dir" | "readJson" | "writeJson">;

const defaultNewId = (): string => `bot_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/**
 * Deyin Bots on disk (`bots.json`) plus each Bot's data directory (`<dir>/bots/<id>/`, which holds its
 * memory and, later, its files). Every change is applied to a draft and settled by `settleBotsState`, so
 * the primary Bot, room membership, handles and the roster layout stay consistent without each
 * operation re-implementing the cascade.
 */
export class BotStore {
  private state: BotsState;
  private readonly listeners = new Set<(snapshot: BotsSnapshot) => void>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly storage: StorageLike,
    opts: BotStoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? defaultNewId;
    const { state, changed } = normalizeBotsState(storage.readJson<unknown>(FILE, EMPTY_BOTS_STATE));
    this.state = state;
    if (changed) this.persist();
  }

  /* Reads ----------------------------------------------------------------- */

  snapshot(): BotsSnapshot {
    return { bots: this.state.bots, layout: this.state.layout };
  }

  list(opts: { includeArchived?: boolean } = {}): DeyinBot[] {
    return opts.includeArchived ? this.state.bots : this.state.bots.filter((bot) => !bot.archived);
  }

  get(id: string): DeyinBot | undefined {
    return this.state.bots.find((bot) => bot.id === id);
  }

  getByHandle(handle: string): DeyinBot | undefined {
    const wanted = handle.replace(/^@/, "").toLowerCase();
    return this.state.bots.find((bot) => bot.handle === wanted);
  }

  /** The Bot that coordinates the others, or undefined when there is no active agent. */
  primary(): DeyinBot | undefined {
    return this.state.bots.find((bot) => bot.isPrimary);
  }

  /** Where one Bot keeps its memory and files. Refuses ids that could escape the Bots directory. */
  dataDir(id: string): string {
    if (!isSafeBotId(id)) throw new BotError("invalid", "That is not a valid Bot id.");
    return join(this.storage.dir, "bots", id);
  }

  onChange(listener: (snapshot: BotsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* Bots ------------------------------------------------------------------ */

  create(input: BotInput): DeyinBot {
    const problem = checkBotFields(input, "create");
    if (problem) throw new BotError("invalid", problem);
    if (this.list().length >= BOT_LIMITS.maxBots) {
      throw new BotError("limit", `You can have at most ${BOT_LIMITS.maxBots} Bots. Archive or delete one first.`);
    }
    const kind = input.kind ?? "agent";
    if (kind === "room" && input.harness === "server") {
      throw new BotError("invalid", "A room runs on this computer. Its Bots answer here, as part of it.");
    }
    const members = kind === "room" ? this.checkRoomMembers(input.memberBotIds ?? []) : [];
    if (kind === "agent" && input.memberBotIds && input.memberBotIds.length > 0) {
      throw new BotError("invalid", "Only a room has members.");
    }

    let id = this.newId();
    while (this.get(id)) id = this.newId();
    const name = cleanBotLine(input.name);
    const avatar = defaultBotAvatar(id);
    const now = this.now();
    const harness = input.harness ?? "local";

    const bot: DeyinBot = {
      id,
      name,
      handle: uniqueBotHandle(name, new Set(this.state.bots.map((b) => b.handle))),
      description: cleanBotText(input.description),
      title: cleanBotLine(input.title),
      avatarShape: input.avatarShape ?? avatar.shape,
      avatarColor: input.avatarColor ?? avatar.color,
      avatarVersion: 1,
      createdAt: now,
      updatedAt: now,
      harness,
      role: cleanBotLine(input.role) || DEFAULT_BOT_ROLE,
      visibility: "owner",
      kind,
      memberBotIds: members,
      autoReview: { approvalMode: input.approvalMode ?? "auto_review" },
      isPrimary: false,
      archived: false,
      ...(harness === "server" ? { hostId: cleanBotLine(input.hostId) } : {}),
      ...(input.legacyBotId ? { legacyBotId: input.legacyBotId } : {}),
      ...(cleanBotText(input.purpose) ? { purpose: cleanBotText(input.purpose) } : {}),
      ...(cleanBotText(input.publicDescription) ? { publicDescription: cleanBotText(input.publicDescription) } : {}),
      ...(input.routinePolicy ? { routinePolicy: input.routinePolicy } : {}),
    };
    this.commit({ bots: [...this.state.bots, bot] });
    return this.require(id);
  }

  update(id: string, patch: BotPatch): DeyinBot {
    const existing = this.require(id);
    if (existing.archived) throw new BotError("conflict", "Restore this Bot before editing it.");
    const problem = checkBotFields(patch, "update");
    if (problem) throw new BotError("invalid", problem);

    const harness = patch.harness ?? existing.harness;
    if (existing.kind === "room" && harness === "server") {
      throw new BotError("invalid", "A room runs on this computer. Its Bots answer here, as part of it.");
    }
    if (patch.hostId !== undefined && harness !== "server") {
      throw new BotError("invalid", "Choose a server to run on before naming a host.");
    }
    if (harness === "server" && !cleanBotLine(patch.hostId ?? existing.hostId)) {
      throw new BotError("invalid", "A Bot that runs on a server needs the server to run on.");
    }
    if (patch.memberBotIds !== undefined && existing.kind === "agent" && patch.memberBotIds.length > 0) {
      throw new BotError("invalid", "Only a room has members.");
    }
    const members = existing.kind === "room" && patch.memberBotIds !== undefined ? this.checkRoomMembers(patch.memberBotIds, id) : existing.memberBotIds;

    const name = patch.name !== undefined ? cleanBotLine(patch.name) : existing.name;
    const taken = new Set(this.state.bots.filter((b) => b.id !== id).map((b) => b.handle));
    const avatarChanged =
      patch.avatarShape !== undefined || patch.avatarColor !== undefined || patch.avatarUrl !== undefined;

    const next: DeyinBot = {
      ...existing,
      name,
      handle: name === existing.name ? existing.handle : uniqueBotHandle(name, taken),
      description: patch.description !== undefined ? cleanBotText(patch.description) : existing.description,
      title: patch.title !== undefined ? cleanBotLine(patch.title) : existing.title,
      avatarShape: patch.avatarShape ?? existing.avatarShape,
      avatarColor: patch.avatarColor ?? existing.avatarColor,
      avatarVersion: avatarChanged ? existing.avatarVersion + 1 : existing.avatarVersion,
      updatedAt: this.now(),
      harness,
      role: patch.role !== undefined ? cleanBotLine(patch.role) || DEFAULT_BOT_ROLE : existing.role,
      memberBotIds: members,
      purpose: patch.purpose !== undefined ? cleanBotText(patch.purpose) || undefined : existing.purpose,
      publicDescription:
        patch.publicDescription !== undefined ? cleanBotText(patch.publicDescription) || undefined : existing.publicDescription,
      autoReview: { ...existing.autoReview, approvalMode: patch.approvalMode ?? existing.autoReview.approvalMode },
      routinePolicy: patch.routinePolicy ?? existing.routinePolicy,
    };
    if (harness === "server") next.hostId = cleanBotLine(patch.hostId ?? existing.hostId);
    else delete next.hostId;
    if (patch.avatarUrl === null) delete next.avatarUrl;
    else if (patch.avatarUrl !== undefined) next.avatarUrl = patch.avatarUrl;

    this.commit({ bots: this.state.bots.map((bot) => (bot.id === id ? next : bot)) });
    return this.require(id);
  }

  archive(id: string): DeyinBot {
    const existing = this.require(id);
    if (existing.archived) return existing;
    this.commit({ bots: this.state.bots.map((bot) => (bot.id === id ? { ...bot, archived: true, updatedAt: this.now() } : bot)) });
    return this.require(id);
  }

  restore(id: string): DeyinBot {
    const existing = this.require(id);
    if (!existing.archived) return existing;
    if (existing.kind === "room") {
      const live = existing.memberBotIds.filter((memberId) => {
        const member = this.get(memberId);
        return member && member.kind === "agent" && !member.archived;
      });
      if (live.length < BOT_LIMITS.minRoomMembers) {
        throw new BotError("conflict", "This room needs at least two active Bots. Restore its Bots first.");
      }
    } else if (this.list().length >= BOT_LIMITS.maxBots) {
      throw new BotError("limit", `You can have at most ${BOT_LIMITS.maxBots} Bots. Archive or delete one first.`);
    }
    this.commit({ bots: this.state.bots.map((bot) => (bot.id === id ? { ...bot, archived: false, updatedAt: this.now() } : bot)) });
    return this.require(id);
  }

  /** Permanently removes a Bot and everything it remembers. Archive instead to keep it recoverable. */
  delete(id: string): void {
    this.require(id);
    this.commit({ bots: this.state.bots.filter((bot) => bot.id !== id) });
    rmSync(this.dataDir(id), { recursive: true, force: true });
  }

  setPrimary(id: string): DeyinBot {
    const bot = this.require(id);
    if (bot.archived) throw new BotError("conflict", "Restore this Bot before making it the primary Bot.");
    if (bot.kind !== "agent") throw new BotError("invalid", "A room cannot be the primary Bot.");
    this.commit({ bots: this.state.bots.map((b) => ({ ...b, isPrimary: b.id === id })) });
    return this.require(id);
  }

  /* Roster layout --------------------------------------------------------- */

  layout(): BotRosterLayout {
    return this.state.layout;
  }

  setPinned(id: string, pinned: boolean): BotRosterLayout {
    this.require(id);
    return this.commitLayout(setBotPinned(this.state.layout, id, pinned));
  }

  setHidden(id: string, hidden: boolean): BotRosterLayout {
    this.require(id);
    return this.commitLayout(setBotHidden(this.state.layout, id, hidden));
  }

  addSection(name: string): BotRosterLayout {
    return this.commitLayout(addBotSection(this.state.layout, `sec_${randomUUID().slice(0, 8)}`, name));
  }

  renameSection(sectionId: string, name: string): BotRosterLayout {
    return this.commitLayout(renameBotSection(this.state.layout, sectionId, name));
  }

  removeSection(sectionId: string): BotRosterLayout {
    return this.commitLayout(removeBotSection(this.state.layout, sectionId));
  }

  moveToSection(id: string, sectionId: string | null): BotRosterLayout {
    this.require(id);
    return this.commitLayout(moveBotToSection(this.state.layout, id, sectionId));
  }

  /* Internals ------------------------------------------------------------- */

  private require(id: string): DeyinBot {
    const bot = this.get(id);
    if (!bot) throw new BotError("not_found", "That Bot no longer exists.");
    return bot;
  }

  /** Validates a room's members: at least two distinct, existing, active agents, never the room itself. */
  private checkRoomMembers(ids: readonly string[], roomId?: string): string[] {
    const members = [...new Set(ids)];
    if (members.length < BOT_LIMITS.minRoomMembers) {
      throw new BotError("invalid", `A room needs at least ${BOT_LIMITS.minRoomMembers} Bots.`);
    }
    if (members.length > BOT_LIMITS.maxRoomMembers) {
      throw new BotError("limit", `A room holds at most ${BOT_LIMITS.maxRoomMembers} Bots.`);
    }
    for (const memberId of members) {
      const member = this.get(memberId);
      if (!member || memberId === roomId) throw new BotError("not_found", "A Bot in this room no longer exists.");
      if (member.kind !== "agent") throw new BotError("invalid", "A room can only hold Bots, not other rooms.");
      if (member.archived) throw new BotError("conflict", `${member.name} is archived. Restore it before adding it to a room.`);
    }
    return members;
  }

  private commit(draft: { bots: readonly DeyinBot[]; layout?: BotRosterLayout }): void {
    this.state = settleBotsState({ bots: draft.bots, layout: draft.layout ?? this.state.layout });
    this.persist();
    this.emit();
  }

  private commitLayout(layout: BotRosterLayout): BotRosterLayout {
    this.commit({ bots: this.state.bots, layout });
    return this.state.layout;
  }

  private persist(): void {
    this.storage.writeJson(FILE, this.state);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
