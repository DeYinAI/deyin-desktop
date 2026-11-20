/**
 * The Deyin Bot entity.
 *
 * A Bot has a name, a persona, an avatar, a place to run, an approval mode and the fields a local-first app can honor,
 * plus `handle` (a unique @mention), `isPrimary` (the Bot that coordinates the others) and `hostId`
 * (which of the user's servers a server Bot lives on). Everything here is browser-safe so the
 * renderer validates with the same code the store enforces.
 */
import {
  isBotAvatarColor,
  isBotAvatarShape,
  resolveBotAvatar,
  type BotAvatarColor,
  type BotAvatarShape,
} from "./avatar.js";

/** Where a Bot runs: on this computer, or on a server the person owns. */
export const BOT_HARNESSES = ["local", "server"] as const;
export type BotHarness = (typeof BOT_HARNESSES)[number];

/** How a Bot's tool calls are approved: by an automatic reviewer, read-only, or run everything. */
export const BOT_APPROVAL_MODES = ["auto_review", "read_only", "run_everything"] as const;
export type BotApprovalMode = (typeof BOT_APPROVAL_MODES)[number];

/** Who can see a Bot. Deyin has no teams, so only `owner` can be set. */
export const BOT_VISIBILITIES = ["owner", "team"] as const;
export type BotVisibility = (typeof BOT_VISIBILITIES)[number];

/** A single Bot (`agent`) or a `room`, which is a conversation among Bots. */
export const BOT_KINDS = ["agent", "room"] as const;
export type BotKind = (typeof BOT_KINDS)[number];

export interface BotAutoReview {
  approvalMode: BotApprovalMode;
}

export interface BotRoutinePolicy {
  /** May other people with access to this Bot create routines for it. */
  allowCollaboratorCreation: boolean;
}

export interface DeyinBot {
  id: string;
  /** Id of the Bot this one was imported or migrated from, when it came from somewhere else. */
  legacyBotId?: string;
  name: string;
  /** Unique, lowercase, used as `@handle` in chat. Derived from the name and kept unique. */
  handle: string;
  description: string;
  /** Short line shown under the name, for example "Research assistant". */
  title: string;
  avatarShape: BotAvatarShape;
  avatarColor: BotAvatarColor;
  /** An uploaded or generated avatar as a data: URL. When present it replaces the shape. */
  avatarUrl?: string;
  /** Bumped whenever the avatar changes so caches and views can tell. */
  avatarVersion: number;
  createdAt: number;
  updatedAt: number;
  harness: BotHarness;
  /** Alias of the saved SSH host this Bot runs on. Set exactly when `harness` is `server`. */
  hostId?: string;
  /** Free-form job title the Bot is introduced with, for example "researcher". */
  role: string;
  visibility: BotVisibility;
  kind: BotKind;
  /** The Bots in a room. Always empty for an agent. */
  memberBotIds: string[];
  /** What the Bot is for; part of its standing instructions. */
  purpose?: string;
  /** The description shown when the Bot is shared or published. */
  publicDescription?: string;
  autoReview: BotAutoReview;
  routinePolicy?: BotRoutinePolicy;
  /** The Bot that coordinates the others. At most one active agent has this. */
  isPrimary: boolean;
  archived: boolean;
}

/** Fields accepted when creating a Bot. Only `name` is required. */
export interface BotInput {
  name: string;
  description?: string;
  title?: string;
  avatarShape?: BotAvatarShape;
  avatarColor?: BotAvatarColor;
  harness?: BotHarness;
  hostId?: string;
  role?: string;
  visibility?: BotVisibility;
  kind?: BotKind;
  memberBotIds?: string[];
  purpose?: string;
  publicDescription?: string;
  approvalMode?: BotApprovalMode;
  routinePolicy?: BotRoutinePolicy;
  legacyBotId?: string;
}

/** Fields accepted when editing a Bot. `kind` is fixed at creation; `avatarUrl: null` clears it. */
export type BotPatch = Partial<Omit<BotInput, "kind" | "legacyBotId">> & { avatarUrl?: string | null };

export const BOT_LIMITS = {
  /** A guard against runaway creation, not a recovered product limit. */
  maxBots: 100,
  name: 48,
  title: 60,
  role: 60,
  description: 500,
  publicDescription: 500,
  purpose: 2000,
  /** Encoded data URL length; the avatar editor downsizes well below this. */
  avatarUrl: 300_000,
  maxSections: 20,
  sectionName: 40,
  handle: 32,
  minRoomMembers: 2,
  /** Every member is written into the room's prompt, so a room holds a handful of Bots, not the whole roster. */
  maxRoomMembers: 8,
} as const;

export const DEFAULT_BOT_ROLE = "assistant";

/** Ids become directory names and appear in IPC calls, so they are restricted to a safe alphabet. */
const BOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isSafeBotId(value: unknown): value is string {
  return typeof value === "string" && BOT_ID_PATTERN.test(value);
}

const AVATAR_URL_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** A PNG, JPEG or WebP data URL small enough to keep on a Bot: the only kind of picture a Bot's avatar can be. */
export function isBotAvatarUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= BOT_LIMITS.avatarUrl && AVATAR_URL_PATTERN.test(value);
}

/** One line: control characters dropped, runs of whitespace collapsed, ends trimmed. */
export function cleanBotLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
}

/** Multi-line text: control characters other than newline and tab dropped, ends trimmed. */
export function cleanBotText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim() : "";
}

/** `@handle` form of a name: lowercase ASCII words joined by hyphens. */
export function slugifyBotHandle(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BOT_LIMITS.handle)
    .replace(/-+$/g, "");
  return slug || "bot";
}

/** A handle for `name` that no entry in `taken` uses, suffixing `-2`, `-3`, ... when needed. */
export function uniqueBotHandle(name: string, taken: ReadonlySet<string>): string {
  const base = slugifyBotHandle(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, BOT_LIMITS.handle - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function checkBotName(name: unknown): string | null {
  const clean = cleanBotLine(name);
  if (!clean) return "A Bot needs a name.";
  if (clean.length > BOT_LIMITS.name) return `A Bot's name can be at most ${BOT_LIMITS.name} characters.`;
  return null;
}

function checkLength(label: string, value: unknown, max: number): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return `${label} must be text.`;
  return value.length > max ? `${label} can be at most ${max} characters.` : null;
}

/**
 * The first problem with the fields of a create or edit request, or null when they are acceptable.
 * Checks each field on its own; rules that depend on other Bots (unique rooms, existing members,
 * the Bot limit) are the store's to enforce.
 */
export function checkBotFields(input: Partial<BotInput> & { avatarUrl?: string | null }, mode: "create" | "update"): string | null {
  if (mode === "create" || input.name !== undefined) {
    const nameError = checkBotName(input.name);
    if (nameError) return nameError;
  }
  const lengths: Array<[string, unknown, number]> = [
    ["The title", input.title, BOT_LIMITS.title],
    ["The role", input.role, BOT_LIMITS.role],
    ["The description", input.description, BOT_LIMITS.description],
    ["The public description", input.publicDescription, BOT_LIMITS.publicDescription],
    ["The purpose", input.purpose, BOT_LIMITS.purpose],
  ];
  for (const [label, value, max] of lengths) {
    const error = checkLength(label, value, max);
    if (error) return error;
  }
  if (input.avatarShape !== undefined && !isBotAvatarShape(input.avatarShape)) return "That avatar shape is not available.";
  if (input.avatarColor !== undefined && !isBotAvatarColor(input.avatarColor)) return "That avatar color is not available.";
  if (input.avatarUrl !== undefined && input.avatarUrl !== null) {
    if (input.avatarUrl.length > BOT_LIMITS.avatarUrl) return "That avatar image is too large.";
    if (!AVATAR_URL_PATTERN.test(input.avatarUrl)) return "The avatar must be a PNG, JPEG or WebP image.";
  }
  if (input.harness !== undefined && !(BOT_HARNESSES as readonly string[]).includes(input.harness)) return "Unknown place to run the Bot.";
  if (input.harness === "server" && !cleanBotLine(input.hostId)) return "A Bot that runs on a server needs the server to run on.";
  if (input.approvalMode !== undefined && !(BOT_APPROVAL_MODES as readonly string[]).includes(input.approvalMode)) return "Unknown approval mode.";
  if (input.visibility !== undefined) {
    if (!(BOT_VISIBILITIES as readonly string[]).includes(input.visibility)) return "Unknown visibility.";
    if (input.visibility === "team") return "Team visibility needs a team workspace, which Deyin does not have yet.";
  }
  if (input.kind !== undefined && !(BOT_KINDS as readonly string[]).includes(input.kind)) return "Unknown kind of Bot.";
  if (input.memberBotIds !== undefined && (!Array.isArray(input.memberBotIds) || !input.memberBotIds.every(isSafeBotId))) {
    return "A room's members must be Bot ids.";
  }
  return null;
}

/** Canonical copy of a persisted Bot, or null when it is too damaged to keep (no usable id or name). */
export function normalizeBot(raw: unknown): DeyinBot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isSafeBotId(r.id)) return null;
  const name = cleanBotLine(r.name).slice(0, BOT_LIMITS.name);
  if (!name) return null;

  const avatar = resolveBotAvatar({ id: r.id, avatarShape: r.avatarShape, avatarColor: r.avatarColor });
  const createdAt = typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : 0;
  const updatedAt = typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : createdAt;
  const harness: BotHarness = r.harness === "server" ? "server" : "local";
  const hostId = harness === "server" ? cleanBotLine(r.hostId) : "";
  const kind: BotKind = r.kind === "room" ? "room" : "agent";
  const approvalMode = (r.autoReview as { approvalMode?: unknown } | undefined)?.approvalMode;
  const optional = (value: unknown, max: number): string | undefined => {
    const text = cleanBotText(value).slice(0, max);
    return text || undefined;
  };

  const bot: DeyinBot = {
    id: r.id,
    name,
    handle: typeof r.handle === "string" && r.handle ? r.handle : slugifyBotHandle(name),
    description: cleanBotText(r.description).slice(0, BOT_LIMITS.description),
    title: cleanBotLine(r.title).slice(0, BOT_LIMITS.title),
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    avatarVersion: typeof r.avatarVersion === "number" && Number.isFinite(r.avatarVersion) ? r.avatarVersion : 1,
    createdAt,
    updatedAt,
    harness,
    role: cleanBotLine(r.role).slice(0, BOT_LIMITS.role) || DEFAULT_BOT_ROLE,
    visibility: "owner",
    kind,
    memberBotIds: kind === "room" && Array.isArray(r.memberBotIds) ? [...new Set(r.memberBotIds.filter(isSafeBotId))] : [],
    autoReview: {
      approvalMode: (BOT_APPROVAL_MODES as readonly unknown[]).includes(approvalMode) ? (approvalMode as BotApprovalMode) : "auto_review",
    },
    isPrimary: r.isPrimary === true && kind === "agent",
    archived: r.archived === true,
  };
  if (hostId) bot.hostId = hostId;
  if (typeof r.legacyBotId === "string" && r.legacyBotId) bot.legacyBotId = r.legacyBotId;
  if (typeof r.avatarUrl === "string" && r.avatarUrl.length <= BOT_LIMITS.avatarUrl && AVATAR_URL_PATTERN.test(r.avatarUrl)) {
    bot.avatarUrl = r.avatarUrl;
  }
  const purpose = optional(r.purpose, BOT_LIMITS.purpose);
  if (purpose) bot.purpose = purpose;
  const publicDescription = optional(r.publicDescription, BOT_LIMITS.publicDescription);
  if (publicDescription) bot.publicDescription = publicDescription;
  const policy = r.routinePolicy as { allowCollaboratorCreation?: unknown } | undefined;
  if (policy && typeof policy === "object") bot.routinePolicy = { allowCollaboratorCreation: policy.allowCollaboratorCreation === true };
  return bot;
}

export type BotErrorCode = "not_found" | "invalid" | "conflict" | "limit";

/** A refusal with a reason a person can read. `code` lets callers branch without parsing the message. */
export class BotError extends Error {
  constructor(
    readonly code: BotErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BotError";
  }
}

/** What a Bot operation over IPC returns: a value, or a reason a person can read. Never a thrown error. */
export type BotResult<T> = { ok: true; value: T } | { ok: false; error: string; code: BotErrorCode };

/** Run `fn`, turning a `BotError` into a failed result. Anything else is a bug and still throws. */
export function botResult<T>(fn: () => T): BotResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    if (error instanceof BotError) return { ok: false, error: error.message, code: error.code };
    throw error;
  }
}

/** `botResult` for work that waits (a server, the network): a refusal is returned as text, anything unexpected is still thrown. */
export async function botResultAsync<T>(fn: () => Promise<T>): Promise<BotResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof BotError) return { ok: false, error: error.message, code: error.code };
    throw error;
  }
}

/** A Bot memory fact as the renderer sees it: no file paths, and `shared` says whether other Bots see it too. */
export interface BotMemoryFactView {
  id: string;
  name: string;
  title: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  /** True for a fact every Bot can see; false for one private to this Bot. */
  shared: boolean;
  revision: number;
  updatedAt: string;
  body: string;
}
