import type { Automation, AutomationInfo, DeyinApi } from "@deyin/contract";
import {
  SURFACE_SHAPES,
  parseHubSettings,
  postProblem,
  routinesOf,
  surfaceUrl,
  type ActivityKind,
  type BotSurfacesState,
  type HubSettings,
  type HubStatus,
  type MessageKey,
  type OutboxPost,
  type SurfaceActivity,
  type SurfaceInput,
  type SurfaceKind,
  type SurfaceView,
} from "@deyin/host-core/shared";
import { defaultSchedule } from "../automationSchedule.js";
import { attempt, attemptPlain, reason, type Outcome } from "./botCalls.js";
import { addBlockFor, routineInput, type RoutineDefaults, type RoutinesApi } from "./botRoutines.js";

/** The connection calls the panel needs. Absent where there is no desktop host. */
export type SurfacesApi = NonNullable<DeyinApi["botSurfaces"]>;

export type ConnectionsLoad = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; state: BotSurfacesState };

/* Words ------------------------------------------------------------------------------ */

/** The things a person fills in or pastes, by the names the host uses for them. */
export const FIELD_NAMES = ["key", "secret", "signingSecret", "botToken", "appPassword", "appId", "tenantId", "accessToken", "userId", "handle"] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

export function isFieldName(value: string): value is FieldName {
  return (FIELD_NAMES as readonly string[]).includes(value);
}

export function fieldLabelKey(name: FieldName): MessageKey {
  return `bot.conn.field.${name}`;
}

export function fieldHintKey(name: FieldName): MessageKey | null {
  return name === "key" || name === "secret" ? null : `bot.conn.fieldHint.${name}`;
}

export function kindLabelKey(kind: SurfaceKind): MessageKey {
  return `bot.conn.kind.${kind}`;
}

export function aboutKey(kind: SurfaceKind): MessageKey {
  return `bot.conn.about.${kind}`;
}

export function noteKey(kind: SurfaceKind): MessageKey {
  return `bot.conn.note.${kind}`;
}

/** What a list of who may reach the Bot looks like on this surface; a webhook has no list. */
export function allowHintKey(kind: SurfaceKind): MessageKey | null {
  return kind === "webhook" ? null : `bot.conn.allow.${kind}`;
}

/** What the address of this surface is called by the service that is given it; X is asked and has none. */
export function addressLabelKey(kind: SurfaceKind): MessageKey | null {
  return kind === "x" ? null : `bot.conn.address.${kind}`;
}

/** What is still missing, in words: a routine or a list, or the name of a field. */
export function missingText(missing: readonly string[], t: (key: MessageKey) => string): string {
  return missing
    .map((name) => {
      if (name === "routine") return t("bot.conn.missing.routine");
      if (name === "allow") return t("bot.conn.missing.allow");
      return isFieldName(name) ? t(fieldLabelKey(name)) : name;
    })
    .join(", ");
}

/* Where each surface stands ------------------------------------------------------------ */

export type SurfaceStatus = "none" | "off" | "setup" | "on" | "blocked";

/**
 * "blocked" is a surface that is on and complete but cannot be reached because this computer is not listening; X is
 * asked, not called, so the hub does not matter to it.
 */
export function surfaceStatus(kind: SurfaceKind, view: SurfaceView | undefined, hub: HubStatus): SurfaceStatus {
  if (!view) return "none";
  if (view.missing.length > 0) return "setup";
  if (!view.enabled) return "off";
  if (kind !== "x" && !hub.listening) return "blocked";
  return "on";
}

export function statusKey(status: SurfaceStatus): MessageKey {
  return `bot.conn.status.${status}`;
}

/* A surface's form ------------------------------------------------------------------- */

/** What is typed for one surface. A secret left empty keeps what is saved; the list is one name per line. */
export interface SurfaceForm {
  routineId: string;
  allow: string;
  settings: Record<string, string>;
  secrets: Record<string, string>;
}

export function formFromView(kind: SurfaceKind, view: SurfaceView | undefined): SurfaceForm {
  const settings: Record<string, string> = {};
  for (const name of SURFACE_SHAPES[kind].settings) settings[name] = view?.settings[name] ?? "";
  const secrets: Record<string, string> = {};
  for (const name of SURFACE_SHAPES[kind].secrets) secrets[name] = "";
  return { routineId: view?.routineId ?? "", allow: (view?.allow ?? []).join("\n"), settings, secrets };
}

/** Names typed one per line, or separated by commas or spaces. */
export function parseAllowText(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** What is sent to save: empty secrets are left out so they are kept; empty settings are sent so they are cleared. */
export function inputFromForm(form: SurfaceForm, enabled: boolean): Partial<SurfaceInput> {
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(form.secrets)) if (value.trim() !== "") secrets[name] = value;
  const settings: Record<string, string> = {};
  for (const [name, value] of Object.entries(form.settings)) settings[name] = value.trim();
  return { routineId: form.routineId, enabled, allow: parseAllowText(form.allow), settings, secrets };
}

export function isSurfaceFormDirty(kind: SurfaceKind, view: SurfaceView | undefined, form: SurfaceForm): boolean {
  const saved = formFromView(kind, view);
  if (form.routineId !== saved.routineId) return true;
  if (parseAllowText(form.allow).join("\n") !== (view?.allow ?? []).join("\n")) return true;
  if (Object.keys(saved.settings).some((name) => (form.settings[name] ?? "").trim() !== saved.settings[name])) return true;
  return Object.values(form.secrets).some((value) => value.trim() !== "");
}

/* The routine a message goes to ---------------------------------------------------------- */

export interface RoutineChoice {
  id: string;
  name: string;
  /** A routine that also runs on a clock will run with no message at those times. */
  scheduled: boolean;
}

export function routineChoices(automations: readonly AutomationInfo[], botId: string): RoutineChoice[] {
  return routinesOf(automations, botId)
    .map((routine) => ({ id: routine.id, name: routine.name, scheduled: routine.trigger.kind !== "manual" }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

/** What a routine made for messages is told. It is read by the model, not shown as interface text. */
export const MESSAGE_ROUTINE_PROMPT =
  "Someone has sent you a message; it is given to you below. Do what it asks with the skills and tools you have, and finish with a report whose summary is the answer to send back to them, written for them to read.";

/** Why a routine for messages cannot be made here, or null when it can. */
export function messageRoutineBlock(list: readonly AutomationInfo[], bot: { id: string; archived: boolean }, defaults: RoutineDefaults): "noModel" | "unavailable" | null {
  const block = addBlockFor(list, bot, defaults);
  if (block === null) return null;
  return block === "noModel" ? "noModel" : "unavailable";
}

export function messageRoutineInput(botId: string, name: string, defaults: RoutineDefaults): Omit<Automation, "id" | "createdAt" | "updatedAt"> {
  return routineInput(botId, { name, instruction: MESSAGE_ROUTINE_PROMPT, schedule: { ...defaultSchedule(), repeat: "manual" } }, defaults);
}

/** A routine that only runs when a message arrives, so nothing runs on a clock without one. */
export async function makeMessageRoutine(api: Pick<RoutinesApi, "create">, botId: string, name: string, defaults: RoutineDefaults): Promise<Outcome<string>> {
  const made = await attemptPlain(() => api.create(messageRoutineInput(botId, name, defaults)));
  return made.ok ? { ok: true, value: made.value.automation.id } : made;
}

/* This computer ------------------------------------------------------------------------ */

export interface HubForm {
  port: string;
  publicUrl: string;
}

export function hubFormFrom(settings: HubSettings): HubForm {
  return { port: String(settings.port), publicUrl: settings.publicUrl };
}

function readHubForm(form: HubForm): HubSettings {
  const text = form.port.trim();
  return parseHubSettings({ port: /^\d+$/.test(text) ? Number(text) : Number.NaN, publicUrl: form.publicUrl });
}

/** What is wrong with the address settings as typed, in the host's words, or null when they can be saved. */
export function hubProblem(form: HubForm): string | null {
  try {
    readHubForm(form);
    return null;
  } catch (error) {
    return reason(error);
  }
}

export function hubInput(form: HubForm): HubSettings {
  return readHubForm(form);
}

export function isHubFormDirty(settings: HubSettings, form: HubForm): boolean {
  const saved = hubFormFrom(settings);
  return form.port.trim() !== saved.port || form.publicUrl.trim().replace(/\/+$/, "") !== saved.publicUrl;
}

/** The address to give a service for this surface, and whether only this computer can reach it. */
export function addressFor(settings: HubSettings, kind: SurfaceKind, botId: string): { url: string; local: boolean } | null {
  const url = surfaceUrl(settings, kind, botId);
  return url === null ? null : { url, local: settings.publicUrl === "" };
}

/** A command that sends a webhook message, with the key put in where it is known and a plain stand-in where it is not. */
export function webhookExample(url: string, key: string | null): string {
  return `curl -X POST -H "X-Deyin-Key: ${key ?? "YOUR_KEY"}" -d "Hello" "${url}"`;
}

/* What happened ------------------------------------------------------------------------ */

export function activityKey(kind: ActivityKind): MessageKey {
  return `bot.activity.${kind}`;
}

const ACTIVITY_TONE: Readonly<Record<ActivityKind, "ok" | "warn">> = {
  accepted: "ok",
  replied: "ok",
  "reply-failed": "warn",
  drafted: "ok",
  "run-failed": "warn",
  "bad-key": "warn",
  "not-allowed": "warn",
  duplicate: "ok",
  "rate-limited": "warn",
  busy: "warn",
  "routine-off": "warn",
  malformed: "warn",
  "poll-failed": "warn",
};

export interface ActivityRow {
  key: string;
  at: number;
  surface: SurfaceKind;
  label: MessageKey;
  detail: string;
  /** How many times it happened close together, when more than once. */
  count: number;
  tone: "ok" | "warn";
}

/** Newest first, as the host sends it, with a stable key for each entry. */
export function activityRows(entries: readonly SurfaceActivity[], limit = 20): ActivityRow[] {
  return entries.slice(0, limit).map((entry, index) => ({
    key: `${entry.at}:${entry.surface}:${entry.kind}:${index}`,
    at: entry.at,
    surface: entry.surface,
    label: activityKey(entry.kind),
    detail: entry.detail,
    count: entry.count ?? 1,
    tone: ACTIVITY_TONE[entry.kind],
  }));
}

/* Posts waiting for a person ----------------------------------------------------------- */

export interface OutboxRow {
  post: OutboxPost;
  /** The words as they now stand: the person's edit, or the draft. */
  text: string;
  used: number;
  /** How many characters too many, or 0. */
  over: number;
  problem: ReturnType<typeof postProblem>;
  status: MessageKey;
  /** Whether the person may still decide: a post being sent or already decided cannot be changed. */
  open: boolean;
}

export function outboxStatusKey(status: OutboxPost["status"]): MessageKey {
  return `bot.outbox.status.${status}`;
}

function rowOf(post: OutboxPost, edits: Readonly<Record<string, string>>, max: number): OutboxRow {
  const text = post.status === "pending" ? (edits[post.id] ?? post.text) : post.text;
  const used = [...text.trim()].length;
  return { post, text, used, over: Math.max(0, used - max), problem: postProblem(text), status: outboxStatusKey(post.status), open: post.status === "pending" };
}

/** What waits (oldest first, so the oldest question is answered first) and what was decided before (newest first). */
export function outboxRows(posts: readonly OutboxPost[], edits: Readonly<Record<string, string>>, max: number, earlierLimit = 10): { waiting: OutboxRow[]; earlier: OutboxRow[] } {
  const waiting = posts
    .filter((post) => post.status === "pending" || post.status === "posting")
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((post) => rowOf(post, edits, max));
  const earlier = posts
    .filter((post) => post.status !== "pending" && post.status !== "posting")
    .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
    .slice(0, earlierLimit)
    .map((post) => rowOf(post, edits, max));
  return { waiting, earlier };
}

/** Post a draft as the person sees it: a change to the words is saved first, so what is posted is what was on screen. */
export async function approveDraft(api: Pick<SurfacesApi, "outboxEdit" | "outboxApprove">, post: OutboxPost, text: string): Promise<Outcome<OutboxPost>> {
  if (text !== post.text) {
    const edited = await attempt(() => api.outboxEdit(post.id, text));
    if (!edited.ok) return edited;
  }
  return attempt(() => api.outboxApprove(post.id));
}

/** A link to show as a link: only a secure address, so nothing a service sent can become a script or a local file. */
export function safeLink(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}
