import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BotStore, FileStorage, SKILL_LIMITS } from "@deyin/host-core";
import { BotSkillStores, createBotSkillsHandlers } from "../src/main/bots/skills-handlers.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "deyin-skillhandlers-"));
  dirs.push(dir);
  const storage = new FileStorage(dir);
  storages.push(storage);
  const store = new BotStore(storage);
  const stores = new BotSkillStores(store);
  const changed: string[] = [];
  const handlers = createBotSkillsHandlers({ stores, changed: (botId) => changed.push(botId) });
  const ada = store.create({ name: "Ada" });
  return { dir, store, stores, handlers, changed, ada };
}

const skill = (over: Record<string, unknown> = {}) => ({ name: "weekly-report", description: "Write the weekly report", body: "1. Open the sheet", ...over });

function ok<T>(result: { ok: true; value: T } | { ok: false; error: string; code: string }): T {
  assert.ok(result.ok, result.ok ? "" : `${result.code}: ${result.error}`);
  return (result as { ok: true; value: T }).value;
}

test("a person can add, read, change and remove a skill, and each change is announced for the Bot it was made to", async () => {
  const t = setup();
  const saved = ok(await t.handlers.save(t.ada.id, skill()));
  assert.equal(saved.version, 1);
  assert.equal(saved.origin, "person");
  assert.deepEqual(ok(await t.handlers.list(t.ada.id)).map((s) => s.name), ["weekly-report"]);
  assert.equal(ok(await t.handlers.get(t.ada.id, "weekly-report")).body, "1. Open the sheet");
  const changed = ok(await t.handlers.save(t.ada.id, skill({ body: "1. Open the sheet\n2. Check it" }), 1));
  assert.equal(changed.version, 2);
  ok(await t.handlers.remove(t.ada.id, "weekly-report"));
  assert.deepEqual(ok(await t.handlers.list(t.ada.id)), []);
  assert.deepEqual(t.changed, [t.ada.id, t.ada.id, t.ada.id]);
});

test("a skill changed since it was opened is refused, with words, and nothing is announced", async () => {
  const t = setup();
  ok(await t.handlers.save(t.ada.id, skill()));
  ok(await t.handlers.save(t.ada.id, skill({ body: "changed elsewhere" })));
  t.changed.length = 0;
  const refused = await t.handlers.save(t.ada.id, skill({ body: "my edit" }), 1);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "conflict");
    assert.match(refused.error, /was changed since you opened it/);
  }
  assert.equal(ok(await t.handlers.get(t.ada.id, "weekly-report")).body, "changed elsewhere");
  assert.deepEqual(t.changed, []);
});

test("an expected version that is not a whole number is ignored rather than trusted", async () => {
  const t = setup();
  ok(await t.handlers.save(t.ada.id, skill()));
  ok(await t.handlers.save(t.ada.id, skill({ body: "two" }), "1"));
  ok(await t.handlers.save(t.ada.id, skill({ body: "three" }), 1.5));
  assert.equal(ok(await t.handlers.get(t.ada.id, "weekly-report")).body, "three");
});

test("what the person undoes can be seen and put back, and that is announced", async () => {
  const t = setup();
  ok(await t.handlers.save(t.ada.id, skill({ body: "first" })));
  ok(await t.handlers.save(t.ada.id, skill({ body: "second" })));
  const revisions = ok(await t.handlers.revisions(t.ada.id, "weekly-report"));
  assert.deepEqual(revisions.map((r) => [r.id, r.content, r.author]), [["r2", "second", "person"], ["r1", "first", "person"]]);
  t.changed.length = 0;
  const back = ok(await t.handlers.revert(t.ada.id, "weekly-report", "r1"));
  assert.equal(back.body, "first");
  assert.equal(back.version, 3);
  assert.deepEqual(t.changed, [t.ada.id]);
  const again = await t.handlers.revert(t.ada.id, "weekly-report", "r3");
  assert.equal(again.ok, false, "that is what it says now");
});

test("every argument is checked, because it came from a page", async () => {
  const t = setup();
  for (const bad of [undefined, null, 5, {}, ["x"]]) {
    for (const call of [
      () => t.handlers.list(bad),
      () => t.handlers.get(bad, "x"),
      () => t.handlers.save(bad, skill()),
      () => t.handlers.remove(bad, "x"),
      () => t.handlers.revisions(bad, "x"),
      () => t.handlers.revert(bad, "x", "r1"),
      () => t.handlers.get(t.ada.id, bad),
      () => t.handlers.remove(t.ada.id, bad),
      () => t.handlers.revisions(t.ada.id, bad),
      () => t.handlers.revert(t.ada.id, bad, "r1"),
      () => t.handlers.revert(t.ada.id, "weekly-report", bad),
    ]) {
      const result = await call();
      assert.equal(result.ok, false, String(bad));
      if (!result.ok) assert.equal(result.code, "invalid");
    }
  }
  for (const bad of [undefined, null, 5, "", "Bad Name", "../escape", { name: "x" }, [], "nope"]) {
    const result = await t.handlers.save(t.ada.id, bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(ok(await t.handlers.list(t.ada.id)), [], "nothing was made by a refusal");
});

test("a path in a skill name cannot leave the Bot's skills folder", async () => {
  const t = setup();
  for (const name of ["../../../etc/passwd", "a/b", "..", ".", "a\\b", "a b"]) {
    for (const call of [() => t.handlers.get(t.ada.id, name), () => t.handlers.remove(t.ada.id, name), () => t.handlers.revisions(t.ada.id, name), () => t.handlers.revert(t.ada.id, name, "r1"), () => t.handlers.save(t.ada.id, skill({ name }))]) {
      const result = await call();
      assert.equal(result.ok, false, name);
      if (!result.ok) assert.equal(result.code, "invalid", name);
    }
  }
});

test("a Bot that is gone, or a room, has no skills to keep; a missing skill is not found", async () => {
  const t = setup();
  const gone = await t.handlers.list("bot_nope");
  assert.deepEqual(gone, { ok: false, error: "That Bot no longer exists.", code: "not_found" });
  const bo = t.store.create({ name: "Bo" });
  const room = t.store.create({ name: "Room", kind: "room", memberBotIds: [t.ada.id, bo.id] });
  const refused = await t.handlers.save(room.id, skill());
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /is a room/);
  const missing = await t.handlers.get(t.ada.id, "nothing-here");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "not_found");
});

test("each Bot has its own skills, and the limit is enforced per Bot", async () => {
  const t = setup();
  const bo = t.store.create({ name: "Bo" });
  ok(await t.handlers.save(t.ada.id, skill({ name: "only-ada" })));
  assert.deepEqual(ok(await t.handlers.list(bo.id)), []);
  for (let n = 0; n < SKILL_LIMITS.perBot; n += 1) ok(await t.handlers.save(bo.id, skill({ name: `skill-${n}` })));
  const over = await t.handlers.save(bo.id, skill({ name: "one-too-many" }));
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.code, "limit");
  ok(await t.handlers.save(t.ada.id, skill({ name: "ada-still-can" })));
});

test("two saves at once to one skill cannot both win: the second is told, and neither is lost silently", async () => {
  const t = setup();
  ok(await t.handlers.save(t.ada.id, skill()));
  const [a, b] = await Promise.all([t.handlers.save(t.ada.id, skill({ body: "from window A" }), 1), t.handlers.save(t.ada.id, skill({ body: "from window B" }), 1)]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  const loser = a.ok ? b : a;
  if (!loser.ok) assert.equal(loser.code, "conflict");
});

test("the same store is used for a Bot every time, and let go of when the Bot is gone", () => {
  const t = setup();
  assert.equal(t.stores.of(t.ada.id), t.stores.of(t.ada.id));
  const first = t.stores.of(t.ada.id);
  t.stores.forget(t.ada.id);
  assert.notEqual(t.stores.of(t.ada.id), first);
  assert.equal(t.stores.of(t.ada.id).root, join(t.dir, "bots", t.ada.id, "skills"));
});

test("after the roster changes only the Bots still in it keep a store", () => {
  const t = setup();
  const grace = t.store.create({ name: "Grace" });
  const adas = t.stores.of(t.ada.id);
  const graces = t.stores.of(grace.id);
  t.stores.retain([grace.id]);
  assert.equal(t.stores.of(grace.id), graces, "a Bot still in the roster keeps its store");
  assert.notEqual(t.stores.of(t.ada.id), adas, "one that was dropped starts afresh if it is asked for again");
  t.stores.retain([]);
  assert.notEqual(t.stores.of(grace.id), graces);
});

test("a failure telling others about a change does not undo or hide the change", async () => {
  const t = setup();
  const handlers = createBotSkillsHandlers({
    stores: t.stores,
    changed: () => {
      throw new Error("the bridge is down");
    },
  });
  const saved = await handlers.save(t.ada.id, skill());
  assert.equal(saved.ok, true);
  assert.deepEqual(ok(await t.handlers.list(t.ada.id)).map((s) => s.name), ["weekly-report"]);
});
