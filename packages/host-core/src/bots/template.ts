/**
 * Handing a Bot to someone else, and taking one in. A template is the part of a Bot that is the same whoever owns it:
 * who it is, how it works, the skills it has and the routines it runs. It is never the part that is the owner's: its
 * files, what it remembers, its logins, its conversations, the permissions it was given, where it runs, or the model
 * and account a routine uses. Whoever imports one chooses all of those themselves.
 *
 * Maps the recovered `GrokBotTemplate` (name, avatar, description) with `Create a copy` and `Import Bot`. Grok Bot
 * keeps a template on its own service and shares a link to it; Deyin has no such service, so the template is the text
 * itself, and a link is that text carried inside it when it is short enough. Everything here is browser-safe.
 */
import { isBotAvatarColor, isBotAvatarShape, type BotAvatarColor, type BotAvatarShape } from "./avatar.js";
import { checkSkillInput, type BotSkillInput } from "./skills.js";
import { BOT_LIMITS, BotError, cleanBotLine, cleanBotText, type BotInput } from "./types.js";

export const TEMPLATE_FORMAT = "deyin.bot-template";
export const TEMPLATE_VERSION = 1;

export const TEMPLATE_LIMITS = {
  /** The whole text of a template. */
  chars: 600_000,
  skills: 25,
  routines: 10,
  routineName: 60,
  routineDescription: 200,
  routinePrompt: 4_000,
  cron: 120,
  /** The longest link a template is carried in; longer ones are saved as a file. */
  linkChars: 8_000,
} as const;

export type TemplateSchedule = { kind: "manual" } | { kind: "cron"; expression: string };

export interface BotTemplateRoutine {
  name: string;
  description?: string;
  prompt: string;
  schedule: TemplateSchedule;
}

export interface BotTemplate {
  format: typeof TEMPLATE_FORMAT;
  version: typeof TEMPLATE_VERSION;
  name: string;
  title: string;
  description: string;
  role: string;
  /** How the Bot works: what it is for and how it should go about it. */
  purpose: string;
  publicDescription: string;
  avatarShape?: BotAvatarShape;
  avatarColor?: BotAvatarColor;
  skills: BotSkillInput[];
  routines: BotTemplateRoutine[];
}

/** What a Bot has that a template is made from. */
export interface TemplateSource {
  name: string;
  title: string;
  description: string;
  role: string;
  purpose: string;
  publicDescription: string;
  avatarShape: BotAvatarShape;
  avatarColor: BotAvatarColor;
  skills: readonly BotSkillInput[];
  routines: readonly BotTemplateRoutine[];
}

/** A template from a Bot. Only the fields of a template are copied, so nothing else a Bot has can travel with it. */
export function makeBotTemplate(source: TemplateSource): BotTemplate {
  return {
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_VERSION,
    name: source.name,
    title: source.title,
    description: source.description,
    role: source.role,
    purpose: source.purpose,
    publicDescription: source.publicDescription,
    avatarShape: source.avatarShape,
    avatarColor: source.avatarColor,
    skills: source.skills.map(({ name, description, body }) => ({ name, description, body })),
    routines: source.routines.map(({ name, description, prompt, schedule }) => ({
      name,
      ...(description ? { description } : {}),
      prompt,
      schedule: schedule.kind === "cron" ? { kind: "cron", expression: schedule.expression } : { kind: "manual" },
    })),
  };
}

export function stringifyBotTemplate(template: BotTemplate): string {
  return JSON.stringify(template, null, 2);
}

/* Reading ---------------------------------------------------------------------- */

function refuse(message: string): never {
  throw new BotError("invalid", message);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return refuse(`${what} is not in a form this app understands.`);
  return value as Record<string, unknown>;
}

function line(value: unknown, limit: number, what: string, required = false): string {
  const text = cleanBotLine(value);
  if (required && !text) refuse(`${what} is missing.`);
  if (text.length > limit) refuse(`${what} is longer than ${limit} characters.`);
  return text;
}

function block(value: unknown, limit: number, what: string, required = false): string {
  const text = cleanBotText(value);
  if (required && !text) refuse(`${what} is missing.`);
  if (text.length > limit) refuse(`${what} is longer than ${limit.toLocaleString("en-US")} characters.`);
  return text;
}

function readSchedule(value: unknown, routine: string): TemplateSchedule {
  if (value === undefined || value === null) return { kind: "manual" };
  const source = asRecord(value, `The schedule of "${routine}"`);
  if (source.kind === "manual") return { kind: "manual" };
  if (source.kind !== "cron") return refuse(`"${routine}" has a schedule this app does not know.`);
  const expression = line(source.expression, TEMPLATE_LIMITS.cron, `The schedule of "${routine}"`, true);
  if (expression.split(" ").length < 5 || expression.split(" ").length > 6) return refuse(`The schedule of "${routine}" is not a cron expression: "${expression}".`);
  return { kind: "cron", expression };
}

function readRoutines(value: unknown): BotTemplateRoutine[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return refuse("The routines are not in a form this app understands.");
  if (value.length > TEMPLATE_LIMITS.routines) refuse(`A template carries at most ${TEMPLATE_LIMITS.routines} routines.`);
  return value.map((item, index) => {
    const source = asRecord(item, `Routine ${index + 1}`);
    const name = line(source.name, TEMPLATE_LIMITS.routineName, `The name of routine ${index + 1}`, true);
    const description = line(source.description, TEMPLATE_LIMITS.routineDescription, `The description of "${name}"`);
    const prompt = block(source.prompt, TEMPLATE_LIMITS.routinePrompt, `What "${name}" does`, true);
    return { name, ...(description ? { description } : {}), prompt, schedule: readSchedule(source.schedule, name) };
  });
}

function readSkills(value: unknown): BotSkillInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return refuse("The skills are not in a form this app understands.");
  if (value.length > TEMPLATE_LIMITS.skills) refuse(`A template carries at most ${TEMPLATE_LIMITS.skills} skills.`);
  const seen = new Set<string>();
  return value.map((item) => {
    const skill = checkSkillInput(item);
    if (seen.has(skill.name)) refuse(`The skill "${skill.name}" is in the template twice.`);
    seen.add(skill.name);
    return skill;
  });
}

/** Text that may be the JSON of a template, in a code block or not, or a link carrying one. */
function templateText(input: string): string {
  const trimmed = input.trim();
  const link = parseTemplateLink(trimmed);
  if (link !== null) return link;
  const fenced = /^```[a-z]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/**
 * A template from text someone pasted, or a file or a link carried. Anything not in the template's own fields is
 * ignored, every length is held to its limit, and a refusal says what to fix. It never throws anything but a
 * `BotError`.
 */
export function parseBotTemplate(input: string): BotTemplate {
  if (typeof input !== "string" || input.trim() === "") return refuse("There is no template there.");
  if (input.length > TEMPLATE_LIMITS.chars * 2) return refuse("That is too large to be a Bot template.");
  const text = templateText(input);
  if (text.length > TEMPLATE_LIMITS.chars) return refuse("That is too large to be a Bot template.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse("That is not a Bot template. A template is the text Deyin produces when you share a Bot.");
  }
  const source = asRecord(raw, "The template");
  if (source.format !== TEMPLATE_FORMAT) return refuse("That is not a Bot template.");
  if (typeof source.version !== "number" || !Number.isInteger(source.version) || source.version < 1) return refuse("The template has no version.");
  if (source.version > TEMPLATE_VERSION) return refuse("This template was made by a newer version of Deyin. Update Deyin to use it.");
  const avatarShape = isBotAvatarShape(source.avatarShape) ? source.avatarShape : undefined;
  const avatarColor = isBotAvatarColor(source.avatarColor) ? source.avatarColor : undefined;
  return {
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_VERSION,
    name: line(source.name, BOT_LIMITS.name, "The Bot's name", true),
    title: line(source.title, BOT_LIMITS.title, "The Bot's title"),
    description: line(source.description, BOT_LIMITS.description, "The description"),
    role: line(source.role, BOT_LIMITS.role, "The role"),
    purpose: block(source.purpose, BOT_LIMITS.purpose, "What the Bot is for"),
    publicDescription: line(source.publicDescription, BOT_LIMITS.publicDescription, "The public description"),
    ...(avatarShape ? { avatarShape } : {}),
    ...(avatarColor ? { avatarColor } : {}),
    skills: readSkills(source.skills),
    routines: readRoutines(source.routines),
  };
}

/** The Bot a template makes. Where it runs and what it may do are left to the defaults, for its new owner to set. */
export function botInputFromTemplate(template: BotTemplate): BotInput {
  return {
    name: template.name,
    description: template.description,
    title: template.title,
    ...(template.role ? { role: template.role } : {}),
    purpose: template.purpose,
    publicDescription: template.publicDescription,
    ...(template.avatarShape ? { avatarShape: template.avatarShape } : {}),
    ...(template.avatarColor ? { avatarColor: template.avatarColor } : {}),
  };
}

/** What importing a template will do, in numbers and names, for the person to see before they agree. */
export interface TemplateSummary {
  name: string;
  title: string;
  description: string;
  skills: Array<{ name: string; description: string }>;
  routines: Array<{ name: string; scheduled: boolean }>;
}

export function summarizeTemplate(template: BotTemplate): TemplateSummary {
  return {
    name: template.name,
    title: template.title,
    description: template.description,
    skills: template.skills.map(({ name, description }) => ({ name, description })),
    routines: template.routines.map(({ name, schedule }) => ({ name, scheduled: schedule.kind === "cron" })),
  };
}

/* Links ------------------------------------------------------------------------ */

export const TEMPLATE_LINK_PREFIX = "deyin://bot/import?t=";

function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(text: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** A template as a link that opens Deyin and offers to import it, or null when it is too long to carry. */
export function templateLink(template: BotTemplate): string | null {
  const link = `${TEMPLATE_LINK_PREFIX}${encode(JSON.stringify(template))}`;
  return link.length <= TEMPLATE_LIMITS.linkChars ? link : null;
}

/** The template text inside an import link, or null when `text` is not one. */
export function parseTemplateLink(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.toLowerCase().startsWith("deyin://bot/import")) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "deyin:" || url.hostname !== "bot" || url.pathname !== "/import") return null;
  const carried = url.searchParams.get("t");
  return carried === null ? null : decode(carried);
}

/** Whether a deep link is an offer to import a Bot, so the app knows to open the import dialog and not the sign-in handler. */
export function isTemplateLink(text: string): boolean {
  return /^deyin:\/\/bot\/import(?:[?#/]|$)/i.test(text.trim());
}
