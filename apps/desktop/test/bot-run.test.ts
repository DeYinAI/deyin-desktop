import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BOT_PERSONA_TAG, BotStore, FileStorage } from "@deyin/host-core";
import { requireBotRun, resolveBotRun, resolveRoutineBot, runScope, withBotPersona, withoutWorkspaceCaps } from "../src/main/bots/run.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  // Writes are queued asynchronously; let them land first or they recreate the directory after it is removed.
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "deyin-botrun-"));
  dirs.push(dir);
  const storage = new FileStorage(dir);
  storages.push(storage);
  const store = new BotStore(storage);
  const source = { store, botsDir: join(dir, "bots") };
  return { dir, store, source };
}

test("an active Bot resolves to its own files folder, persona and memory", () => {
  const { dir, store, source } = setup();
  const bot = store.create({ name: "Ada", title: "Research assistant", purpose: "Find sources." });
  const result = resolveBotRun(source, bot.id);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.bot.id, bot.id);
  assert.equal(result.value.cwd, join(dir, "bots", bot.id, "files"));
  assert.ok(statSync(result.value.cwd).isDirectory(), "the folder exists so the agent can start in it");
  assert.match(result.value.persona, new RegExp(`^<${BOT_PERSONA_TAG}>\\nYou are Ada \\(@ada\\)`));
  assert.match(result.value.persona, /Find sources\./);
});

test("the working folder is separate from the memory store, so file tools never sit on it", () => {
  const { dir, store, source } = setup();
  const bot = store.create({ name: "Ada" });
  const result = resolveBotRun(source, bot.id);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  result.value.memory.create({ name: "likes-tea", title: "Likes tea", description: "d", type: "user", scope: "project", body: "b" });
  const botDir = join(dir, "bots", bot.id);
  assert.deepEqual(readdirSync(botDir).sort(), ["files", "memory"]);
  assert.deepEqual(readdirSync(result.value.cwd), [], "memory writes did not land in the working folder");
});

test("memory resolved for a Bot keeps private facts private and shares only global ones", () => {
  const { store, source } = setup();
  const ada = resolveBotRun(source, store.create({ name: "Ada" }).id);
  const bo = resolveBotRun(source, store.create({ name: "Bo" }).id);
  assert.ok(ada.ok && bo.ok);
  if (!ada.ok || !bo.ok) return;
  ada.value.memory.create({ name: "secret", title: "Secret", description: "d", type: "project", scope: "project", body: "private" });
  ada.value.memory.create({ name: "timezone", title: "Timezone", description: "d", type: "user", scope: "global", body: "UTC+1" });
  assert.deepEqual(bo.value.memory.list().map((f) => f.name), ["timezone"]);
  assert.deepEqual(ada.value.memory.list().map((f) => f.name).sort(), ["secret", "timezone"]);
});

test("an unknown Bot is refused, and an unsafe id never reaches the filesystem", () => {
  const { dir, source } = setup();
  for (const id of ["nope", "../escape", "_shared", ""]) {
    const result = resolveBotRun(source, id);
    assert.equal(result.ok, false, id);
    if (!result.ok) assert.equal(result.code, "not_found", id);
  }
  assert.equal(existsSync(join(dir, "bots")), false, "nothing was created for a refused run");
  assert.equal(existsSync(join(dir, "escape")), false);
});

test("an archived Bot is refused by name until it is restored", () => {
  const { store, source } = setup();
  const bot = store.create({ name: "Ada" });
  store.archive(bot.id);
  const refused = resolveBotRun(source, bot.id);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "conflict");
    assert.match(refused.error, /^Ada is archived\. Restore it/);
  }
  store.restore(bot.id);
  assert.equal(resolveBotRun(source, bot.id).ok, true);
});

test("a room resolves to a host that is told who is in it, and to the members that can answer", () => {
  const { dir, store, source } = setup();
  const a = store.create({ name: "Ada", title: "Researcher" });
  const b = store.create({ name: "Bo", title: "Writer" });
  const room = store.create({ name: "Standup", kind: "room", memberBotIds: [a.id, b.id] });
  const result = resolveBotRun(source, room.id);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.bot.id, room.id);
  assert.deepEqual(result.value.members.map((m) => m.id), [a.id, b.id]);
  assert.match(result.value.persona, /^<bot_room>\nYou host the room "Standup"/);
  assert.match(result.value.persona, /- @ada: Ada, Researcher/);
  assert.match(result.value.persona, /- @bo: Bo, Writer/);
  assert.doesNotMatch(result.value.persona, /bot_identity/, "a room is not given a Bot's identity");
  assert.equal(result.value.cwd, join(dir, "bots", room.id, "files"), "a room has its own folder, not a member's");
});

test("a Bot that is not a room has no members", () => {
  const { store, source } = setup();
  const result = resolveBotRun(source, store.create({ name: "Ada" }).id);
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.value.members, []);
});

test("a room's memory is its own: it sees none of its members' private facts", () => {
  const { store, source } = setup();
  const a = store.create({ name: "Ada" });
  const b = store.create({ name: "Bo" });
  const room = store.create({ name: "Standup", kind: "room", memberBotIds: [a.id, b.id] });
  const ada = resolveBotRun(source, a.id);
  const standup = resolveBotRun(source, room.id);
  assert.ok(ada.ok && standup.ok);
  if (!ada.ok || !standup.ok) return;
  ada.value.memory.create({ name: "secret", title: "Secret", description: "d", type: "project", scope: "project", body: "private" });
  assert.deepEqual(standup.value.memory.list(), []);
});

test("a member that is archived is left out of the room, and the room follows when too few remain", () => {
  const { store, source } = setup();
  const a = store.create({ name: "Ada" });
  const b = store.create({ name: "Bo" });
  const c = store.create({ name: "Cy" });
  const room = store.create({ name: "Standup", kind: "room", memberBotIds: [a.id, b.id, c.id] });
  store.archive(b.id);
  const result = resolveBotRun(source, room.id);
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.value.members.map((m) => m.id), [a.id, c.id]);
  store.archive(c.id);
  const refused = resolveBotRun(source, room.id);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /^Standup is archived\. Restore it/);
});

test("a room whose members cannot be found says so, and does not start", () => {
  const { store, source } = setup();
  const a = store.create({ name: "Ada" });
  const b = store.create({ name: "Bo" });
  const room = store.create({ name: "Standup", kind: "room", memberBotIds: [a.id, b.id] });
  const blind = { ...source, store: { get: (id: string) => (id === room.id ? store.get(id) : undefined), dataDir: (id: string) => store.dataDir(id) } };
  const refused = resolveBotRun(blind, room.id);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "conflict");
    assert.match(refused.error, /^None of the Bots in Standup can answer\./);
  }
});

test("resolving again returns a fresh persona that reflects an edit", () => {
  const { store, source } = setup();
  const bot = store.create({ name: "Ada" });
  const before = resolveBotRun(source, bot.id);
  store.update(bot.id, { role: "researcher" });
  const after = resolveBotRun(source, bot.id);
  assert.ok(before.ok && after.ok);
  if (!before.ok || !after.ok) return;
  assert.match(before.value.persona, /Your role: assistant\./, "the default role until it is edited");
  assert.match(after.value.persona, /Your role: researcher\./);
  assert.equal(after.value.cwd, before.value.cwd, "the folder is stable across edits");
});

test("a Bot run drops the project's own capabilities and keeps the user's and plugins'", () => {
  const caps = {
    commands: [{ name: "keep-commands-untouched", source: "workspace" }],
    skills: [{ name: "a", source: "workspace" }, { name: "b", source: "user" }, { name: "c", source: "plugin:x" }],
    subagents: [{ name: "d", source: "workspace" }, { name: "e", source: "user" }],
    hooks: [{ name: "f", source: "workspace" }, { name: "g", source: "user" }],
    mcpServers: [{ name: "h", source: "workspace" }, { name: "i", source: "plugin:y" }],
  };
  const out = withoutWorkspaceCaps(caps);
  assert.deepEqual(out.skills.map((c) => c.name), ["b", "c"]);
  assert.deepEqual(out.subagents.map((c) => c.name), ["e"]);
  assert.deepEqual(out.hooks.map((c) => c.name), ["g"]);
  assert.deepEqual(out.mcpServers.map((c) => c.name), ["i"]);
  assert.equal(out.commands, caps.commands, "fields it does not know about pass through untouched");
  assert.equal(caps.skills.length, 3, "the input is not mutated");
});

test("a Bot works in its own folder and has nothing to trust, even with a project open", () => {
  assert.deepEqual(runScope({ cwd: "/bots/a/files" }, "/work/project", "/home/me"), { cwd: "/bots/a/files", trustRoot: null });
  assert.deepEqual(runScope({ cwd: "/bots/a/files" }, null, "/home/me"), { cwd: "/bots/a/files", trustRoot: null });
});

test("without a Bot the run works in the open project, which is what must be trusted", () => {
  assert.deepEqual(runScope(null, "/work/project", "/home/me"), { cwd: "/work/project", trustRoot: "/work/project" });
});

test("without a Bot or a project the run falls back to the home folder with nothing to trust", () => {
  assert.deepEqual(runScope(null, null, "/home/me"), { cwd: "/home/me", trustRoot: null });
});

test("a persona goes after the agent prompt, and no persona leaves the prompt untouched", () => {
  assert.equal(withBotPersona("Base prompt.", "<bot_identity>\nYou are Ada.\n</bot_identity>"), "Base prompt.\n\n<bot_identity>\nYou are Ada.\n</bot_identity>");
  assert.equal(withBotPersona("Base prompt.", undefined), "Base prompt.");
  assert.equal(withBotPersona("Base prompt.", ""), "Base prompt.");
});

test("requireBotRun hands back the same context a chat run would get", () => {
  const { store, source } = setup();
  const bot = store.create({ name: "Ada", purpose: "Find sources." });
  const run = requireBotRun(source, bot.id);
  assert.equal(run.bot.id, bot.id);
  assert.match(run.persona, /Find sources\./);
});

test("requireBotRun throws the refusal as a readable error for runs with no chat to show it in", () => {
  const { store, source } = setup();
  const archived = store.create({ name: "Ada" });
  store.archive(archived.id);
  assert.throws(() => requireBotRun(source, archived.id), /Ada is archived\. Restore it to chat with it\./);
  assert.throws(() => requireBotRun(source, "bot_ghost"), /no longer exists/);
  assert.throws(() => requireBotRun(undefined, "bot_ghost"), /Bots are not available/);
});

test("a routine cannot run as a room, when it is made or when it runs", () => {
  const { store, source } = setup();
  const a = store.create({ name: "Ada" });
  const b = store.create({ name: "Bo" });
  const room = store.create({ name: "Standup", kind: "room", memberBotIds: [a.id, b.id] });
  const refused = resolveRoutineBot(source, room.id);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "invalid");
    assert.equal(refused.error, "Standup is a room. Give the routine to one of its Bots.");
  }
  assert.throws(() => requireBotRun(source, room.id), /^Error: Standup is a room\. Give the routine to one of its Bots\.$/);
});

test("a routine can be given to a Bot, which says where it will work; a Bot that cannot run says why", () => {
  const { dir, store, source } = setup();
  const bot = store.create({ name: "Ada" });
  const ok = resolveRoutineBot(source, bot.id);
  assert.deepEqual(ok, { ok: true, value: { cwd: join(dir, "bots", bot.id, "files") } });
  const gone = resolveRoutineBot(source, "nope");
  assert.equal(gone.ok, false);
  if (!gone.ok) assert.equal(gone.code, "not_found");
  assert.deepEqual(resolveRoutineBot(undefined, bot.id), { ok: false, error: "Bots are not available in this window.", code: "invalid" });
});
