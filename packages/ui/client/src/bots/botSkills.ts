import type { DeyinApi } from "@deyin/contract";
import {
  SKILL_LIMITS,
  isSkillName,
  type BotSkill,
  type BotSkillInput,
  type MessageKey,
  type SkillOrigin,
  type SkillRevision,
} from "@deyin/host-core/shared";

/** The skills calls the panel needs. Absent where there is no desktop host. */
export type SkillsApi = NonNullable<DeyinApi["botSkills"]>;

/** A skill as typed. `version` is what it was opened at, or null while a new one is being written. */
export interface SkillForm {
  name: string;
  description: string;
  body: string;
  version: number | null;
}

export function emptySkillForm(): SkillForm {
  return { name: "", description: "", body: "", version: null };
}

export function skillFormFromSkill(skill: BotSkill): SkillForm {
  return { name: skill.name, description: skill.description, body: skill.body, version: skill.version };
}

/** A drafted skill (from a recording, say) as a form for a new skill: the person reads and changes it before it is saved. */
export function skillFormFromDraft(draft: BotSkillInput): SkillForm {
  return { name: draft.name, description: draft.description, body: draft.body, version: null };
}

export function skillPayload(form: SkillForm): BotSkillInput {
  return { name: form.name.trim(), description: form.description.trim(), body: form.body };
}

/** What is wrong with the form, as a message key, or null when it can be saved. */
export function skillFormProblem(form: SkillForm): MessageKey | null {
  // A skill that exists keeps its name; only a new one is named here.
  if (form.version === null && !isSkillName(form.name.trim())) return "bot.skills.problem.name";
  const description = form.description.trim();
  if (!description) return "bot.skills.problem.description";
  if (description.length > SKILL_LIMITS.description) return "bot.skills.problem.descriptionLong";
  if (!form.body.trim()) return "bot.skills.problem.body";
  if (form.body.length > SKILL_LIMITS.body) return "bot.skills.problem.bodyLong";
  return null;
}

export function isSkillFormDirty(skill: BotSkill | null, form: SkillForm): boolean {
  if (!skill) return form.name.trim() !== "" || form.description.trim() !== "" || form.body.trim() !== "";
  return form.description.trim() !== skill.description || form.body.trim() !== skill.body;
}

const ORIGIN_KEY: Record<SkillOrigin, MessageKey> = {
  person: "bot.skills.origin.person",
  bot: "bot.skills.origin.bot",
  template: "bot.skills.origin.template",
  recording: "bot.skills.origin.recording",
};

export function originKey(origin: SkillOrigin): MessageKey {
  switch (origin) {
    case "person":
    case "bot":
    case "template":
    case "recording":
      return ORIGIN_KEY[origin];
    default: {
      const unhandled: never = origin;
      throw new Error(`Unhandled skill origin: ${String(unhandled)}`);
    }
  }
}

export interface RevisionRow {
  id: string;
  /** The skill's version after this change. */
  version: number;
  author: SkillRevision["author"];
  at: number;
  created: boolean;
  rolledBack: boolean;
  /** The newest change: what the skill says now, so there is nothing to put back. */
  current: boolean;
}

/** The history as rows, newest first as the host sends it, with the newest marked as what the skill says now. */
export function revisionRows(revisions: readonly SkillRevision[]): RevisionRow[] {
  return revisions.map((revision, index) => ({
    id: revision.id,
    version: revision.resultVersion,
    author: revision.author,
    at: revision.atMs,
    created: revision.created,
    rolledBack: revision.rolledBack,
    current: index === 0,
  }));
}
