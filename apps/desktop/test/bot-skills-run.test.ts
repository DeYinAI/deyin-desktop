import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { discoverSkills, loadSkill, skillTool, skillsPromptSection, type SkillDefinition, type ToolContext } from "@deyin/agent-core";
import { BotSkillStore, BotStore, FileStorage } from "@deyin/host-core";
import { resolveBotRun } from "../src/main/bots/run.js";
import { BOT_SKILL_SOURCE, withBotSkills } from "../src/main/bots/skills-run.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "deyin-botskills-"));
  dirs.push(dir);
  return dir;
}

const shared = (name: string, description = "A shared skill"): SkillDefinition => ({ name, description, path: `/shared/${name}/SKILL.md`, source: "user", disableModelInvocation: false });
const mine = { author: "person", origin: "person" } as const;

test("a Bot's skills sit in its own folder, which is where its run looks", () => {
  const dir = tmp();
  const storage = new FileStorage(dir);
  storages.push(storage);
  const store = new BotStore(storage);
  const bot = store.create({ name: "Ada" });
  const resolved = resolveBotRun({ store, botsDir: join(dir, "bots") }, bot.id);
  assert.ok(resolved.ok);
  if (!resolved.ok) return;
  assert.equal(resolved.value.skills.root, join(dir, "bots", bot.id, "skills"));
  assert.equal(existsSync(resolved.value.skills.root), false, "a Bot that has learned nothing has no folder for it");
  assert.deepEqual(readdirSync(join(dir, "bots", bot.id)), ["files"]);
});

test("the agent reads exactly what the store wrote, whatever is in the words", async () => {
  const root = join(tmp(), "skills");
  const store = new BotSkillStore(root);
  const tricky = [
    { name: "colon", description: 'Use when: asked to "file the report" [today], not tomorrow', body: "1. Step one\n2. Step two" },
    { name: "true-ish", description: "true", body: "Body for a skill whose description reads as a yes." },
    { name: "numeric", description: "12345", body: "Body." },
    { name: "single-quote", description: "It's Ada's skill, don't forget it", body: "Body." },
    { name: "hash", description: "# not a comment", body: "---\nnot a fence\n---\nBody after a rule." },
    { name: "plain", description: "A plain one.", body: "# Heading\n\nParagraph." },
  ];
  for (const skill of tricky) await store.save(skill, mine);
  const found = await discoverSkills([{ dir: root, source: BOT_SKILL_SOURCE }]);
  assert.deepEqual(
    found.map((skill) => [skill.name, skill.description, skill.source, skill.disableModelInvocation]).sort(),
    tricky.map((skill) => [skill.name, skill.description, BOT_SKILL_SOURCE, false]).sort(),
  );
  for (const skill of tricky) {
    const loaded = await loadSkill(join(root, skill.name, "SKILL.md"), BOT_SKILL_SOURCE);
    assert.equal(loaded?.description, skill.description, skill.name);
  }
});

test("the skill tool hands the Bot the instructions it was taught, and the prompt lists the skill by name", async () => {
  const root = join(tmp(), "skills");
  await new BotSkillStore(root).save({ name: "weekly-report", description: "Write the weekly report", body: "1. Open the sheet\n2. Summarise it" }, mine);
  const { skills } = await withBotSkills({ skills: [] as SkillDefinition[] }, root);
  const out = await skillTool.execute({ skill_name: "weekly-report", context: "for Friday" }, { skills } as unknown as ToolContext);
  assert.match(out, /^## Skill: weekly-report\n\nWrite the weekly report\n\n/);
  assert.match(out, /1\. Open the sheet\n2\. Summarise it/);
  assert.match(out, /### Context\nfor Friday$/);
  const prompt = skillsPromptSection(skills);
  assert.match(prompt ?? "", /- weekly-report: Write the weekly report \(.*weekly-report\/SKILL\.md\)/);
});

test("a Bot's skills come first, and a Bot's skill hides a shared one of the same name", async () => {
  const root = join(tmp(), "skills");
  const store = new BotSkillStore(root);
  await store.save({ name: "report", description: "The Bot's own way", body: "Do it my way." }, mine);
  await store.save({ name: "extra", description: "Only the Bot has it", body: "Extra." }, mine);
  const caps = { skills: [shared("report", "The shared way"), shared("other")], subagents: ["kept"] };
  const result = await withBotSkills(caps, root);
  assert.deepEqual(result.skills.map((skill) => [skill.name, skill.source]), [
    ["extra", "bot"],
    ["report", "bot"],
    ["other", "user"],
  ]);
  assert.equal(result.skills.find((skill) => skill.name === "report")?.description, "The Bot's own way");
  assert.deepEqual(result.subagents, ["kept"], "nothing else about what the run can use is touched");
  assert.equal(caps.skills.length, 2, "the list it was given is not changed");
});

test("a Bot with no skills, no folder, or no place to look leaves what the run can use exactly as it was", async () => {
  const caps = { skills: [shared("a")] };
  assert.equal(await withBotSkills(caps, undefined), caps);
  assert.equal(await withBotSkills(caps, join(tmp(), "nothing-here")), caps);
  const empty = join(tmp(), "skills");
  mkdirSync(empty, { recursive: true });
  assert.equal(await withBotSkills(caps, empty), caps);
});

test("a skill file a person put in the folder by hand is used, and a folder that is not a skill is not", async () => {
  const root = join(tmp(), "skills");
  mkdirSync(join(root, "by-hand"), { recursive: true });
  writeFileSync(join(root, "by-hand", "SKILL.md"), "---\nname: by-hand\ndescription: Made in an editor\n---\n\n1. Do the thing\n");
  mkdirSync(join(root, "not-a-skill"), { recursive: true });
  writeFileSync(join(root, "not-a-skill", "notes.txt"), "just notes");
  const { skills } = await withBotSkills({ skills: [] as SkillDefinition[] }, root);
  assert.deepEqual(skills.map((skill) => [skill.name, skill.description]), [["by-hand", "Made in an editor"]]);
});

test("a skill saved while a run is starting is seen by the next run, and one removed is gone from it", async () => {
  const root = join(tmp(), "skills");
  const store = new BotSkillStore(root);
  assert.deepEqual((await withBotSkills({ skills: [] as SkillDefinition[] }, root)).skills, []);
  await store.save({ name: "later", description: "Learned later", body: "1. Go" }, mine);
  assert.deepEqual((await withBotSkills({ skills: [] as SkillDefinition[] }, root)).skills.map((skill) => skill.name), ["later"]);
  await store.remove("later");
  assert.deepEqual((await withBotSkills({ skills: [] as SkillDefinition[] }, root)).skills, []);
});
