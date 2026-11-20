/**
 * A Bot's own skills: reusable instructions for one kind of task, kept with the Bot and nowhere else, so what one Bot
 * learned is not something every other Bot, or Deyin Code, suddenly follows.
 *
 * Maps the recovered `GrokBotAgentSkill { id, name, description, body, source }` and `GrokBotSkillRevision { author
 * BOT | PERSON, content, description, result_version, created, rolled_back }`. A skill is a `SKILL.md` in the same
 * format Deyin's other skills use, so what the agent reads is the file itself. Everything here is browser-safe: the
 * renderer checks a skill with the same code the store enforces.
 */
import { BotError, cleanBotLine, cleanBotText } from "./types.js";

export const SKILL_LIMITS = {
  name: 64,
  description: 1_024,
  body: 100_000,
  /** A guard against runaway creation, not a recovered product limit. */
  perBot: 100,
  /** Revisions kept per skill; the oldest go first. */
  revisions: 50,
  /** What all of a server Bot's skills may take of its prompt: a server cannot read the app's files. */
  promptTotal: 40_000,
  /** What one skill may take of that. */
  promptEach: 8_000,
} as const;

/**
 * Who wrote the words in a skill, as the person would say it: they did, the Bot did, they came with an imported
 * template, or they were drafted from a task the person showed.
 */
export const SKILL_ORIGINS = ["person", "bot", "template", "recording"] as const;
export type SkillOrigin = (typeof SKILL_ORIGINS)[number];

/** Who made a change, as the recovered `GrokBotSkillRevisionAuthor`: the Bot or the person. */
export const SKILL_AUTHORS = ["bot", "person"] as const;
export type SkillAuthor = (typeof SKILL_AUTHORS)[number];

export interface BotSkillInput {
  name: string;
  description: string;
  body: string;
}

export interface BotSkillSummary {
  name: string;
  description: string;
  origin: SkillOrigin;
  /** Counts up with every change to the words, from 1. */
  version: number;
  updatedAt: number;
  /** Size of the instructions, for the list. */
  bytes: number;
}

export interface BotSkill extends BotSkillSummary {
  body: string;
}

export interface SkillRevision {
  id: string;
  skill: string;
  atMs: number;
  author: SkillAuthor;
  /** The instructions as they were after this change. */
  content: string;
  description: string;
  /** The skill's version after this change. */
  resultVersion: number;
  /** This change made the skill. */
  created: boolean;
  /** Something later put the skill back to before this change. */
  rolledBack: boolean;
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSkillName(value: unknown): value is string {
  return typeof value === "string" && value.length <= SKILL_LIMITS.name && NAME_PATTERN.test(value);
}

export function isSkillOrigin(value: unknown): value is SkillOrigin {
  return typeof value === "string" && (SKILL_ORIGINS as readonly string[]).includes(value);
}

/** A name for a skill from what the person called the task: lowercase words with hyphens between, never empty. */
export function skillNameFrom(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_LIMITS.name)
    .replace(/-+$/g, "");
  return slug || "skill";
}

/** A name not in `taken`, adding `-2`, `-3`… to `base` as needed. */
export function uniqueSkillName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const stem = skillNameFrom(base);
  if (!used.has(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${stem.slice(0, SKILL_LIMITS.name - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** The fields of a skill someone typed or something sent, checked. A refusal says what to change. */
export function checkSkillInput(input: unknown): BotSkillInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new BotError("invalid", "The skill is not in a form this app understands.");
  const source = input as Record<string, unknown>;
  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!isSkillName(name)) {
    throw new BotError("invalid", `A skill's name is lowercase letters and numbers with hyphens between, at most ${SKILL_LIMITS.name} characters. For example "weekly-report".`);
  }
  const description = cleanBotLine(source.description);
  if (!description) throw new BotError("invalid", "Say in a sentence what the skill is for, so the Bot knows when to use it.");
  if (description.length > SKILL_LIMITS.description) throw new BotError("invalid", `A skill's description is at most ${SKILL_LIMITS.description} characters.`);
  const body = cleanBotText(source.body);
  if (!body) throw new BotError("invalid", "A skill needs instructions: say what to do, step by step.");
  if (body.length > SKILL_LIMITS.body) throw new BotError("invalid", `A skill's instructions are at most ${SKILL_LIMITS.body.toLocaleString("en-US")} characters.`);
  return { name, description, body };
}

/**
 * The `SKILL.md` for a skill. The description is always quoted, so a colon or a bracket in it cannot be read as
 * something else by the parser the agent uses.
 */
export function skillMarkdown(input: BotSkillInput): string {
  return `---\nname: ${input.name}\ndescription: "${input.description.replace(/\s+/g, " ").trim()}"\n---\n\n${input.body.trim()}\n`;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) return trimmed.slice(1, -1);
  return trimmed;
}

/** What a `SKILL.md` says, read the way the agent reads it. Missing fields come back undefined; it never throws. */
export function parseSkillMarkdown(text: string): { name?: string; description?: string; body: string } {
  const match = FENCE.exec(text);
  if (!match) return { body: text.trim() };
  const fields: Record<string, string> = {};
  for (const raw of match[1]!.split(/\r?\n/)) {
    const line = raw.trim();
    const colon = line.indexOf(":");
    if (!line || line.startsWith("#") || colon <= 0) continue;
    fields[line.slice(0, colon).trim()] = unquote(line.slice(colon + 1));
  }
  const body = text.slice(match[0].length).trim();
  return { ...(fields.name ? { name: fields.name } : {}), ...(fields.description ? { description: fields.description } : {}), body };
}

/* In a prompt ------------------------------------------------------------------ */

export const SKILLS_TAG = "bot_skills";
const OWN_TAGS = new RegExp(`</?\\s*${SKILLS_TAG}\\b[^>]*>`, "gi");

function inert(text: string): string {
  return text.replace(OWN_TAGS, "").replace(/\u0000/g, "");
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * A Bot's skills written out as a section of a prompt, for a Bot whose agent cannot read this app's files (one on a
 * server). Each is cut to `promptEach` and the section to `promptTotal`; what does not fit is named, not dropped
 * silently. Empty when there are none.
 */
export function skillsPromptSection(skills: readonly BotSkillInput[], total: number = SKILL_LIMITS.promptTotal): string {
  const entries: string[] = [];
  let used = 0;
  for (const skill of skills) {
    const heading = `## ${inert(skill.name)}: ${clip(inert(skill.description).replace(/\s+/g, " ").trim(), 240)}`;
    const body = clip(inert(skill.body).trim(), SKILL_LIMITS.promptEach);
    const entry = `${heading}\n${body}`;
    if (used + entry.length + 2 > total) break;
    entries.push(entry);
    used += entry.length + 2;
  }
  if (entries.length === 0) return "";
  const left = skills.length - entries.length;
  const note = left > 0 ? `\n(${left} more ${left === 1 ? "skill is" : "skills are"} left out to keep this short.)` : "";
  return `<${SKILLS_TAG}>\nSkills you have learned. When one fits what you are asked, follow it.\n\n${entries.join("\n\n")}${note}\n</${SKILLS_TAG}>`;
}
