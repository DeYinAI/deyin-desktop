import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BotMemory, SHARED_BOT_MEMORY_DIR } from "../src/bots/memory.js";
import { BotError } from "../src/bots/types.js";
import { MemoryStore } from "../src/memory.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A storage dir with the layout the app uses: `<dir>/bots/<id>/` per Bot, `<dir>/memory/` for Code. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "deyin-botmem-"));
  dirs.push(dir);
  const botsDir = join(dir, "bots");
  return { dir, botsDir, ava: new BotMemory(botsDir, "bot_ava"), bo: new BotMemory(botsDir, "bot_bo") };
}

const fact = (name: string, body = `${name} body`, scope?: "project" | "global") => ({
  name,
  title: name,
  type: "user" as const,
  body,
  ...(scope ? { scope } : {}),
});

test("a Bot's own facts are private to it", () => {
  const { ava, bo } = setup();
  ava.create(fact("likes-tea", "Ava likes tea"));
  assert.equal(ava.read("likes-tea")?.body, "Ava likes tea");
  assert.equal(bo.read("likes-tea"), undefined);
  assert.deepEqual(bo.list(), []);
  assert.deepEqual(bo.search("tea"), []);
});

test("a fact with global scope is shared with every Bot", () => {
  const { ava, bo } = setup();
  ava.create(fact("timezone", "The user is in Europe/Berlin", "global"));
  assert.equal(bo.read("timezone")?.body, "The user is in Europe/Berlin");
  assert.equal(bo.read("timezone")?.scope, "global");
  assert.equal(bo.search("berlin")[0]?.fact.name, "timezone");
});

test("scope is project by default and reported as such for a Bot's own fact", () => {
  const { ava } = setup();
  assert.equal(ava.create(fact("a")).scope, "project");
  assert.equal(ava.create(fact("b", "b", "global")).scope, "global");
});

test("Bot memory never mixes with Deyin Code's workspace memory", () => {
  const { dir, ava } = setup();
  const code = new MemoryStore(dir);
  code.create({ name: "repo-rule", title: "Repo rule", type: "project", body: "Never force push" });
  ava.create(fact("bot-only"));
  assert.equal(ava.read("repo-rule"), undefined, "a Bot cannot read workspace memory");
  assert.equal(code.read("bot-only"), undefined, "Code cannot read a Bot's memory");
  assert.equal(code.list().length, 1);
});

test("facts are stored under the Bot's own directory and the shared one", () => {
  const { botsDir, ava } = setup();
  ava.create(fact("mine"));
  ava.create(fact("ours", "x", "global"));
  assert.ok(existsSync(join(botsDir, "bot_ava", "memory", "mine.md")));
  assert.ok(existsSync(join(botsDir, SHARED_BOT_MEMORY_DIR, "memory", "ours.md")));
});

test("a name means one fact: it cannot be reused across own and shared memory", () => {
  const { ava, bo } = setup();
  ava.create(fact("dup", "mine"));
  assert.throws(() => ava.create(fact("dup", "again", "global")), (e: unknown) => e instanceof BotError && e.code === "conflict");
  bo.create(fact("shared-one", "s", "global"));
  assert.throws(() => ava.create(fact("shared-one", "mine")), (e: unknown) => e instanceof BotError && e.code === "conflict");
  assert.throws(() => ava.create(fact("dup", "again")), /already exists|conflict/i);
});

test("two Bots may each keep a private fact with the same name", () => {
  const { ava, bo } = setup();
  ava.create(fact("favorite", "tea"));
  bo.create(fact("favorite", "coffee"));
  assert.equal(ava.read("favorite")?.body, "tea");
  assert.equal(bo.read("favorite")?.body, "coffee");
});

test("a hand-edited fact file cannot claim a scope other than where it lives", () => {
  const { botsDir, ava } = setup();
  ava.create(fact("sneaky"));
  const path = join(botsDir, "bot_ava", "memory", "sneaky.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("scope: project", "scope: global"));
  assert.equal(ava.read("sneaky")?.scope, "project");
  assert.equal(new BotMemory(botsDir, "bot_bo").read("sneaky"), undefined, "it is still private");
  assert.equal(ava.list().find((f) => f.name === "sneaky")?.scope, "project");
});

test("update edits in place, bumps the revision and rejects a stale one", () => {
  const { ava } = setup();
  const created = ava.create(fact("note", "v1"));
  const next = ava.update("note", { body: "v2" }, created.revision);
  assert.equal(next.revision, 2);
  assert.equal(next.body, "v2");
  assert.equal(next.scope, "project");
  assert.throws(() => ava.update("note", { body: "v3" }, created.revision), /changed/);
  assert.throws(() => ava.update("ghost", { body: "x" }), (e: unknown) => e instanceof BotError && e.code === "not_found");
});

test("setting scope to global shares a private fact with the other Bots", () => {
  const { ava, bo, botsDir } = setup();
  const created = ava.create(fact("name", "The user is Sam"));
  const shared = ava.update("name", { scope: "global" }, created.revision);
  assert.equal(shared.scope, "global");
  assert.equal(shared.body, "The user is Sam");
  assert.equal(bo.read("name")?.body, "The user is Sam");
  assert.equal(existsSync(join(botsDir, "bot_ava", "memory", "name.md")), false, "it left the private store");
  assert.equal(ava.archived().length, 1, "the original is archived, never destroyed");
});

test("setting scope back to project makes a shared fact private to the Bot that did it", () => {
  const { ava, bo } = setup();
  ava.create(fact("shared", "x", "global"));
  const priv = ava.update("shared", { scope: "project" });
  assert.equal(priv.scope, "project");
  assert.equal(bo.read("shared"), undefined);
  assert.equal(ava.read("shared")?.scope, "project");
});

test("moving a fact applies the edit made with it and honors expectedRevision", () => {
  const { ava } = setup();
  const created = ava.create(fact("n", "old"));
  assert.throws(() => ava.update("n", { scope: "global", body: "new" }, created.revision + 5), /changed/);
  assert.equal(ava.read("n")?.scope, "project", "a refused move changes nothing");
  const moved = ava.update("n", { scope: "global", body: "new", title: "Renamed" }, created.revision);
  assert.equal(moved.body, "new");
  assert.equal(moved.title, "Renamed");
});

test("forget archives the fact from whichever store holds it, and recover brings it back there", () => {
  const { ava, bo } = setup();
  ava.create(fact("mine"));
  ava.create(fact("ours", "x", "global"));
  ava.forget("mine");
  ava.forget("ours");
  assert.equal(ava.read("mine"), undefined);
  assert.equal(bo.read("ours"), undefined, "forgetting a shared fact forgets it for everyone");
  assert.deepEqual(ava.archived().map((f) => f.name).sort(), ["mine", "ours"]);
  assert.equal(ava.recover("mine").scope, "project");
  assert.equal(ava.recover("ours").scope, "global");
  assert.equal(bo.read("ours")?.body, "x");
  assert.throws(() => ava.forget("ghost"), (e: unknown) => e instanceof BotError && e.code === "not_found");
  assert.throws(() => ava.recover("ghost"), (e: unknown) => e instanceof BotError && e.code === "not_found");
});

test("search ranks across the Bot's own and shared facts together", () => {
  const { ava } = setup();
  ava.create({ name: "deploy-private", title: "Deploy steps", type: "project", body: "Run the deploy script then tag the release" });
  ava.create({ name: "deploy-shared", title: "Staging server", type: "reference", body: "The staging server is staging.example.com", scope: "global" });
  ava.create(fact("unrelated", "Likes jazz"));
  const names = ava.search("deploy release staging").map((hit) => hit.fact.name);
  assert.ok(names.includes("deploy-private") && names.includes("deploy-shared"));
  assert.ok(!names.includes("unrelated"));
  assert.equal(ava.search("deploy", 1).length, 1, "the limit applies to the merged result");
  assert.deepEqual(ava.search("   "), []);
});

test("list is newest first and count covers what the Bot can see", () => {
  const { ava, bo } = setup();
  ava.create(fact("a"));
  bo.create(fact("only-bo"));
  ava.create(fact("shared", "s", "global"));
  assert.equal(ava.count(), 2);
  assert.equal(bo.count(), 2);
  const stamps = ava.list().map((f) => f.updatedAt);
  assert.deepEqual([...stamps].sort().reverse(), stamps);
});

test("a Bot id that could leave the Bots directory is refused", () => {
  const { botsDir } = setup();
  for (const id of ["../escape", "a/b", "..", "", SHARED_BOT_MEMORY_DIR, "/abs"]) {
    assert.throws(() => new BotMemory(botsDir, id), (e: unknown) => e instanceof BotError && e.code === "invalid", id);
  }
});

test("problems reported by the underlying store arrive as BotErrors with their original message", () => {
  const { ava } = setup();
  const created = ava.create(fact("note", "v1"));
  ava.update("note", { body: "v2" }, created.revision);
  assert.throws(() => ava.update("note", { body: "v3" }, created.revision), (e: unknown) => e instanceof BotError && e.code === "conflict" && /changed/.test(e.message));
  ava.forget("note");
  ava.create(fact("note", "new life"));
  assert.throws(() => ava.recover("note"), (e: unknown) => e instanceof BotError && e.code === "conflict" && /already exists/.test(e.message));
});
