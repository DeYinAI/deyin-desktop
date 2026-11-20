import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BotMemory, BotStore, FileStorage } from "@deyin/host-core";
import { createBotsHandlers, type BotsHandlerDeps } from "../src/main/bots/handlers.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  // Writes are queued asynchronously; let them land first or they recreate the directory after it is removed.
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup(extra: Partial<BotsHandlerDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deyin-botsipc-"));
  dirs.push(dir);
  const storage = new FileStorage(dir);
  storages.push(storage);
  const store = new BotStore(storage);
  const removed: string[] = [];
  const routinesRemoved: string[] = [];
  const hooks = { failRoutines: false, failGrants: false };
  const grantsRemoved: string[] = [];
  const handlers = createBotsHandlers({
    store,
    botsDir: join(dir, "bots"),
    removeSessions: (botId) => {
      removed.push(botId);
      return 2;
    },
    removeRoutines: (botId) => {
      if (hooks.failRoutines) throw new Error("routine cleanup failed");
      routinesRemoved.push(botId);
      return 1;
    },
    removeVaultGrants: (botId) => {
      if (hooks.failGrants) throw new Error("vault cleanup failed");
      grantsRemoved.push(botId);
    },
    ...extra,
  });
  return { dir, store, handlers, removed, routinesRemoved, grantsRemoved, hooks };
}

function ok<T>(result: { ok: boolean; value?: T; error?: string }): T {
  assert.equal(result.ok, true, result.error);
  return result.value as T;
}

test("create returns the new Bot and list returns the roster", () => {
  const { handlers } = setup();
  const bot = ok(handlers.create({ name: "Ava", purpose: "Help" }));
  assert.equal(bot.name, "Ava");
  assert.equal(bot.isPrimary, true);
  assert.deepEqual(handlers.list().bots.map((b) => b.id), [bot.id]);
});

test("a refusal comes back as a failed result with a readable reason, never a thrown error", () => {
  const { handlers } = setup();
  const failed = handlers.create({ name: "" });
  assert.deepEqual({ ok: failed.ok, code: failed.ok ? null : failed.code }, { ok: false, code: "invalid" });
  assert.match(failed.ok ? "" : failed.error, /needs a name/);
  const missing = handlers.archive("bot_ghost");
  assert.equal(missing.ok, false);
  assert.equal(missing.ok ? "" : missing.code, "not_found");
});

test("arguments of the wrong type are refused instead of crashing the handler", () => {
  const { handlers } = setup();
  const junk = [undefined, null, 7, true, [], {}, () => 1];
  for (const value of junk) {
    assert.doesNotThrow(() => handlers.create(value), `create(${String(value)})`);
    assert.equal(handlers.create(value).ok, false);
    assert.doesNotThrow(() => handlers.update(value, value));
    assert.doesNotThrow(() => handlers.archive(value));
    assert.doesNotThrow(() => handlers.restore(value));
    assert.doesNotThrow(() => handlers.delete(value));
    assert.doesNotThrow(() => handlers.setPrimary(value));
    assert.doesNotThrow(() => handlers.setPinned(value, value));
    assert.doesNotThrow(() => handlers.setHidden(value, value));
    assert.doesNotThrow(() => handlers.addSection(value));
    assert.doesNotThrow(() => handlers.renameSection(value, value));
    assert.doesNotThrow(() => handlers.removeSection(value));
    assert.doesNotThrow(() => handlers.moveToSection(value, value));
    assert.doesNotThrow(() => handlers.memoryList(value));
    assert.doesNotThrow(() => handlers.memoryForget(value, value));
    assert.doesNotThrow(() => handlers.memoryShare(value, value, value));
  }
  assert.equal(handlers.list().bots.length, 0, "none of that created anything");
});

test("update, archive, restore and setPrimary operate on the store", () => {
  const { handlers } = setup();
  const a = ok(handlers.create({ name: "A" }));
  const b = ok(handlers.create({ name: "B" }));
  assert.equal(ok(handlers.update(a.id, { title: "Lead" })).title, "Lead");
  assert.equal(ok(handlers.setPrimary(b.id)).isPrimary, true);
  assert.equal(ok(handlers.archive(a.id)).archived, true);
  assert.equal(ok(handlers.restore(a.id)).archived, false);
});

test("delete removes the Bot and then its conversations", () => {
  const { handlers, removed, store } = setup();
  const a = ok(handlers.create({ name: "A" }));
  assert.equal(ok(handlers.delete(a.id)), null);
  assert.equal(store.get(a.id), undefined);
  assert.deepEqual(removed, [a.id]);
});

test("deleting a Bot that does not exist touches no conversations or routines", () => {
  const { handlers, removed, routinesRemoved, grantsRemoved } = setup();
  const result = handlers.delete("bot_ghost");
  assert.equal(result.ok, false);
  assert.deepEqual(removed, []);
  assert.deepEqual(routinesRemoved, []);
  assert.deepEqual(grantsRemoved, []);
});

test("deleting a Bot takes back what it was allowed to use in the Vault", () => {
  const { handlers, grantsRemoved } = setup();
  const a = ok(handlers.create({ name: "A" }));
  ok(handlers.delete(a.id));
  assert.deepEqual(grantsRemoved, [a.id]);
});

test("a failure taking back Vault permissions does not strand the Bot's conversations", () => {
  const { handlers, removed, routinesRemoved, hooks, store } = setup();
  const a = ok(handlers.create({ name: "A" }));
  hooks.failGrants = true;
  assert.throws(() => handlers.delete(a.id), /vault cleanup failed/);
  assert.equal(store.get(a.id), undefined);
  assert.deepEqual(routinesRemoved, [a.id], "the routines were already gone");
  assert.deepEqual(removed, [a.id]);
});

test("a failure removing routines still takes back the Vault permissions", () => {
  const { handlers, grantsRemoved, hooks } = setup();
  const a = ok(handlers.create({ name: "A" }));
  hooks.failRoutines = true;
  assert.throws(() => handlers.delete(a.id), /routine cleanup failed/);
  assert.deepEqual(grantsRemoved, [a.id]);
});

test("deleting a Bot closes its ways in from outside, and a failure there still removes its conversations", () => {
  const closed: string[] = [];
  const { handlers } = setup({ removeSurfaces: (botId) => void closed.push(botId) });
  const a = ok(handlers.create({ name: "A" }));
  ok(handlers.delete(a.id));
  assert.deepEqual(closed, [a.id]);
  const failing = setup({
    removeSurfaces: () => {
      throw new Error("surface cleanup failed");
    },
  });
  const c = ok(failing.handlers.create({ name: "C" }));
  assert.throws(() => failing.handlers.delete(c.id), /surface cleanup failed/);
  assert.deepEqual(failing.removed, [c.id], "the conversations still went");
  assert.equal(handlers.delete("bot_ghost").ok, false);
  assert.deepEqual(closed, [a.id], "a Bot that is not there closes nothing");
});

test("deleting a Bot takes its routines with it", () => {
  const { handlers, routinesRemoved } = setup();
  const a = ok(handlers.create({ name: "A" }));
  ok(handlers.delete(a.id));
  assert.deepEqual(routinesRemoved, [a.id]);
});

test("a failure removing routines does not strand the Bot's conversations", () => {
  const { handlers, removed, hooks, store } = setup();
  const a = ok(handlers.create({ name: "A" }));
  hooks.failRoutines = true;
  assert.throws(() => handlers.delete(a.id), /routine cleanup failed/);
  assert.equal(store.get(a.id), undefined, "the Bot is still gone");
  assert.deepEqual(removed, [a.id]);
});

test("roster layout operations round-trip through the handlers", () => {
  const { handlers } = setup();
  const a = ok(handlers.create({ name: "A" }));
  assert.deepEqual(ok(handlers.setPinned(a.id, true)).pinned, [a.id]);
  assert.deepEqual(ok(handlers.setHidden(a.id, true)).hidden, [a.id]);
  const withSection = ok(handlers.addSection("Work"));
  const sectionId = withSection.sections[0]!.id;
  assert.deepEqual(ok(handlers.moveToSection(a.id, sectionId)).sections[0]!.botIds, [a.id]);
  assert.equal(ok(handlers.renameSection(sectionId, "Focus")).sections[0]!.name, "Focus");
  assert.deepEqual(ok(handlers.moveToSection(a.id, null)).sections[0]!.botIds, []);
  assert.deepEqual(ok(handlers.removeSection(sectionId)).sections, []);
  assert.equal(handlers.addSection("").ok, false);
});

test("setPinned treats anything but true as false, so a truthy string cannot pin", () => {
  const { handlers } = setup();
  const a = ok(handlers.create({ name: "A" }));
  ok(handlers.setPinned(a.id, true));
  assert.deepEqual(ok(handlers.setPinned(a.id, "yes")).pinned, []);
});

test("memory handlers show a Bot only its own and shared facts, without file paths", () => {
  const { handlers, dir } = setup();
  const a = ok(handlers.create({ name: "A" }));
  const b = ok(handlers.create({ name: "B" }));
  // Facts are saved by the agent's remember tool; stand in for it with BotMemory directly.
  const botsDir = join(dir, "bots");
  new BotMemory(botsDir, a.id).create({ name: "mine", title: "Mine", type: "user", body: "private to A" });
  new BotMemory(botsDir, a.id).create({ name: "ours", title: "Ours", type: "user", body: "for all", scope: "global" });

  const aFacts = ok(handlers.memoryList(a.id));
  assert.deepEqual(aFacts.map((f) => [f.name, f.shared]).sort(), [["mine", false], ["ours", true]]);
  assert.equal(JSON.stringify(aFacts).includes(dir), false, "no on-disk paths reach the renderer");
  assert.deepEqual(ok(handlers.memoryList(b.id)).map((f) => f.name), ["ours"]);
});

test("memoryShare shares and unshares a fact, memoryForget removes it", () => {
  const { handlers, dir } = setup();
  const a = ok(handlers.create({ name: "A" }));
  const b = ok(handlers.create({ name: "B" }));
  new BotMemory(join(dir, "bots"), a.id).create({ name: "tz", title: "Timezone", type: "user", body: "Berlin" });

  assert.equal(ok(handlers.memoryShare(a.id, "tz", true)).shared, true);
  assert.deepEqual(ok(handlers.memoryList(b.id)).map((f) => f.name), ["tz"]);
  assert.equal(ok(handlers.memoryShare(a.id, "tz", false)).shared, false);
  assert.deepEqual(ok(handlers.memoryList(b.id)), []);
  assert.equal(ok(handlers.memoryForget(a.id, "tz")), null);
  assert.deepEqual(ok(handlers.memoryList(a.id)), []);
  const missing = handlers.memoryForget(a.id, "tz");
  assert.equal(missing.ok, false);
});

test("memory for a Bot that does not exist is refused and creates no directory", () => {
  const { handlers, dir } = setup();
  const result = handlers.memoryList("bot_ghost");
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.code, "not_found");
  assert.equal(existsSync(join(dir, "bots", "bot_ghost")), false);
  for (const hostile of ["../escape", "..", "a/b"]) {
    assert.equal(handlers.memoryList(hostile).ok, false, hostile);
  }
});

test("deleting a Bot that lived on a server tells the server's copy to go, once the Bot is gone here", () => {
  const forgotten: Array<{ id: string; harness: string; hostId: string | undefined; storedHereWhenAsked: boolean }> = [];
  const holder: { store?: BotStore } = {};
  const t = setup({
    removeFromServer: (bot) => {
      forgotten.push({ id: bot.id, harness: bot.harness, hostId: bot.hostId, storedHereWhenAsked: holder.store?.get(bot.id) !== undefined });
    },
  });
  holder.store = t.store;
  const bot = ok(t.handlers.create({ name: "Ada", harness: "server", hostId: "host_1" }));
  ok(t.handlers.delete(bot.id));
  assert.deepEqual(forgotten, [{ id: bot.id, harness: "server", hostId: "host_1", storedHereWhenAsked: false }]);
});

test("a Bot on this computer is passed to the same hook, which decides it has nothing to do", () => {
  const seen: string[] = [];
  const t = setup({ removeFromServer: (bot) => void seen.push(bot.harness) });
  const bot = ok(t.handlers.create({ name: "Ada" }));
  ok(t.handlers.delete(bot.id));
  assert.deepEqual(seen, ["local"]);
});

test("a server that cannot be told does not stop the Bot's conversations being removed", () => {
  const t = setup({
    removeFromServer: () => {
      throw new Error("server cleanup failed");
    },
  });
  const bot = ok(t.handlers.create({ name: "Ada", harness: "server", hostId: "host_1" }));
  assert.throws(() => t.handlers.delete(bot.id), /server cleanup failed/);
  assert.deepEqual(t.removed, [bot.id]);
  assert.deepEqual(t.routinesRemoved, [bot.id]);
  assert.deepEqual(t.grantsRemoved, [bot.id]);
});

test("a delete of a Bot that is not there does not reach the server", () => {
  const seen: string[] = [];
  const t = setup({ removeFromServer: (bot) => void seen.push(bot.id) });
  assert.equal(t.handlers.delete("bot_ghost").ok, false);
  assert.deepEqual(seen, []);
});
