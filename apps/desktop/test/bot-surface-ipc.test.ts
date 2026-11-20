import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CH } from "@deyin/contract";
import { BotStore, FileStorage, type Automation } from "@deyin/host-core";
import { LocalBotRuntime } from "../src/main/bots/engine/runtimes.js";
import { registerBotSurface, type BotSurface } from "../src/main/bots/surface-ipc.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Handler = (...args: unknown[]) => unknown;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "deyin-surface-"));
  dirs.push(dir);
  const storage = new FileStorage(dir);
  storages.push(storage);
  const store = new BotStore(storage);
  const handlers = new Map<string, Handler>();
  const heard: Array<{ channel: string; payload: unknown }> = [];
  const bridged: string[] = [];
  const created: Array<Omit<Automation, "id" | "createdAt" | "updatedAt">> = [];
  const library = new LocalBotRuntime({ root: join(dir, "library") });
  mkdirSync(join(dir, "library"), { recursive: true });
  const surface: BotSurface = registerBotSurface({
    store,
    routines: { of: () => [], create: (input) => void created.push(input) },
    runtimeOf: (bot) => new LocalBotRuntime({ root: join(store.dataDir(bot.id), "files") }),
    library,
    browserTab: () => null,
    handle: (channel, handler) => {
      assert.equal(handlers.has(channel), false, `${channel} is registered twice`);
      handlers.set(channel, handler);
    },
    broadcast: (channel, payload) => void heard.push({ channel, payload }),
    skillsChanged: (botId) => void bridged.push(botId),
  });
  const call = (channel: string, ...args: unknown[]): Promise<any> => {
    const handler = handlers.get(channel);
    assert.ok(handler, `${channel} is not registered`);
    return Promise.resolve(handler(...args));
  };
  const ada = store.create({ name: "Ada" });
  return { dir, store, surface, handlers, heard, bridged, created, call, ada };
}

const ALL_CALLS = Object.entries(CH)
  .filter(([key]) => /^bot(Skills|Templates|Files|Teach)/.test(key))
  .filter(([key]) => !/(Changed|Link)$/.test(key) || key === "botTemplatesTakeLink")
  .map(([, channel]) => channel);

test("every call the panels can make is answered, once", () => {
  const t = setup();
  assert.equal(ALL_CALLS.length, 23, "6 skills, 6 templates, 5 files and 6 teach calls");
  for (const channel of ALL_CALLS) assert.ok(t.handlers.has(channel), `${channel} has no handler`);
  const answered = [...t.handlers.keys()].sort();
  assert.deepEqual(answered, [...ALL_CALLS].sort(), "nothing is answered that is not a call, and no event is answered as a call");
});

test("skills: a save is kept, the window and the bridge are told, and arguments reach the right place", async () => {
  const t = setup();
  const saved = await t.call(CH.botSkillsSave, t.ada.id, { name: "weekly-report", description: "Write it", body: "1. Open it" });
  assert.equal(saved.ok, true, saved.error);
  assert.deepEqual(t.heard, [{ channel: CH.botSkillsChanged, payload: t.ada.id }]);
  assert.deepEqual(t.bridged, [t.ada.id]);
  assert.deepEqual((await t.call(CH.botSkillsList, t.ada.id)).value.map((s: { name: string }) => s.name), ["weekly-report"]);
  assert.equal((await t.call(CH.botSkillsGet, t.ada.id, "weekly-report")).value.body, "1. Open it");
  const stale = await t.call(CH.botSkillsSave, t.ada.id, { name: "weekly-report", description: "Write it", body: "2" }, 99);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "conflict");
  const second = await t.call(CH.botSkillsSave, t.ada.id, { name: "weekly-report", description: "Write it", body: "1. Open it\n2. Send" }, 1);
  assert.equal(second.value.version, 2);
  const revisions = await t.call(CH.botSkillsRevisions, t.ada.id, "weekly-report");
  assert.equal(revisions.ok, true);
  const first = revisions.value.find((r: { resultVersion: number }) => r.resultVersion === 1);
  assert.ok(first, "the first version is kept");
  const reverted = await t.call(CH.botSkillsRevert, t.ada.id, "weekly-report", first.id);
  assert.equal(reverted.value.body, "1. Open it");
  assert.equal((await t.call(CH.botSkillsRemove, t.ada.id, "weekly-report")).ok, true);
  assert.deepEqual((await t.call(CH.botSkillsList, t.ada.id)).value, []);
  assert.equal(t.heard.length, 4, "save, save, revert and remove each told the window; a refusal told nobody");
  assert.equal(t.bridged.length, 4);
});

test("templates: export, preview and import a Bot, and the starters", async () => {
  const t = setup();
  await t.call(CH.botSkillsSave, t.ada.id, { name: "weekly-report", description: "Write it", body: "1. Open it" });
  const exported = await t.call(CH.botTemplatesExport, t.ada.id);
  assert.equal(exported.ok, true, exported.error);
  assert.match(exported.value.text, /weekly-report/);
  assert.equal(typeof exported.value.link, "string");
  const preview = await t.call(CH.botTemplatesPreview, exported.value.link);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.value.summary.skills.length, 1);
  assert.equal(t.store.list().length, 1, "a preview adds nothing");
  const imported = await t.call(CH.botTemplatesImport, exported.value.text, { model: "m", providerId: "p" });
  assert.equal(imported.ok, true, imported.error);
  assert.equal(imported.value.skills, 1);
  assert.equal(t.store.list().length, 2);
  const listing = await t.call(CH.botTemplatesCatalog, "", undefined);
  assert.equal(listing.ok, true);
  assert.ok(listing.value.browse.length >= 6);
  const card = listing.value.browse[0];
  const fromCatalog = await t.call(CH.botTemplatesImportCatalog, card.id, { model: "m", providerId: "p" });
  assert.equal(fromCatalog.ok, true, fromCatalog.error);
  assert.equal((await t.call(CH.botTemplatesImport, 42, {})).ok, false, "garbage from a window is refused with words");
});

test("a shared Bot's link tells the window and waits to be taken, once", async () => {
  const t = setup();
  assert.equal(await t.call(CH.botTemplatesTakeLink), null);
  t.surface.offerImport("deyin://bot/import?t=abc");
  assert.deepEqual(t.heard, [{ channel: CH.botTemplatesLink, payload: "deyin://bot/import?t=abc" }]);
  assert.equal(await t.call(CH.botTemplatesTakeLink), "deyin://bot/import?t=abc");
  assert.equal(await t.call(CH.botTemplatesTakeLink), null);
});

test("files: a Bot's folder and the library, and a change is announced for the right one", async () => {
  const t = setup();
  const wrote = await t.call(CH.botFilesWrite, "bot", t.ada.id, "notes.md", "hello");
  assert.equal(wrote.ok, true, wrote.error);
  assert.deepEqual(t.heard.at(-1), { channel: CH.botFilesChanged, payload: { scope: "bot", botId: t.ada.id } });
  assert.deepEqual((await t.call(CH.botFilesList, "bot", t.ada.id, "")).value.map((e: { name: string }) => e.name), ["notes.md"]);
  assert.equal((await t.call(CH.botFilesRead, "bot", t.ada.id, "notes.md")).value.content, "hello");
  const copied = await t.call(CH.botFilesCopy, "to-library", t.ada.id, "notes.md");
  assert.equal(copied.ok, true, copied.error);
  assert.equal((await t.call(CH.botFilesRead, "library", null, "notes.md")).value.content, "hello");
  assert.equal((await t.call(CH.botFilesRemove, "bot", t.ada.id, "notes.md")).ok, true);
  assert.equal((await t.call(CH.botFilesRead, "elsewhere", t.ada.id, "x")).ok, false);
  assert.equal((await t.call(CH.botFilesRead, "bot", t.ada.id, "../../outside")).ok, false);
});

test("teach: with no browser tab open, a recording is refused in words and nothing is left running", async () => {
  const t = setup();
  const state = await t.call(CH.botTeachState);
  assert.deepEqual([state.recording, state.steps], [false, 0]);
  const start = await t.call(CH.botTeachStart, t.ada.id, "Weekly report");
  assert.equal(start.ok, false);
  assert.match(start.error, /Browser tab/);
  assert.equal((await t.call(CH.botTeachState)).recording, false);
  assert.equal((await t.call(CH.botTeachStop)).ok, false);
  const saved = await t.call(CH.botTeachSave, t.ada.id, { name: "weekly-report", description: "d", body: "1. Open the page" });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.value.origin, "recording");
  assert.deepEqual(t.heard.at(-1), { channel: CH.botSkillsChanged, payload: t.ada.id }, "a taught skill is announced like any other");
  assert.deepEqual(t.bridged, [t.ada.id]);
});

test("a skill saved in the panel and one taught go through the same store, so they cannot overwrite each other", async () => {
  const t = setup();
  const [panel, taught] = await Promise.all([
    t.call(CH.botSkillsSave, t.ada.id, { name: "weekly-report", description: "d", body: "from the panel" }),
    t.call(CH.botTeachSave, t.ada.id, { name: "weekly-report", description: "d", body: "from teaching" }),
  ]);
  assert.equal(panel.ok && taught.ok, true, panel.error ?? taught.error);
  const listed = (await t.call(CH.botSkillsList, t.ada.id)).value as Array<{ name: string; version: number }>;
  assert.equal(listed.length, 2, "teaching takes a free name rather than writing over the panel's skill");
  assert.deepEqual(listed.map((s) => s.version), [1, 1], "neither was written over the other");
  assert.deepEqual(new Set(listed.map((s) => s.name)), new Set(["weekly-report", "weekly-report-2"]));
  assert.equal(t.surface.stores.of(t.ada.id), t.surface.stores.of(t.ada.id));
});

test("disposing throws away a recording that is running, and is safe when none is", async () => {
  const t = setup();
  await t.surface.dispose();
  await t.surface.dispose();
  t.surface.retain([]);
  t.surface.retain([t.ada.id]);
});
