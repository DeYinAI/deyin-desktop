import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SKILL_LIMITS, SKILL_ORIGINS, missingTranslations, type BotSkill, type BotSkillSummary, type SkillRevision } from "@deyin/host-core/shared";
import { BotSkillsPanel, type SkillEditor, type SkillHistory, type SkillsState } from "../src/bots/BotSkills.js";
import {
  emptySkillForm,
  isSkillFormDirty,
  originKey,
  revisionRows,
  skillFormFromDraft,
  skillFormFromSkill,
  skillFormProblem,
  skillPayload,
  type SkillForm,
} from "../src/bots/botSkills.js";

const noop = () => undefined;

function summary(over: Partial<BotSkillSummary> = {}): BotSkillSummary {
  return { name: "weekly-report", description: "Write the weekly report", origin: "person", version: 2, updatedAt: 1, bytes: 40, ...over };
}

function skill(over: Partial<BotSkill> = {}): BotSkill {
  return { ...summary(), body: "1. Open the sheet", ...over };
}

function revision(over: Partial<SkillRevision> = {}): SkillRevision {
  return { id: "r1", skill: "weekly-report", atMs: 1_700_000_000_000, author: "person", content: "x", description: "d", resultVersion: 1, created: false, rolledBack: false, ...over };
}

function form(over: Partial<SkillForm> = {}): SkillForm {
  return { name: "weekly-report", description: "Write the report", body: "1. Open the sheet", version: null, ...over };
}

test("a new skill needs a valid name, a description and steps; the first thing wrong is reported", () => {
  assert.equal(skillFormProblem(form()), null);
  assert.equal(skillFormProblem(form({ name: "Weekly Report" })), "bot.skills.problem.name");
  assert.equal(skillFormProblem(form({ name: "" })), "bot.skills.problem.name");
  assert.equal(skillFormProblem(form({ name: "-x" })), "bot.skills.problem.name");
  assert.equal(skillFormProblem(form({ name: "x".repeat(SKILL_LIMITS.name + 1) })), "bot.skills.problem.name");
  assert.equal(skillFormProblem(form({ name: "x".repeat(SKILL_LIMITS.name) })), null);
  assert.equal(skillFormProblem(form({ description: "  " })), "bot.skills.problem.description");
  assert.equal(skillFormProblem(form({ description: "d".repeat(SKILL_LIMITS.description + 1) })), "bot.skills.problem.descriptionLong");
  assert.equal(skillFormProblem(form({ description: "d".repeat(SKILL_LIMITS.description) })), null);
  assert.equal(skillFormProblem(form({ body: " \n " })), "bot.skills.problem.body");
  assert.equal(skillFormProblem(form({ body: "b".repeat(SKILL_LIMITS.body + 1) })), "bot.skills.problem.bodyLong");
  assert.equal(skillFormProblem(form({ body: "b".repeat(SKILL_LIMITS.body) })), null);
  // Several wrong at once: the name comes first, since it is the first thing asked.
  assert.equal(skillFormProblem(form({ name: "BAD", description: "", body: "" })), "bot.skills.problem.name");
});

test("a skill that exists keeps its name, so the name is not checked again", () => {
  assert.equal(skillFormProblem(form({ name: "Legacy Name", version: 3 })), null);
  assert.equal(skillFormProblem(form({ version: 3, description: "" })), "bot.skills.problem.description");
});

test("the payload trims the name and description but leaves the steps as written", () => {
  assert.deepEqual(skillPayload(form({ name: " weekly-report ", description: "  Write it ", body: "  1. a\n2. b\n" })), {
    name: "weekly-report",
    description: "Write it",
    body: "  1. a\n2. b\n",
  });
});

test("forms are made from a skill, from a draft, and empty; only a skill that exists has a version", () => {
  assert.deepEqual(emptySkillForm(), { name: "", description: "", body: "", version: null });
  assert.deepEqual(skillFormFromSkill(skill({ version: 4 })), { name: "weekly-report", description: "Write the weekly report", body: "1. Open the sheet", version: 4 });
  assert.deepEqual(skillFormFromDraft({ name: "download-report", description: "Get it", body: "1. Click" }), { name: "download-report", description: "Get it", body: "1. Click", version: null });
});

test("dirty means changed from what was opened; for a new skill, anything typed", () => {
  const open = skill();
  assert.equal(isSkillFormDirty(open, skillFormFromSkill(open)), false);
  assert.equal(isSkillFormDirty(open, { ...skillFormFromSkill(open), description: "Write the weekly report " }), false, "trailing space is not a change");
  assert.equal(isSkillFormDirty(open, { ...skillFormFromSkill(open), description: "Other" }), true);
  assert.equal(isSkillFormDirty(open, { ...skillFormFromSkill(open), body: "changed" }), true);
  assert.equal(isSkillFormDirty(null, emptySkillForm()), false);
  assert.equal(isSkillFormDirty(null, { ...emptySkillForm(), name: "a" }), true);
  assert.equal(isSkillFormDirty(null, { ...emptySkillForm(), description: "a" }), true);
  assert.equal(isSkillFormDirty(null, { ...emptySkillForm(), body: "a" }), true);
  assert.equal(isSkillFormDirty(null, { ...emptySkillForm(), body: "  " }), false);
});

test("every origin has its own words, and they exist in every language", () => {
  const keys = SKILL_ORIGINS.map(originKey);
  assert.equal(new Set(keys).size, SKILL_ORIGINS.length);
  for (const locale of ["zh", "de"] as const) {
    assert.deepEqual(missingTranslations(locale).filter((key) => key.startsWith("bot.skills.")), [], locale);
  }
});

test("revision rows keep the host's order and mark only the newest as what the skill says now", () => {
  const rows = revisionRows([revision({ id: "r3", resultVersion: 3, rolledBack: true }), revision({ id: "r2", resultVersion: 2, author: "bot" }), revision({ id: "r1", resultVersion: 1, created: true })]);
  assert.deepEqual(
    rows.map((row) => [row.id, row.version, row.current]),
    [
      ["r3", 3, true],
      ["r2", 2, false],
      ["r1", 1, false],
    ],
  );
  assert.equal(rows[0]?.rolledBack, true);
  assert.equal(rows[1]?.author, "bot");
  assert.equal(rows[2]?.created, true);
  assert.equal(rows[0]?.at, 1_700_000_000_000);
  assert.deepEqual(revisionRows([]), []);
});

interface Over {
  state?: SkillsState;
  notice?: string | null;
  editor?: SkillEditor | null;
  history?: SkillHistory | null;
}

function render(over: Over = {}): string {
  return renderToStaticMarkup(
    createElement(BotSkillsPanel, {
      state: over.state ?? { status: "ready", skills: [] },
      notice: over.notice ?? null,
      editor: over.editor ?? null,
      history: over.history ?? null,
      onNew: noop,
      onEdit: noop,
      onRemove: noop,
      onHistory: noop,
      onRevert: noop,
      onCloseHistory: noop,
      onChangeForm: noop,
      onSave: noop,
      onCancel: noop,
    }),
  );
}

function editor(over: Partial<SkillEditor> = {}): SkillEditor {
  return { form: emptySkillForm(), source: "person", busy: false, error: null, ...over };
}

test("loading and a failed load are said, with nothing to add to yet", () => {
  const loading = render({ state: { status: "loading" } });
  assert.match(loading, /role="status"[^>]*>Loading skills…/);
  assert.doesNotMatch(loading, /Add a skill/);
  const failed = render({ state: { status: "error", error: "ipc closed" } });
  assert.match(failed, /role="alert"[^>]*>Couldn&#x27;t load the skills\. ipc closed/);
  assert.doesNotMatch(failed, /Add a skill/);
});

test("a Bot with no skills explains what one is and offers to add one", () => {
  const html = render();
  assert.match(html, /No skills yet\./);
  assert.match(html, />Add a skill</);
  assert.doesNotMatch(html, /bot-panel__list/);
});

test("each skill shows its name, what it is for, where it came from and its version, with Edit, History and Remove", () => {
  const html = render({
    state: { status: "ready", skills: [summary(), summary({ name: "triage", description: "Sort the inbox", origin: "recording", version: 1 })] },
  });
  assert.match(html, /bot-panel__name">weekly-report</);
  assert.match(html, /bot-panel__meta">Write the weekly report</);
  assert.match(html, /written by you · version 2</);
  assert.match(html, /bot-panel__name">triage</);
  assert.match(html, /taught by showing · version 1</);
  assert.equal(html.match(/>Edit</g)?.length, 2);
  assert.equal(html.match(/>History</g)?.length, 2);
  assert.equal(html.match(/>Remove</g)?.length, 2);
});

test("a skill's words are escaped, never taken as markup", () => {
  const html = render({ state: { status: "ready", skills: [summary({ name: "x", description: "<img src=x onerror=alert(1)>" })] } });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("at the most skills a Bot can have, adding says why it cannot instead of offering to", () => {
  const skills = Array.from({ length: SKILL_LIMITS.perBot }, (_, index) => summary({ name: `skill-${index}` }));
  const full = render({ state: { status: "ready", skills } });
  assert.match(full, /A Bot can have 100 skills\. Remove one to add another\./);
  assert.doesNotMatch(full, />Add a skill</);
  const one = render({ state: { status: "ready", skills: skills.slice(1) } });
  assert.match(one, />Add a skill</);
  assert.doesNotMatch(one, /A Bot can have/);
});

test("while a skill is being written the Add button gives way to the form", () => {
  const html = render({ editor: editor() });
  assert.doesNotMatch(html, /<button[^>]*>Add a skill</);
  assert.match(html, /<form[^>]*aria-label="Add a skill"/);
  assert.match(html, /id="skill-name"[^>]*maxLength="64"/);
  assert.doesNotMatch(html, /id="skill-name"[^>]*readonly=""/);
  assert.match(html, /Lowercase words with hyphens between/);
});

test("a new skill's Save is off until the form is whole, and what is missing is said once something is typed", () => {
  const untouched = render({ editor: editor() });
  assert.match(untouched, /<button type="submit"[^>]*disabled=""[^>]*>Save</);
  assert.doesNotMatch(untouched, /Name the skill with lowercase/, "nothing is scolded before the person has typed");
  const typed = render({ editor: editor({ form: form({ name: "Bad Name" }) }) });
  assert.match(typed, /role="status"[^>]*>Name the skill with lowercase letters/);
  assert.match(typed, /<button type="submit"[^>]*disabled=""/);
  const ready = render({ editor: editor({ form: form() }) });
  assert.doesNotMatch(ready, /<button type="submit"[^>]*disabled=""/);
});

test("editing a skill that exists shows its name fixed, and a host refusal replaces the hint", () => {
  const html = render({ editor: editor({ form: form({ version: 2 }), error: "Someone else changed this skill. Reload it." }) });
  assert.match(html, /aria-label="Edit weekly-report"/);
  assert.match(html, /id="skill-name"[^>]*readonly=""/);
  assert.match(html, /A skill keeps its name\./);
  assert.match(html, /role="alert"[^>]*>Someone else changed this skill\. Reload it\./);
});

test("while saving, the form cannot be changed or sent again", () => {
  const html = render({ editor: editor({ form: form(), busy: true }) });
  assert.match(html, /<input id="skill-name"[^>]*disabled=""/);
  assert.match(html, /<textarea id="skill-body"[^>]*disabled=""/);
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Saving…</);
  assert.match(html, /<button type="button"[^>]*disabled=""[^>]*>Cancel</);
});

test("the history lists versions newest first; the newest cannot be put back, the others can", () => {
  const rows = revisionRows([revision({ id: "r2", resultVersion: 2, author: "bot", rolledBack: false }), revision({ id: "r1", resultVersion: 1, created: true })]);
  const html = render({ history: { skill: "weekly-report", rows, busy: false, error: null } });
  assert.match(html, /aria-label="Earlier versions of weekly-report"/);
  assert.match(html, /bot-panel__name">version 2</);
  assert.match(html, /The Bot · /);
  assert.match(html, /bot-panel__badge">now</);
  assert.match(html, /bot-panel__badge">made the skill</);
  const putBack = html.match(/<button[^>]*>Put back<\/button>/g) ?? [];
  assert.equal(putBack.length, 2);
  assert.match(putBack[0] ?? "", /disabled=""/);
  assert.doesNotMatch(putBack[1] ?? "", /disabled=""/);
});

test("putting a version back is blocked while one is being put back, and a refusal is shown", () => {
  const rows = revisionRows([revision({ id: "r2", resultVersion: 2 }), revision({ id: "r1", resultVersion: 1 })]);
  const html = render({ history: { skill: "weekly-report", rows, busy: true, error: "That version is gone." } });
  assert.match(html, /role="alert"[^>]*>That version is gone\./);
  assert.equal((html.match(/<button[^>]*disabled=""[^>]*>Put back</g) ?? []).length, 2);
});

test("a notice and the caller's own sections both appear", () => {
  const html = renderToStaticMarkup(
    createElement(
      BotSkillsPanel,
      {
        state: { status: "ready", skills: [] },
        notice: "That skill is gone.",
        editor: null,
        history: null,
        onNew: noop,
        onEdit: noop,
        onRemove: noop,
        onHistory: noop,
        onRevert: noop,
        onCloseHistory: noop,
        onChangeForm: noop,
        onSave: noop,
        onCancel: noop,
      },
      createElement("p", { id: "taught" }, "taught tasks"),
    ),
  );
  assert.match(html, /role="alert"[^>]*>That skill is gone\./);
  assert.match(html, /<p id="taught">taught tasks<\/p>/);
});
