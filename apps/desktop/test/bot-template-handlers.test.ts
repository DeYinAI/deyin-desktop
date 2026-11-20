import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  BOT_CATALOG,
  BotStore,
  FileStorage,
  parseBotTemplate,
  stringifyBotTemplate,
  templateLink,
  type Automation,
  type BotTemplate,
} from "@deyin/host-core";
import { BotSkillStores } from "../src/main/bots/skills-handlers.js";
import { createTemplateHandlers, templateFromPasted, type TemplateRoutines } from "../src/main/bots/template-handlers.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type NewRoutine = Parameters<TemplateRoutines["create"]>[0];

function setup(options: { refuse?: (input: NewRoutine, made: number) => string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deyin-templates-"));
  dirs.push(dir);
  const storage = new FileStorage(dir);
  storages.push(storage);
  const store = new BotStore(storage);
  const stores = new BotSkillStores(store);
  const made: NewRoutine[] = [];
  const existing: Automation[] = [];
  const routines: TemplateRoutines = {
    of: (botId) => existing.filter((automation) => automation.botId === botId),
    create: (input) => {
      const refusal = options.refuse?.(input, made.length);
      if (refusal) throw new Error(refusal);
      made.push(input);
    },
  };
  const handlers = createTemplateHandlers({ store, stores, routines });
  return { dir, store, stores, routines, made, existing, handlers };
}

const CHOICES = { model: "glm-5.2", providerId: "openference" };

function ok<T>(result: { ok: true; value: T } | { ok: false; error: string; code: string }): T {
  assert.ok(result.ok, result.ok ? "" : `${result.code}: ${result.error}`);
  return (result as { ok: true; value: T }).value;
}

function routine(over: Partial<Automation> = {}): Automation {
  return {
    id: "auto_1",
    botId: "bot_x",
    name: "Morning digest",
    enabled: true,
    payload: { kind: "prompt", prompt: "Summarise my inbox." },
    trigger: { kind: "cron", expression: "0 8 * * *" },
    target: { kind: "local", workspacePath: "/x" },
    model: "glm-5.2",
    providerId: "openference",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const TEMPLATE: BotTemplate = {
  format: "deyin.bot-template",
  version: 1,
  name: "Scribe",
  title: "Writes things",
  description: "Writes short updates.",
  role: "assistant",
  purpose: "Write updates from notes.",
  publicDescription: "Writes short updates.",
  skills: [{ name: "update", description: "Write an update", body: "1. Read the notes" }],
  routines: [
    { name: "Daily", prompt: "Write today's update.", schedule: { kind: "cron", expression: "30 8 * * 1-5" } },
    { name: "On demand", prompt: "Write one now.", schedule: { kind: "manual" } },
  ],
};

/* Export --------------------------------------------------------------------------- */

test("a Bot is handed on as its identity, its skills and its routines, and as nothing else it has", async () => {
  const t = setup();
  const bot = t.store.create({ name: "Ada", title: "Researcher", purpose: "Find sources.", description: "Finds things.", approvalMode: "run_everything", harness: "server", hostId: "host_secret" });
  await t.stores.of(bot.id).save({ name: "cite", description: "Cite sources", body: "1. Quote the page" }, { author: "person", origin: "person" });
  t.existing.push(routine({ botId: bot.id }), routine({ id: "auto_2", botId: bot.id, name: "By hand", trigger: { kind: "manual" } }));
  const exported = ok(await t.handlers.export(bot.id));
  const template = parseBotTemplate(exported.text);
  assert.equal(template.name, "Ada");
  assert.equal(template.purpose, "Find sources.");
  assert.deepEqual(template.skills, [{ name: "cite", description: "Cite sources", body: "1. Quote the page" }]);
  assert.deepEqual(template.routines.map((r) => [r.name, r.schedule.kind]), [["Morning digest", "cron"], ["By hand", "manual"]]);
  for (const mine of ["bot_", "glm-5.2", "openference", "/x", "hostId", "host_secret", "server", "run_everything", "memory", "vault", "permission"]) {
    assert.equal(exported.text.includes(mine), false, `"${mine}" does not travel`);
  }
  assert.deepEqual(exported.warnings, []);
  assert.deepEqual(exported.summary.skills, [{ name: "cite", description: "Cite sources" }]);
  assert.ok(exported.link?.startsWith("deyin://bot/import?t="));
  assert.deepEqual(parseBotTemplate(exported.link!.length ? templateFromPastedText(exported.link!) : ""), template);
});

function templateFromPastedText(link: string): string {
  return stringifyBotTemplate(templateFromPasted(link));
}

test("a routine that cannot travel is left out and counted, and routines can be left out on purpose", async () => {
  const t = setup();
  const bot = t.store.create({ name: "Ada" });
  t.existing.push(
    routine({ botId: bot.id }),
    routine({ id: "a2", botId: bot.id, payload: { kind: "skill", skill: "x" } as never }),
    routine({ id: "a3", botId: bot.id, trigger: { kind: "once", at: 5 } as never }),
  );
  const exported = ok(await t.handlers.export(bot.id));
  assert.equal(parseBotTemplate(exported.text).routines.length, 1);
  assert.deepEqual(exported.warnings, ["2 routines were left out: only a routine that sends a prompt, on a schedule or by hand, can be shared."]);
  const without = ok(await t.handlers.export(bot.id, { includeRoutines: false }));
  assert.deepEqual(parseBotTemplate(without.text).routines, []);
  assert.deepEqual(without.warnings, []);
  t.existing.length = 1;
  t.existing.push(routine({ id: "a2", botId: bot.id, payload: { kind: "skill", skill: "x" } as never }));
  assert.match(ok(await t.handlers.export(bot.id)).warnings[0]!, /^1 routine was left out/);
});

test("a Bot too big for a link says so and still gives its text", async () => {
  const t = setup();
  const bot = t.store.create({ name: "Big" });
  for (let n = 0; n < 3; n += 1) await t.stores.of(bot.id).save({ name: `s${n}`, description: "d", body: "x".repeat(5_000) }, { author: "person", origin: "person" });
  const exported = ok(await t.handlers.export(bot.id));
  assert.equal(exported.link, null);
  assert.deepEqual(exported.warnings, ["This Bot is too big to fit in a link, so share its text or save it as a file instead."]);
  assert.equal(parseBotTemplate(exported.text).skills.length, 3);
});

test("a Bot that is gone, a room, or not an id cannot be exported", async () => {
  const t = setup();
  const a = t.store.create({ name: "A" });
  const b = t.store.create({ name: "B" });
  const room = t.store.create({ name: "Room", kind: "room", memberBotIds: [a.id, b.id] });
  assert.deepEqual(await t.handlers.export("nope"), { ok: false, error: "That Bot no longer exists.", code: "not_found" });
  const refused = await t.handlers.export(room.id);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /is a room/);
  for (const bad of [undefined, 5, null]) assert.equal((await t.handlers.export(bad)).ok, false);
  assert.equal((await t.handlers.export(a.id, "nope")).ok, false, "choices must be an object");
});

/* Import --------------------------------------------------------------------------- */

test("an imported Bot is a new Bot with the template's skills, and its routines are added paused on the model the person chose", async () => {
  const t = setup();
  const result = ok(await t.handlers.import(stringifyBotTemplate(TEMPLATE), CHOICES));
  assert.equal(result.bot.name, "Scribe");
  assert.equal(result.bot.harness, "local", "where it runs is for the new owner to set");
  assert.equal(result.bot.autoReview.approvalMode, "auto_review", "and what it may do is the default, not what the sender had");
  assert.equal(result.skills, 1);
  assert.equal(result.routines, 2);
  const skills = await t.stores.of(result.bot.id).list();
  assert.deepEqual(skills.map((s) => [s.name, s.origin]), [["update", "template"]]);
  assert.deepEqual(t.made.map((r) => [r.name, r.enabled, r.trigger.kind, r.botId, r.model, r.providerId]), [
    ["Daily", false, "cron", result.bot.id, "glm-5.2", "openference"],
    ["On demand", false, "manual", result.bot.id, "glm-5.2", "openference"],
  ]);
  assert.deepEqual(result.warnings, ["2 routines were added paused. Turn on the ones you want from the Routines page."]);
});

test("a link works as well as the text, and surrounding words or a code fence do not matter", async () => {
  const t = setup();
  const link = templateLink(TEMPLATE)!;
  assert.equal(ok(await t.handlers.import(link, CHOICES)).bot.name, "Scribe");
  assert.equal(ok(await t.handlers.import(`  ${link}\n`, CHOICES)).bot.name, "Scribe");
  assert.equal(ok(await t.handlers.import("```json\n" + stringifyBotTemplate(TEMPLATE) + "\n```", CHOICES)).bot.name, "Scribe");
  assert.equal(t.store.list().filter((bot) => bot.name === "Scribe").length, 3, "importing twice makes two Bots, never overwrites one");
  const handles = new Set(t.store.list().map((bot) => bot.handle));
  assert.equal(handles.size, t.store.list().length, "each has its own handle");
});

test("preview says what an import would do without making anything", async () => {
  const t = setup();
  const preview = ok(await t.handlers.preview(stringifyBotTemplate(TEMPLATE)));
  assert.deepEqual(preview.summary, {
    name: "Scribe",
    title: "Writes things",
    description: "Writes short updates.",
    skills: [{ name: "update", description: "Write an update" }],
    routines: [{ name: "Daily", scheduled: true }, { name: "On demand", scheduled: false }],
  });
  assert.equal(t.store.list().length, 0);
  assert.equal(t.made.length, 0);
});

test("something that is not a Bot, or a link that carries nothing, is refused in words and makes nothing", async () => {
  const t = setup();
  for (const bad of ["", "hello", "{}", "deyin://bot/import?t=!!!", "deyin://bot/import", '{"format":"other"}', JSON.stringify({ ...TEMPLATE, version: 99 })]) {
    for (const call of [() => t.handlers.preview(bad), () => t.handlers.import(bad, CHOICES)]) {
      const result = await call();
      assert.equal(result.ok, false, bad);
      if (!result.ok) assert.equal(result.code, "invalid", bad);
    }
  }
  for (const bad of [undefined, null, 5, {}]) assert.equal((await t.handlers.import(bad, CHOICES)).ok, false);
  assert.equal(t.store.list().length, 0);
});

test("the choices came from a page: without a model the routines are not added, and each says why, but the Bot and its skills are", async () => {
  const t = setup();
  const result = ok(await t.handlers.import(stringifyBotTemplate(TEMPLATE), { model: "  ", providerId: "openference" }));
  assert.equal(result.skills, 1);
  assert.equal(result.routines, 0);
  assert.equal(t.made.length, 0);
  assert.deepEqual(result.warnings, [
    '"Daily" was not added: pick a model first, then add it from the Routines page.',
    '"On demand" was not added: pick a model first, then add it from the Routines page.',
  ]);
  for (const bad of [undefined, null, "x", 5]) assert.equal((await t.handlers.import(stringifyBotTemplate(TEMPLATE), bad)).ok, false);
  const noProvider = ok(await t.handlers.import(stringifyBotTemplate(TEMPLATE), { model: "glm-5.2" }));
  assert.equal(noProvider.routines, 0);
});

test("a routine the app will not take (too many, too often) is said, and the rest of the import goes ahead", async () => {
  const t = setup({ refuse: (input) => (input.name === "Daily" ? "A Bot can have 50 routines." : null) });
  const result = ok(await t.handlers.import(stringifyBotTemplate(TEMPLATE), CHOICES));
  assert.equal(result.routines, 1);
  assert.deepEqual(result.warnings, ['"Daily" was not added: A Bot can have 50 routines.', "1 routine was added paused. Turn on the ones you want from the Routines page."]);
  assert.equal(t.store.list().length, 1);
});

test("an import that cannot finish leaves no Bot behind, and no folder", async () => {
  const t = setup();
  const failing = { ...TEMPLATE, skills: [{ name: "BAD NAME", description: "d", body: "b" }] } as unknown as BotTemplate;
  const bad = await t.handlers.import(JSON.stringify(failing), CHOICES);
  assert.equal(bad.ok, false, "a template with a skill that cannot be saved is refused when read");
  assert.equal(t.store.list().length, 0);

  const original = t.stores.of;
  let created = "";
  t.stores.of = (botId: unknown) => {
    created = botId as string;
    const real = original.call(t.stores, botId);
    real.save = async () => {
      throw new Error("the disk is full");
    };
    return real;
  };
  await assert.rejects(() => t.handlers.import(stringifyBotTemplate(TEMPLATE), CHOICES), /the disk is full/);
  assert.equal(t.store.list().length, 0, "the Bot made first was taken away again");
  assert.equal(existsSync(join(t.dir, "bots", created)), false);
});

test("a person with the most Bots allowed is told, and nothing else is made", async () => {
  const t = setup();
  for (let n = 0; n < 100; n += 1) t.store.create({ name: `Bot ${n}` });
  const result = await t.handlers.import(stringifyBotTemplate(TEMPLATE), CHOICES);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "limit");
  assert.equal(t.made.length, 0);
});

/* Catalog ------------------------------------------------------------------------ */

test("the catalog lists every starter, and the ones a person already has are marked", async () => {
  const t = setup();
  const listing = ok(t.handlers.catalog());
  assert.deepEqual(listing.browse.map((c) => c.id), BOT_CATALOG.map((e) => e.id));
  assert.equal(listing.browse.every((c) => !c.have), true);
  const first = listing.browse[0]!;
  assert.deepEqual(Object.keys(first).sort(), ["blurb", "category", "derivedFrom", "have", "id", "name", "routines", "skills", "tags", "title"]);
  assert.equal(JSON.stringify(listing).includes("purpose"), false, "the full instructions stay here until a starter is added");
  ok(await t.handlers.importCatalog("pitch-coach", CHOICES));
  const after = ok(t.handlers.catalog());
  assert.deepEqual(after.browse.filter((c) => c.have).map((c) => c.id), ["pitch-coach"]);
  assert.equal(after.forYou.at(-1)!.id, "pitch-coach", "what they have goes last in For You");
});

test("a starter that was archived still counts as had, so it is not offered again as new", async () => {
  const t = setup();
  const made = ok(await t.handlers.importCatalog("standup-scribe", CHOICES));
  t.store.archive(made.bot.id);
  assert.deepEqual(ok(t.handlers.catalog()).browse.filter((c) => c.have).map((c) => c.id), ["standup-scribe"]);
});

test("search and category narrow Browse and leave For You whole; a bad category is ignored", () => {
  const t = setup();
  assert.deepEqual(ok(t.handlers.catalog("standup")).browse.map((c) => c.id), ["standup-scribe"]);
  assert.equal(ok(t.handlers.catalog("standup")).forYou.length, BOT_CATALOG.length);
  assert.deepEqual(ok(t.handlers.catalog("", "dev")).browse.map((c) => c.id), ["release-notes-writer", "bug-report-triager"]);
  assert.equal(ok(t.handlers.catalog("", "nonsense")).browse.length, BOT_CATALOG.length);
  assert.equal(ok(t.handlers.catalog(5, 5)).browse.length, BOT_CATALOG.length);
});

test("For You follows what the person's own Bots are for", async () => {
  const t = setup();
  t.store.create({ name: "Changelog helper", purpose: "Writes release notes and a changelog from git commits." });
  assert.equal(ok(t.handlers.catalog()).forYou[0]!.id, "release-notes-writer");
});

test("a starter becomes a Bot that remembers which starter it was, with its skills and routines paused", async () => {
  const t = setup();
  const result = ok(await t.handlers.importCatalog("standup-scribe", CHOICES));
  assert.equal(result.bot.name, "Standup Scribe");
  assert.equal(result.bot.legacyBotId, "catalog:standup-scribe");
  assert.deepEqual((await t.stores.of(result.bot.id).list()).map((s) => [s.name, s.origin]), [["standup-update", "template"]]);
  assert.deepEqual(t.made.map((r) => [r.name, r.enabled]), [["Draft the weekday standup", false]]);
});

test("a starter that is not in the catalog is not found, and one that is not text is refused", async () => {
  const t = setup();
  assert.deepEqual(await t.handlers.importCatalog("nope", CHOICES), { ok: false, error: "That starter is no longer in the catalog.", code: "not_found" });
  assert.equal((await t.handlers.importCatalog(5, CHOICES)).ok, false);
  assert.equal(t.store.list().length, 0);
});

test("a pasted Bot that is a plain template and one wrapped in a link give the same template", () => {
  const text = stringifyBotTemplate(TEMPLATE);
  assert.deepEqual(templateFromPasted(text), TEMPLATE);
  assert.deepEqual(templateFromPasted(templateLink(TEMPLATE)!), TEMPLATE);
});
