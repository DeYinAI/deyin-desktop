import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { isBotAvatarColor, isBotAvatarShape } from "../src/bots/avatar.js";
import { BotStore } from "../src/bots/store.js";
import type { BotsSnapshot } from "../src/bots/state.js";
import { BOT_LIMITS, BotError, type BotInput } from "../src/bots/types.js";
import { FileStorage } from "../src/storage.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  // Writes are queued asynchronously; let them land first or they recreate the directory after it is removed.
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deyin-bots-"));
  dirs.push(dir);
  return dir;
}

interface Harness {
  dir: string;
  storage: FileStorage;
  store: BotStore;
  tick(): number;
}

function harness(dir = tempDir()): Harness {
  let clock = 1_000;
  let n = 0;
  const storage = new FileStorage(dir);
  storages.push(storage);
  const store = new BotStore(storage, {
    now: () => (clock += 10),
    newId: () => `bot_t${(n += 1)}`,
  });
  return { dir, storage, store, tick: () => (clock += 10) };
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof BotError ? error.code : `unexpected:${String(error)}`;
  }
  return undefined;
};

test("the first Bot created becomes the primary Bot with sensible defaults", () => {
  const { store } = harness();
  const bot = store.create({ name: "  Ava  " });
  assert.equal(bot.name, "Ava");
  assert.equal(bot.handle, "ava");
  assert.equal(bot.isPrimary, true);
  assert.equal(bot.harness, "local");
  assert.equal(bot.kind, "agent");
  assert.equal(bot.visibility, "owner");
  assert.equal(bot.role, "assistant");
  assert.equal(bot.autoReview.approvalMode, "auto_review");
  assert.equal(bot.archived, false);
  assert.ok(isBotAvatarShape(bot.avatarShape) && isBotAvatarColor(bot.avatarColor));
  assert.equal(bot.avatarVersion, 1);
  assert.equal(bot.createdAt, bot.updatedAt);
});

test("later Bots are not primary, and two Bots with one name get distinct handles", () => {
  const { store } = harness();
  const a = store.create({ name: "Ava" });
  const b = store.create({ name: "Ava" });
  assert.equal(b.isPrimary, false);
  assert.equal(store.primary()?.id, a.id);
  assert.equal(a.handle, "ava");
  assert.equal(b.handle, "ava-2");
  assert.equal(store.getByHandle("@AVA-2")?.id, b.id, "lookup ignores case and a leading @");
});

test("create honors the fields it is given and trims them", () => {
  const { store } = harness();
  const bot = store.create({
    name: "Rex",
    title: " Reviewer ",
    description: " Reads diffs ",
    role: "reviewer",
    purpose: "Review pull requests.",
    publicDescription: "A code reviewer.",
    avatarShape: "hexagon",
    avatarColor: "iris",
    approvalMode: "read_only",
    harness: "server",
    hostId: " dell ",
    routinePolicy: { allowCollaboratorCreation: true },
    legacyBotId: "old_1",
  });
  assert.equal(bot.title, "Reviewer");
  assert.equal(bot.description, "Reads diffs");
  assert.equal(bot.role, "reviewer");
  assert.equal(bot.purpose, "Review pull requests.");
  assert.equal(bot.publicDescription, "A code reviewer.");
  assert.equal(bot.avatarShape, "hexagon");
  assert.equal(bot.avatarColor, "iris");
  assert.equal(bot.autoReview.approvalMode, "read_only");
  assert.equal(bot.harness, "server");
  assert.equal(bot.hostId, "dell");
  assert.deepEqual(bot.routinePolicy, { allowCollaboratorCreation: true });
  assert.equal(bot.legacyBotId, "old_1");
});

test("create refuses invalid input with an `invalid` error and does not store anything", () => {
  const { store } = harness();
  const bad: BotInput[] = [
    { name: "" },
    { name: "x".repeat(BOT_LIMITS.name + 1) },
    { name: "a", harness: "server" },
    { name: "a", avatarShape: "pumpkin" as never },
    { name: "a", visibility: "team" },
    { name: "a", memberBotIds: ["bot_x"] },
  ];
  for (const input of bad) assert.equal(code(() => store.create(input)), "invalid", JSON.stringify(input));
  assert.equal(store.list({ includeArchived: true }).length, 0);
});

test("there is a cap on active Bots, and archiving frees a place", () => {
  const { store } = harness();
  for (let i = 0; i < BOT_LIMITS.maxBots; i++) store.create({ name: `Bot ${i}` });
  assert.equal(code(() => store.create({ name: "One too many" })), "limit");
  store.archive(store.list()[1]!.id);
  assert.doesNotThrow(() => store.create({ name: "Now there is room" }));
});

test("Bots survive a restart: a new store over the same files sees them", async () => {
  const h = harness();
  const a = h.store.create({ name: "Ava", purpose: "Keep going" });
  h.store.create({ name: "Bo" });
  h.store.setPinned(a.id, true);
  await h.storage.flush();

  const reopened = harness(h.dir);
  assert.deepEqual(reopened.store.list().map((b) => b.name), ["Ava", "Bo"]);
  assert.equal(reopened.store.primary()?.id, a.id);
  assert.equal(reopened.store.get(a.id)?.purpose, "Keep going");
  assert.deepEqual(reopened.store.layout().pinned, [a.id]);
});

test("a first launch does not write an empty bots.json", async () => {
  const h = harness();
  await h.storage.flush();
  assert.equal(existsSync(join(h.dir, "bots.json")), false);
});

test("a corrupt bots.json yields an empty roster instead of crashing", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "bots.json"), "{ this is not json");
  assert.deepEqual(harness(dir).store.list(), []);
});

test("a damaged bots.json is repaired and written back once", async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "bots.json"),
    JSON.stringify({ version: 1, bots: [{ id: "bot_a", name: "A" }, { id: "bot_a", name: "dup" }, { nope: true }], layout: {} }),
  );
  const h = harness(dir);
  assert.deepEqual(h.store.list().map((b) => b.id), ["bot_a"]);
  assert.equal(h.store.primary()?.id, "bot_a");
  await h.storage.flush();
  const onDisk = JSON.parse(readFileSync(join(dir, "bots.json"), "utf8")) as { bots: { id: string; isPrimary: boolean }[] };
  assert.deepEqual(onDisk.bots.map((b) => b.id), ["bot_a"]);
  assert.equal(onDisk.bots[0]!.isPrimary, true, "the repaired file is what is stored, so the next launch finds nothing to fix");
});

test("update changes only what is sent and bumps updatedAt", () => {
  const { store, tick } = harness();
  const bot = store.create({ name: "Ava", description: "old", title: "T" });
  tick();
  const next = store.update(bot.id, { description: "new" });
  assert.equal(next.description, "new");
  assert.equal(next.title, "T");
  assert.equal(next.name, "Ava");
  assert.ok(next.updatedAt > bot.updatedAt);
  assert.equal(next.createdAt, bot.createdAt);
});

test("renaming a Bot gives it a handle for the new name, unique among the others", () => {
  const { store } = harness();
  store.create({ name: "Ava" });
  const b = store.create({ name: "Bo" });
  assert.equal(store.update(b.id, { name: "Ava" }).handle, "ava-2");
  assert.equal(store.update(b.id, { name: "Cy" }).handle, "cy");
  assert.equal(store.update(b.id, { name: " Cy " }).handle, "cy", "an unchanged name keeps its handle");
});

test("clearing optional text removes it", () => {
  const { store } = harness();
  const bot = store.create({ name: "Ava", purpose: "p", publicDescription: "d" });
  const next = store.update(bot.id, { purpose: "", publicDescription: "  " });
  assert.equal(next.purpose, undefined);
  assert.equal(next.publicDescription, undefined);
  assert.equal(store.update(bot.id, { role: "" }).role, "assistant", "an empty role goes back to the default");
});

test("changing the avatar bumps its version; other edits do not", () => {
  const { store } = harness();
  const bot = store.create({ name: "Ava" });
  const png = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(store.update(bot.id, { description: "x" }).avatarVersion, 1);
  assert.equal(store.update(bot.id, { avatarColor: "coral" }).avatarVersion, 2);
  const withImage = store.update(bot.id, { avatarUrl: png });
  assert.equal(withImage.avatarUrl, png);
  assert.equal(withImage.avatarVersion, 3);
  const cleared = store.update(bot.id, { avatarUrl: null });
  assert.equal(cleared.avatarUrl, undefined);
  assert.equal(cleared.avatarVersion, 4);
});

test("moving a Bot between local and a server keeps host and harness consistent", () => {
  const { store } = harness();
  const bot = store.create({ name: "Ava" });
  assert.equal(code(() => store.update(bot.id, { harness: "server" })), "invalid", "a server needs a host");
  assert.equal(code(() => store.update(bot.id, { hostId: "dell" })), "invalid", "a host without a server harness is a mistake");
  const onServer = store.update(bot.id, { harness: "server", hostId: "dell" });
  assert.equal(onServer.hostId, "dell");
  assert.equal(store.update(bot.id, { hostId: "pi" }).hostId, "pi", "moving between servers");
  const home = store.update(bot.id, { harness: "local" });
  assert.equal(home.harness, "local");
  assert.equal(home.hostId, undefined, "coming home forgets the server");
});

test("update refuses unknown ids, invalid fields and archived Bots", () => {
  const { store } = harness();
  const bot = store.create({ name: "Ava" });
  assert.equal(code(() => store.update("bot_ghost", { name: "x" })), "not_found");
  assert.equal(code(() => store.update(bot.id, { name: "" })), "invalid");
  assert.equal(code(() => store.update(bot.id, { avatarUrl: "https://x/y.png" })), "invalid");
  store.create({ name: "Bo" });
  store.archive(bot.id);
  assert.equal(code(() => store.update(bot.id, { name: "Edited" })), "conflict");
});

test("an agent cannot be given members and a room's members are validated on update", () => {
  const { store } = harness();
  const a = store.create({ name: "A" });
  const b = store.create({ name: "B" });
  const c = store.create({ name: "C" });
  assert.equal(code(() => store.update(a.id, { memberBotIds: [b.id, c.id] })), "invalid");
  const room = store.create({ name: "Room", kind: "room", memberBotIds: [a.id, b.id] });
  assert.deepEqual(store.update(room.id, { memberBotIds: [a.id, b.id, c.id] }).memberBotIds, [a.id, b.id, c.id]);
  assert.equal(code(() => store.update(room.id, { memberBotIds: [a.id] })), "invalid", "a room keeps at least two");
  assert.equal(code(() => store.update(room.id, { memberBotIds: [a.id, room.id] })), "not_found", "a room cannot contain itself");
});

test("archiving the primary Bot hands primary to the next oldest active agent", () => {
  const { store } = harness();
  const a = store.create({ name: "A" });
  const b = store.create({ name: "B" });
  store.create({ name: "C" });
  store.archive(a.id);
  assert.equal(store.get(a.id)?.archived, true);
  assert.equal(store.get(a.id)?.isPrimary, false);
  assert.equal(store.primary()?.id, b.id);
  assert.deepEqual(store.list().map((x) => x.name), ["B", "C"]);
  assert.deepEqual(store.list({ includeArchived: true }).map((x) => x.name), ["A", "B", "C"]);
});

test("archiving the last active Bot leaves no primary, and restoring it brings one back", () => {
  const { store } = harness();
  const a = store.create({ name: "A" });
  store.archive(a.id);
  assert.equal(store.primary(), undefined);
  const restored = store.restore(a.id);
  assert.equal(restored.archived, false);
  assert.equal(restored.isPrimary, true);
});

test("restoring a Bot does not steal primary from the current one", () => {
  const { store } = harness();
  const a = store.create({ name: "A" });
  const b = store.create({ name: "B" });
  store.archive(a.id);
  assert.equal(store.primary()?.id, b.id);
  store.restore(a.id);
  assert.equal(store.primary()?.id, b.id);
});

test("archive and restore are idempotent", () => {
  const { store } = harness();
  const a = store.create({ name: "A" });
  store.create({ name: "B" });
  assert.equal(store.restore(a.id).archived, false);
  store.archive(a.id);
  assert.equal(store.archive(a.id).archived, true);
  assert.equal(code(() => store.archive("bot_ghost")), "not_found");
});

test("setPrimary moves the crown to exactly one Bot", () => {
  const { store } = harness();
  const a = store.create({ name: "A" });
  const b = store.create({ name: "B" });
  assert.equal(store.setPrimary(b.id).isPrimary, true);
  assert.equal(store.get(a.id)?.isPrimary, false);
  assert.equal(store.list().filter((x) => x.isPrimary).length, 1);
});

test("setPrimary refuses archived Bots, rooms and unknown ids", () => {
  const { store } = harness();
  const a = store.create({ name: "A" });
  const b = store.create({ name: "B" });
  const room = store.create({ name: "R", kind: "room", memberBotIds: [a.id, b.id] });
  assert.equal(code(() => store.setPrimary(room.id)), "invalid");
  store.archive(b.id);
  assert.equal(code(() => store.setPrimary(b.id)), "conflict");
  assert.equal(code(() => store.setPrimary("bot_ghost")), "not_found");
  assert.equal(store.primary()?.id, a.id, "refusals change nothing");
});

test("delete removes the Bot, its data directory, its layout entries, and promotes a new primary", () => {
  const { store, dir } = harness();
  const a = store.create({ name: "A" });
  const b = store.create({ name: "B" });
  store.setPinned(a.id, true);
  const sectioned = store.addSection("Work");
  store.moveToSection(a.id, sectioned.sections[0]!.id);
  const dataDir = store.dataDir(a.id);
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  writeFileSync(join(dataDir, "memory", "fact.md"), "remember me");

  store.delete(a.id);
  assert.equal(store.get(a.id), undefined);
  assert.equal(existsSync(dataDir), false, "what the Bot remembered goes with it");
  assert.equal(existsSync(join(dir, "bots", b.id)), false);
  assert.equal(store.primary()?.id, b.id);
  assert.deepEqual(store.layout().pinned, []);
  assert.deepEqual(store.layout().sections[0]!.botIds, []);
  assert.equal(code(() => store.delete(a.id)), "not_found");
});

test("deleting one Bot leaves another Bot's data alone", () => {
  const { store } = harness();
  const a = store.create({ name: "A" });
  const b = store.create({ name: "B" });
  mkdirSync(store.dataDir(b.id), { recursive: true });
  writeFileSync(join(store.dataDir(b.id), "keep.txt"), "x");
  store.delete(a.id);
  assert.equal(existsSync(join(store.dataDir(b.id), "keep.txt")), true);
});

test("dataDir refuses ids that could escape the Bots directory", () => {
  const { store } = harness();
  for (const id of ["../x", "a/b", "..", "", "_shared", "/etc"]) {
    assert.equal(code(() => store.dataDir(id)), "invalid", id);
  }
  assert.match(store.dataDir("bot_ok"), /bots[\\/]bot_ok$/);
});

test("rooms need at least two existing, active agents", () => {
  const { store } = harness();
  const a = store.create({ name: "A" });
  const b = store.create({ name: "B" });
  const other = store.create({ name: "Other", kind: "room", memberBotIds: [a.id, b.id] });
  assert.equal(code(() => store.create({ name: "R", kind: "room" })), "invalid");
  assert.equal(code(() => store.create({ name: "R", kind: "room", memberBotIds: [a.id] })), "invalid");
  assert.equal(code(() => store.create({ name: "R", kind: "room", memberBotIds: [a.id, a.id] })), "invalid", "duplicates do not count twice");
  assert.equal(code(() => store.create({ name: "R", kind: "room", memberBotIds: [a.id, "bot_ghost"] })), "not_found");
  assert.equal(code(() => store.create({ name: "R", kind: "room", memberBotIds: [a.id, other.id] })), "invalid", "rooms do not nest");
  store.archive(b.id);
  assert.equal(code(() => store.create({ name: "R", kind: "room", memberBotIds: [a.id, b.id] })), "conflict");
});

test("a room is archived, not lost, when its Bots go away, and restoring needs its Bots back", () => {
  const { store } = harness();
  const a = store.create({ name: "A" });
  const b = store.create({ name: "B" });
  store.create({ name: "C" });
  const room = store.create({ name: "R", kind: "room", memberBotIds: [a.id, b.id] });
  store.archive(b.id);
  assert.equal(store.get(room.id)?.archived, true);
  assert.equal(code(() => store.restore(room.id)), "conflict");
  store.restore(b.id);
  assert.equal(code(() => store.restore(room.id)), "conflict", "its membership shrank while archived, so it must be rebuilt");
});

test("deleting a member Bot removes it from rooms", () => {
  const { store } = harness();
  const a = store.create({ name: "A" });
  const b = store.create({ name: "B" });
  const c = store.create({ name: "C" });
  const room = store.create({ name: "R", kind: "room", memberBotIds: [a.id, b.id, c.id] });
  store.delete(c.id);
  assert.deepEqual(store.get(room.id)?.memberBotIds, [a.id, b.id]);
  assert.equal(store.get(room.id)?.archived, false);
});

test("roster layout changes persist and refuse Bots or sections that do not exist", async () => {
  const h = harness();
  const a = h.store.create({ name: "A" });
  h.store.setHidden(a.id, true);
  const layout = h.store.addSection("Work");
  const sectionId = layout.sections[0]!.id;
  h.store.moveToSection(a.id, sectionId);
  h.store.renameSection(sectionId, "Deep work");
  assert.equal(code(() => h.store.setPinned("bot_ghost", true)), "not_found");
  assert.equal(code(() => h.store.setHidden("bot_ghost", true)), "not_found");
  assert.equal(code(() => h.store.moveToSection("bot_ghost", null)), "not_found");
  assert.equal(code(() => h.store.moveToSection(a.id, "sec_ghost")), "not_found");
  await h.storage.flush();

  const reopened = harness(h.dir).store.layout();
  assert.deepEqual(reopened.hidden, [a.id]);
  assert.equal(reopened.sections[0]!.name, "Deep work");
  assert.deepEqual(reopened.sections[0]!.botIds, [a.id]);
  h.store.removeSection(sectionId);
  assert.deepEqual(h.store.layout().sections, []);
});

test("listeners hear about every change with the new roster, and stop when unsubscribed", () => {
  const { store } = harness();
  const heard: BotsSnapshot[] = [];
  const off = store.onChange((snapshot) => heard.push(snapshot));
  const a = store.create({ name: "A" });
  store.update(a.id, { description: "x" });
  store.setPinned(a.id, true);
  assert.equal(heard.length, 3);
  assert.equal(heard[2]!.layout.pinned[0], a.id);
  assert.equal(heard[0]!.bots[0]!.id, a.id);
  off();
  store.archive(a.id);
  assert.equal(heard.length, 3);
});

test("a refused change does not notify listeners or persist", async () => {
  const h = harness();
  h.store.create({ name: "A" });
  const heard: unknown[] = [];
  h.store.onChange((snapshot) => heard.push(snapshot));
  assert.equal(code(() => h.store.create({ name: "" })), "invalid");
  assert.equal(code(() => h.store.archive("bot_ghost")), "not_found");
  assert.equal(heard.length, 0);
});

test("snapshots handed out are not changed by later edits", () => {
  const { store } = harness();
  const a = store.create({ name: "A" });
  const before = store.snapshot();
  store.update(a.id, { description: "changed" });
  assert.equal(before.bots[0]!.description, "", "an earlier snapshot is a stable value");
});

test("a room holds at most eight Bots, on create and on update, and exactly eight is fine", () => {
  const { store } = harness();
  const bots = Array.from({ length: BOT_LIMITS.maxRoomMembers + 1 }, (_, i) => store.create({ name: `Bot ${i}` }));
  const ids = bots.map((bot) => bot.id);
  assert.equal(code(() => store.create({ name: "Big", kind: "room", memberBotIds: ids })), "limit");
  const room = store.create({ name: "Full", kind: "room", memberBotIds: ids.slice(0, BOT_LIMITS.maxRoomMembers) });
  assert.equal(room.memberBotIds.length, BOT_LIMITS.maxRoomMembers);
  assert.equal(code(() => store.update(room.id, { memberBotIds: ids })), "limit");
  assert.equal(store.get(room.id)?.memberBotIds.length, BOT_LIMITS.maxRoomMembers, "a refused change leaves the room as it was");
  const small = store.update(room.id, { memberBotIds: ids.slice(0, 2) });
  assert.deepEqual(small.memberBotIds, ids.slice(0, 2));
});

test("a room runs on this computer: it cannot be put on a server, when made or later", () => {
  const { store } = harness();
  const a = store.create({ name: "A" });
  const b = store.create({ name: "B" });
  assert.equal(code(() => store.create({ name: "R", kind: "room", memberBotIds: [a.id, b.id], harness: "server", hostId: "h1" })), "invalid");
  const room = store.create({ name: "R", kind: "room", memberBotIds: [a.id, b.id] });
  assert.equal(room.harness, "local");
  assert.equal(code(() => store.update(room.id, { harness: "server", hostId: "h1" })), "invalid");
  assert.equal(store.get(room.id)?.harness, "local");
  // The same change is still allowed for a Bot that is not a room.
  assert.equal(store.update(a.id, { harness: "server", hostId: "h1" }).harness, "server");
});
