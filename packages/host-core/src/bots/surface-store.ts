import { randomUUID } from "node:crypto";
import { PLAIN_CIPHER_PREFIX, type Storage } from "../storage.js";
import { BotError } from "./types.js";
import {
  DEFAULT_HUB_SETTINGS,
  SURFACE_LIMITS,
  SURFACE_SHAPES,
  clipText,
  isOutboxPost,
  isSurfaceKind,
  missingForSurface,
  parseHubSettings,
  parseSurfaceInput,
  postProblem,
  secretNames,
  type HubSettings,
  type OutboxPost,
  type SurfaceConfig,
  type SurfaceKind,
  type SurfaceSaved,
  type SurfaceView,
} from "./surfaces.js";
import { generateSurfaceKey } from "./surface-verify.js";

const SURFACES_FILE = "bot-surfaces.json";
const OUTBOX_FILE = "bot-outbox.json";

type StorageLike = Pick<Storage, "readJson" | "writeJson" | "cipher">;

interface StoredSurface extends SurfaceConfig {
  /** Each secret, put through the host's cipher. */
  secrets: Record<string, string>;
}

function isStoredSurface(value: unknown): value is StoredSurface {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.botId === "string" &&
    isSurfaceKind(v.surface) &&
    typeof v.routineId === "string" &&
    typeof v.enabled === "boolean" &&
    Array.isArray(v.allow) &&
    v.allow.every((entry) => typeof entry === "string") &&
    typeof v.settings === "object" &&
    v.settings !== null &&
    typeof v.secrets === "object" &&
    v.secrets !== null &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number"
  );
}

function readHub(value: unknown): HubSettings {
  try {
    return parseHubSettings(value ?? {});
  } catch {
    return { ...DEFAULT_HUB_SETTINGS };
  }
}

export interface SurfaceStoreOptions {
  now?: () => number;
  /** Makes a key for a webhook or an email sender; replaceable so a test can know it. */
  makeKey?: () => string;
}

/**
 * Each Bot's surfaces on disk. Secrets are encrypted with the host's cipher and are never returned by `list` or `get`;
 * the only way to read one is `secret`, which the hub uses to check or answer a request. A refused change leaves the
 * file untouched.
 */
export class SurfaceStore {
  private items: StoredSurface[];
  private hub: HubSettings;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly makeKey: () => string;

  constructor(
    private readonly storage: StorageLike,
    options: SurfaceStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.makeKey = options.makeKey ?? (() => generateSurfaceKey());
    const file = storage.readJson<{ surfaces?: unknown; hub?: unknown }>(SURFACES_FILE, {});
    this.items = Array.isArray(file.surfaces) ? file.surfaces.filter(isStoredSurface) : [];
    this.hub = readHub(file.hub);
  }

  hubSettings(): HubSettings {
    return { ...this.hub };
  }

  /** Where the hub listens and the public address shown for it. A bad value is refused and nothing changes. */
  setHubSettings(input: unknown): HubSettings {
    this.hub = parseHubSettings(input);
    this.persist();
    return this.hubSettings();
  }

  /** Whether secrets are encrypted by the operating system, or only protected by file permissions. */
  protection(): "encrypted" | "file-permissions" {
    try {
      return this.storage.cipher.encrypt("surface-probe").startsWith(PLAIN_CIPHER_PREFIX) ? "file-permissions" : "encrypted";
    } catch {
      return "file-permissions";
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(): void {
    this.storage.writeJson(SURFACES_FILE, { surfaces: this.items, hub: this.hub });
    for (const listener of this.listeners) listener();
  }

  private view(item: StoredSurface): SurfaceView {
    const has: Record<string, boolean> = {};
    // A secret that can no longer be read (the keychain was reset) counts as missing, so the surface asks for it again
    // instead of looking ready while every request it gets is refused.
    for (const name of secretNames(item.surface)) has[name] = this.reveal(item, name) !== null;
    const { secrets: _secrets, ...config } = item;
    return { ...config, allow: [...item.allow], settings: { ...item.settings }, has, missing: missingForSurface(item.surface, item, has) };
  }

  list(botId: string): SurfaceView[] {
    return this.items
      .filter((item) => item.botId === botId)
      .map((item) => this.view(item))
      .sort((a, b) => a.surface.localeCompare(b.surface));
  }

  get(botId: string, kind: SurfaceKind): SurfaceView | null {
    const item = this.items.find((candidate) => candidate.botId === botId && candidate.surface === kind);
    return item ? this.view(item) : null;
  }

  /** Every surface that is on and has everything it needs: what the hub serves. */
  active(): SurfaceView[] {
    return this.items.map((item) => this.view(item)).filter((view) => view.enabled && view.missing.length === 0);
  }

  /** One secret in the clear, for the hub. Null when it is not there or cannot be read. */
  secret(botId: string, kind: SurfaceKind, name: string): string | null {
    return this.reveal(
      this.items.find((candidate) => candidate.botId === botId && candidate.surface === kind),
      name,
    );
  }

  private reveal(item: StoredSurface | undefined, name: string): string | null {
    const stored = item?.secrets[name];
    if (!stored) return null;
    try {
      const plain = this.storage.cipher.decrypt(stored);
      return plain === null || plain === "" ? null : plain;
    } catch {
      return null;
    }
  }

  /** Every secret the store holds, for scrubbing a log or a result of anything that could carry one. */
  allSecrets(): string[] {
    const found: string[] = [];
    for (const item of this.items) {
      for (const name of Object.keys(item.secrets)) {
        const plain = this.secret(item.botId, item.surface, name);
        if (plain !== null) found.push(plain);
      }
    }
    return found;
  }

  private seal(secrets: Readonly<Record<string, string>>): Record<string, string> {
    const sealed: Record<string, string> = {};
    for (const [name, value] of Object.entries(secrets)) sealed[name] = this.storage.cipher.encrypt(value);
    return sealed;
  }

  /**
   * Save what a person filled in for a surface. A secret left empty keeps what is saved. A surface cannot be turned on
   * while something it needs is missing; the refusal says what.
   */
  save(botId: string, kind: SurfaceKind, input: unknown): SurfaceSaved {
    const draft = parseSurfaceInput(kind, input);
    const existing = this.items.find((candidate) => candidate.botId === botId && candidate.surface === kind);
    const now = this.now();
    const generated: Record<string, string> = {};
    const secrets: Record<string, string> = { ...(existing?.secrets ?? {}), ...this.seal(draft.secrets) };
    for (const name of SURFACE_SHAPES[kind].generated) {
      if (!secrets[name]) {
        const value = this.makeKey();
        generated[name] = value;
        secrets[name] = this.storage.cipher.encrypt(value);
      }
    }
    const saved: StoredSurface = {
      botId,
      surface: kind,
      routineId: draft.routineId,
      enabled: draft.enabled,
      allow: draft.allow,
      // A setting left empty is cleared: what is shown is what is saved.
      settings: draft.settings,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      secrets,
    };
    const view = this.view(saved);
    if (saved.enabled && view.missing.length > 0) {
      throw new BotError("invalid", `Finish setting this up before turning it on. Still needed: ${view.missing.join(", ")}.`);
    }
    this.items = [...this.items.filter((candidate) => candidate !== existing), saved];
    this.persist();
    return { view, generated };
  }

  /** Make a new key for a webhook or an email sender. The old one stops working at once; the new one is returned once. */
  remake(botId: string, kind: SurfaceKind, name: string): { view: SurfaceView; value: string } {
    const existing = this.items.find((candidate) => candidate.botId === botId && candidate.surface === kind);
    if (!existing) throw new BotError("not_found", "Set this surface up first.");
    if (!SURFACE_SHAPES[kind].generated.includes(name)) throw new BotError("invalid", `A ${name} of this surface cannot be made here.`);
    const value = this.makeKey();
    const next: StoredSurface = { ...existing, updatedAt: this.now(), secrets: { ...existing.secrets, [name]: this.storage.cipher.encrypt(value) } };
    this.items = this.items.map((candidate) => (candidate === existing ? next : candidate));
    this.persist();
    return { view: this.view(next), value };
  }

  /** Turn a surface off without forgetting how it was set up. */
  setEnabled(botId: string, kind: SurfaceKind, enabled: boolean): SurfaceView {
    const existing = this.items.find((candidate) => candidate.botId === botId && candidate.surface === kind);
    if (!existing) throw new BotError("not_found", "That surface is not set up.");
    const next: StoredSurface = { ...existing, enabled, updatedAt: this.now() };
    const view = this.view(next);
    if (enabled && view.missing.length > 0) throw new BotError("invalid", `Finish setting this up before turning it on. Still needed: ${view.missing.join(", ")}.`);
    this.items = this.items.map((candidate) => (candidate === existing ? next : candidate));
    this.persist();
    return view;
  }

  remove(botId: string, kind: SurfaceKind): void {
    const before = this.items.length;
    this.items = this.items.filter((candidate) => !(candidate.botId === botId && candidate.surface === kind));
    if (this.items.length !== before) this.persist();
  }

  /** A Bot that is deleted takes its surfaces, and every secret with them. */
  removeBot(botId: string): void {
    const before = this.items.length;
    this.items = this.items.filter((candidate) => candidate.botId !== botId);
    if (this.items.length !== before) this.persist();
  }

  /** A routine that is deleted leaves its surfaces switched off, not pointing at nothing. */
  routineRemoved(routineId: string): void {
    let changed = false;
    this.items = this.items.map((item) => {
      if (item.routineId !== routineId) return item;
      changed = true;
      return { ...item, routineId: "", enabled: false, updatedAt: this.now() };
    });
    if (changed) this.persist();
  }
}

/* The Outbox ---------------------------------------------------------------------- */

export interface OutboxDraft {
  botId: string;
  inReplyTo: string;
  context: string;
  author: string;
  text: string;
}

const KEEP_DECIDED = 200;

/**
 * What a Bot wants to say in public, waiting for a person. A draft is only ever posted by `approve`, which the person
 * triggers, and it posts the text as it stands then. Decided posts are kept for a while as a record.
 */
export class Outbox {
  private posts: OutboxPost[];
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly storage: Pick<Storage, "readJson" | "writeJson">,
    options: { now?: () => number; newId?: () => string } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    const file = storage.readJson<{ posts?: unknown }>(OUTBOX_FILE, {});
    this.posts = Array.isArray(file.posts) ? file.posts.filter(isOutboxPost) : [];
    // A post that was being sent when the app closed may or may not have gone; it is never sent again on a guess.
    for (const post of this.posts) {
      if (post.status === "posting") {
        post.status = "failed";
        post.error = "The app closed before it was known whether this was posted. Look on X before posting it again.";
      }
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(): void {
    // The oldest decided posts go first; a pending one is never dropped to make room.
    const pending = this.posts.filter((post) => post.status === "pending");
    const decided = this.posts.filter((post) => post.status !== "pending").sort((a, b) => (a.decidedAt ?? a.createdAt) - (b.decidedAt ?? b.createdAt));
    this.posts = [...decided.slice(-KEEP_DECIDED), ...pending].sort((a, b) => a.createdAt - b.createdAt);
    this.storage.writeJson(OUTBOX_FILE, { posts: this.posts });
    for (const listener of this.listeners) listener();
  }

  list(botId?: string): OutboxPost[] {
    return this.posts
      .filter((post) => botId === undefined || post.botId === botId)
      .map((post) => ({ ...post }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): OutboxPost | null {
    const post = this.posts.find((candidate) => candidate.id === id);
    return post ? { ...post } : null;
  }

  pendingCount(botId?: string): number {
    return this.posts.filter((post) => post.status === "pending" && (botId === undefined || post.botId === botId)).length;
  }

  /** Add a draft. A second draft for a post that already has one waiting or posted is refused, so a Bot cannot pile up replies. */
  add(draft: OutboxDraft): OutboxPost {
    if (this.pendingCount() >= SURFACE_LIMITS.outbox) throw new BotError("limit", `There are already ${SURFACE_LIMITS.outbox} posts waiting. Decide on some first.`);
    if (this.posts.some((post) => post.botId === draft.botId && post.inReplyTo === draft.inReplyTo && (post.status === "pending" || post.status === "posting" || post.status === "sent"))) {
      throw new BotError("conflict", "There is already a reply to that post.");
    }
    const text = draft.text.trim();
    const problem = postProblem(text);
    if (problem === "empty") throw new BotError("invalid", "A post needs some words.");
    const post: OutboxPost = {
      id: this.newId(),
      botId: draft.botId,
      surface: "x",
      inReplyTo: draft.inReplyTo,
      context: clipText(draft.context, 600).text,
      author: draft.author.slice(0, 100),
      // Too long is allowed in a draft: the person shortens it before approving.
      text,
      status: "pending",
      createdAt: this.now(),
    };
    this.posts.push(post);
    this.persist();
    return { ...post };
  }

  /** Change the words of a draft that is still waiting. */
  edit(id: string, text: string): OutboxPost {
    const post = this.pending(id);
    post.text = text.trim();
    this.persist();
    return { ...post };
  }

  private pending(id: string): OutboxPost {
    const post = this.posts.find((candidate) => candidate.id === id);
    if (!post) throw new BotError("not_found", "That post is not in the Outbox any more.");
    if (post.status !== "pending") throw new BotError("conflict", "That post has already been decided.");
    return post;
  }

  /**
   * Take a draft to be posted: it stops being pending so it cannot be posted twice, and the text to post is returned. The
   * answer from X is recorded with `sent` or `failed`.
   */
  claim(id: string): OutboxPost {
    const post = this.pending(id);
    const problem = postProblem(post.text);
    if (problem === "empty") throw new BotError("invalid", "A post needs some words.");
    if (problem === "long") throw new BotError("invalid", `That is longer than ${SURFACE_LIMITS.xChars} characters. Shorten it first.`);
    const snapshot = { ...post };
    post.status = "posting";
    post.decidedAt = this.now();
    this.persist();
    return snapshot;
  }

  sent(id: string, url: string): void {
    const post = this.posts.find((candidate) => candidate.id === id);
    if (!post) return;
    post.status = "sent";
    post.url = url;
    delete post.error;
    this.persist();
  }

  failed(id: string, error: string): void {
    const post = this.posts.find((candidate) => candidate.id === id);
    if (!post) return;
    post.status = "failed";
    post.error = error.slice(0, 500);
    this.persist();
  }

  deny(id: string): OutboxPost {
    const post = this.pending(id);
    post.status = "denied";
    post.decidedAt = this.now();
    this.persist();
    return { ...post };
  }

  removeBot(botId: string): void {
    const before = this.posts.length;
    this.posts = this.posts.filter((post) => post.botId !== botId);
    if (this.posts.length !== before) this.persist();
  }
}


/* Where X was last read to ------------------------------------------------------- */

const CURSORS_FILE = "bot-x-cursors.json";

/**
 * The newest post of each Bot's mentions that has been dealt with, so a restart neither answers old mentions again nor
 * misses new ones. A Bot with none has not been read yet: its first read only marks the place.
 */
export class XCursors {
  private readonly ids = new Map<string, string>();

  constructor(private readonly storage: Pick<Storage, "readJson" | "writeJson">) {
    const file = storage.readJson<{ cursors?: unknown }>(CURSORS_FILE, {});
    const cursors = typeof file.cursors === "object" && file.cursors !== null && !Array.isArray(file.cursors) ? (file.cursors as Record<string, unknown>) : {};
    for (const [botId, id] of Object.entries(cursors)) if (typeof id === "string" && /^\d{1,25}$/.test(id)) this.ids.set(botId, id);
  }

  get(botId: string): string | undefined {
    return this.ids.get(botId);
  }

  set(botId: string, id: string): void {
    if (!/^\d{1,25}$/.test(id) || this.ids.get(botId) === id) return;
    this.ids.set(botId, id);
    this.persist();
  }

  forget(botId: string): void {
    if (this.ids.delete(botId)) this.persist();
  }

  private persist(): void {
    this.storage.writeJson(CURSORS_FILE, { cursors: Object.fromEntries(this.ids) });
  }
}
