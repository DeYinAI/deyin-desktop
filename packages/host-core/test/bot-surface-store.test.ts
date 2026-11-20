import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SURFACE_LIMITS } from "../src/bots/surfaces.js";
import { Outbox, SurfaceStore, XCursors } from "../src/bots/surface-store.js";
import { BotError } from "../src/bots/types.js";
import { FileStorage, type SecretCipher } from "../src/storage.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A cipher that is visibly not the plaintext, so a test can tell encrypted from plain. */
const rot: SecretCipher = {
  encrypt: (plain) => `enc:${Buffer.from(plain).toString("base64")}`,
  decrypt: (stored) => (stored.startsWith("enc:") ? Buffer.from(stored.slice(4), "base64").toString() : null),
};

function open(options: { dir?: string; cipher?: SecretCipher } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "deyin-surfaces-"));
  if (!dirs.includes(dir)) dirs.push(dir);
  const storage = new FileStorage(dir, options.cipher ?? rot);
  storages.push(storage);
  let clock = 1000;
  let n = 0;
  const store = new SurfaceStore(storage, { now: () => (clock += 10), makeKey: () => `key-${(n += 1)}` });
  const outbox = new Outbox(storage, { now: () => (clock += 10), newId: () => `post-${(n += 1)}` });
  return { dir, storage, store, outbox };
}

function refused(run: () => unknown, code: BotError["code"], pattern: RegExp): void {
  assert.throws(run, (error) => error instanceof BotError && error.code === code && pattern.test(error.message));
}

const slackForm = (over: Record<string, unknown> = {}) => ({
  routineId: "r1",
  enabled: true,
  allow: ["U024BE7LH"],
  settings: {},
  secrets: { signingSecret: "sign-123", botToken: "xoxb-456" },
  ...over,
});

test("a webhook gets a key of its own on first save, shown once and then never again", () => {
  const { store } = open();
  const saved = store.save("ada", "webhook", { routineId: "r1", enabled: true });
  assert.deepEqual(saved.generated, { key: "key-1" });
  assert.equal(saved.view.enabled, true);
  assert.deepEqual(saved.view.missing, []);
  assert.deepEqual(saved.view.has, { key: true });
  assert.equal(JSON.stringify(saved.view).includes("key-1"), false, "the view never carries a secret");
  const again = store.save("ada", "webhook", { routineId: "r1", enabled: true });
  assert.deepEqual(again.generated, {}, "saving again does not change the key");
  assert.equal(store.secret("ada", "webhook", "key"), "key-1");
});

test("a new key replaces the old one at once and is returned once", () => {
  const { store } = open();
  store.save("ada", "webhook", { routineId: "r1", enabled: true });
  const made = store.remake("ada", "webhook", "key");
  assert.equal(made.value, "key-2");
  assert.equal(store.secret("ada", "webhook", "key"), "key-2");
  refused(() => store.remake("ada", "slack", "botToken"), "not_found", /Set this surface up first/);
  store.save("ada", "slack", slackForm());
  refused(() => store.remake("ada", "slack", "botToken"), "invalid", /cannot be made here/);
});

test("secrets are sealed on disk, stay out of every view, and can only be read through secret", () => {
  const { store, storage, dir } = open();
  const saved = store.save("ada", "slack", slackForm());
  assert.deepEqual(saved.view.has, { signingSecret: true, botToken: true });
  assert.equal(JSON.stringify(store.list("ada")).includes("xoxb-456"), false);
  assert.equal(JSON.stringify(store.active()).includes("sign-123"), false);
  assert.equal(store.secret("ada", "slack", "botToken"), "xoxb-456");
  assert.equal(store.secret("ada", "slack", "nope"), null);
  assert.equal(store.secret("grace", "slack", "botToken"), null);
  return storage.flush().then(() => {
    const onDisk = readFileSync(join(dir, "bot-surfaces.json"), "utf8");
    assert.equal(onDisk.includes("xoxb-456"), false);
    assert.equal(onDisk.includes("sign-123"), false);
    assert.match(onDisk, /enc:/);
  });
});

test("a secret left empty keeps what was saved, and a new one replaces it", () => {
  const { store } = open();
  store.save("ada", "slack", slackForm());
  store.save("ada", "slack", slackForm({ secrets: { signingSecret: "", botToken: "xoxb-new" }, allow: ["U999"] }));
  assert.equal(store.secret("ada", "slack", "signingSecret"), "sign-123");
  assert.equal(store.secret("ada", "slack", "botToken"), "xoxb-new");
  assert.deepEqual(store.get("ada", "slack")?.allow, ["U999"]);
});

test("a settings field left empty is cleared, so what is shown is what is saved", () => {
  const { store } = open();
  const teams = { routineId: "r1", enabled: true, allow: ["29:abc"], secrets: { appPassword: "pw" } };
  store.save("ada", "teams", { ...teams, settings: { appId: "11111111-2222-3333-4444-555555555555", tenantId: "contoso.onmicrosoft.com" } });
  const cleared = store.save("ada", "teams", { ...teams, settings: { appId: "11111111-2222-3333-4444-555555555555", tenantId: "" } });
  assert.deepEqual(cleared.view.settings, { appId: "11111111-2222-3333-4444-555555555555" });
});

test("a surface cannot be turned on while something it needs is missing, and the refusal says what", () => {
  const { store } = open();
  refused(() => store.save("ada", "slack", slackForm({ secrets: {} })), "invalid", /Still needed: signingSecret, botToken/);
  refused(() => store.save("ada", "slack", slackForm({ allow: [] })), "invalid", /Still needed: allow/);
  refused(() => store.save("ada", "slack", slackForm({ routineId: "" })), "invalid", /Still needed: routine/);
  assert.deepEqual(store.list("ada"), [], "a refused save leaves nothing behind");
  const half = store.save("ada", "slack", slackForm({ enabled: false, secrets: { signingSecret: "s" } }));
  assert.equal(half.view.enabled, false);
  assert.deepEqual(half.view.missing, ["botToken"]);
  refused(() => store.setEnabled("ada", "slack", true), "invalid", /Still needed: botToken/);
  assert.equal(store.get("ada", "slack")?.enabled, false, "and it stays off");
});

test("a refused change leaves what was saved exactly as it was", () => {
  const { store } = open();
  store.save("ada", "slack", slackForm());
  const before = JSON.stringify(store.list("ada"));
  refused(() => store.save("ada", "slack", slackForm({ allow: ["not an id"] })), "invalid", /Slack member ids/);
  assert.equal(JSON.stringify(store.list("ada")), before);
});

test("turning a surface off keeps how it was set up, and only ones that are on and complete are served", () => {
  const { store } = open();
  store.save("ada", "slack", slackForm());
  store.save("ada", "webhook", { routineId: "r2", enabled: false });
  store.save("grace", "slack", slackForm({ enabled: false }));
  assert.deepEqual(store.active().map((v) => `${v.botId}/${v.surface}`), ["ada/slack"]);
  const off = store.setEnabled("ada", "slack", false);
  assert.equal(off.enabled, false);
  assert.deepEqual(store.active(), []);
  assert.equal(store.secret("ada", "slack", "botToken"), "xoxb-456", "how it was set up is kept");
  assert.equal(store.setEnabled("ada", "slack", true).enabled, true);
  refused(() => store.setEnabled("ada", "teams", true), "not_found", /not set up/);
});

test("a Bot's surfaces are its own: another Bot sees none of them", () => {
  const { store } = open();
  store.save("ada", "slack", slackForm());
  assert.deepEqual(store.list("grace"), []);
  assert.equal(store.get("grace", "slack"), null);
  store.save("ada", "webhook", { routineId: "r1", enabled: true });
  assert.deepEqual(store.list("ada").map((v) => v.surface), ["slack", "webhook"], "listed in a steady order");
});

test("deleting a routine switches off what pointed at it; deleting a Bot takes its surfaces and secrets", () => {
  const { store } = open();
  store.save("ada", "slack", slackForm({ routineId: "gone" }));
  store.save("ada", "webhook", { routineId: "kept", enabled: true });
  store.routineRemoved("gone");
  const slack = store.get("ada", "slack");
  assert.equal(slack?.enabled, false);
  assert.equal(slack?.routineId, "");
  assert.deepEqual(slack?.missing, ["routine"]);
  assert.equal(store.get("ada", "webhook")?.enabled, true);
  store.save("grace", "webhook", { routineId: "g", enabled: true });
  store.removeBot("ada");
  assert.deepEqual(store.list("ada"), []);
  assert.equal(store.secret("ada", "webhook", "key"), null);
  assert.equal(store.list("grace").length, 1);
  store.remove("grace", "webhook");
  assert.deepEqual(store.list("grace"), []);
  store.remove("grace", "webhook");
});

test("every secret held can be listed for scrubbing, and nothing else is in the list", () => {
  const { store } = open();
  store.save("ada", "slack", slackForm());
  store.save("ada", "webhook", { routineId: "r", enabled: true });
  assert.deepEqual(store.allSecrets().sort(), ["key-1", "sign-123", "xoxb-456"]);
});

test("what was saved is there after a restart, and a file that is damaged is read as far as it can be", async () => {
  const first = open();
  first.store.save("ada", "slack", slackForm());
  await first.storage.flush();
  const second = open({ dir: first.dir });
  assert.equal(second.store.get("ada", "slack")?.enabled, true);
  assert.equal(second.store.secret("ada", "slack", "botToken"), "xoxb-456");
  const corrupt = open();
  corrupt.storage.writeJson("bot-surfaces.json", { surfaces: [{ nonsense: true }, null, 7] });
  await corrupt.storage.flush();
  assert.deepEqual(open({ dir: corrupt.dir }).store.list("ada"), []);
});

test("a secret that cannot be decrypted any more reads as missing, not as a crash or an empty key that lets everyone in", async () => {
  const { store, storage } = open();
  store.save("ada", "webhook", { routineId: "r", enabled: true });
  await storage.flush();
  const lost = new SurfaceStore({ readJson: storage.readJson.bind(storage), writeJson: storage.writeJson.bind(storage), cipher: { encrypt: rot.encrypt, decrypt: () => null } });
  assert.ok(lost.get("ada", "webhook"), "the surface itself is really there");
  assert.equal(lost.secret("ada", "webhook", "key"), null);
  assert.equal(lost.get("ada", "webhook")?.has.key, false, "and says the key is gone, so it asks for a new one instead of looking ready");
  assert.deepEqual(lost.get("ada", "webhook")?.missing, ["key"]);
  assert.deepEqual(lost.active(), [], "it is not served while it cannot check anyone");
  const throwing = new SurfaceStore({
    readJson: storage.readJson.bind(storage),
    writeJson: storage.writeJson.bind(storage),
    cipher: {
      encrypt: rot.encrypt,
      decrypt: () => {
        throw new Error("keychain locked");
      },
    },
  });
  assert.equal(throwing.get("ada", "webhook")?.has.key, false);
  assert.equal(throwing.secret("ada", "webhook", "key"), null);
  assert.deepEqual(throwing.allSecrets(), []);
});

test("a surface's view carries no secret field at all, sealed or not", () => {
  const { store } = open();
  const saved = store.save("ada", "slack", slackForm());
  for (const view of [saved.view, ...store.list("ada"), ...store.active(), store.get("ada", "slack")]) {
    assert.ok(view && !("secrets" in view), "no secrets key");
    assert.equal(JSON.stringify(view).includes("enc:"), false, "not even the sealed form leaves the store");
  }
});

test("an empty secret in the file reads as missing, never as an empty key", async () => {
  const { storage } = open();
  const record = (secrets: Record<string, string>) => ({
    botId: "ada",
    surface: "webhook",
    routineId: "r",
    enabled: true,
    allow: [],
    settings: {},
    secrets,
    createdAt: 1,
    updatedAt: 1,
  });
  storage.writeJson("bot-surfaces.json", { surfaces: [record({ key: "" }), { ...record({ key: rot.encrypt("") }), botId: "grace" }] });
  await storage.flush();
  const store = new SurfaceStore(storage);
  assert.equal(store.secret("ada", "webhook", "key"), null, "stored as nothing");
  assert.equal(store.secret("grace", "webhook", "key"), null, "stored as the sealed form of nothing");
  assert.equal(store.get("ada", "webhook")?.has.key, false);
  assert.deepEqual(store.active(), [], "a surface that is on but has lost what it needs is not served");
});

test("a surface keeps the moment it was first set up through later saves", () => {
  const { store } = open();
  const first = store.save("ada", "slack", slackForm()).view;
  const second = store.save("ada", "slack", slackForm({ allow: ["U024BE7LH", "U999"] })).view;
  assert.equal(second.createdAt, first.createdAt);
  assert.ok(second.updatedAt > first.updatedAt);
});

test("the store says whether secrets are encrypted or only protected by file permissions", () => {
  assert.equal(open().store.protection(), "encrypted");
  const plain: SecretCipher = { encrypt: (v) => `plain:${v}`, decrypt: (v) => (v.startsWith("plain:") ? v.slice(6) : null) };
  assert.equal(open({ cipher: plain }).store.protection(), "file-permissions");
  const broken: SecretCipher = {
    encrypt: () => {
      throw new Error("no keychain");
    },
    decrypt: () => null,
  };
  assert.equal(open({ cipher: broken }).store.protection(), "file-permissions");
});

test("listeners hear about every change that is made, and stop hearing when they let go", () => {
  const { store } = open();
  let heard = 0;
  const stop = store.onChange(() => (heard += 1));
  store.save("ada", "webhook", { routineId: "r", enabled: true });
  store.remake("ada", "webhook", "key");
  store.setEnabled("ada", "webhook", false);
  store.remove("ada", "webhook");
  assert.equal(heard, 4);
  stop();
  store.save("ada", "webhook", { routineId: "r", enabled: true });
  assert.equal(heard, 4);
});

/* Outbox ---------------------------------------------------------------------------- */

const draft = (over: Record<string, unknown> = {}) => ({ botId: "ada", inReplyTo: "1001", context: "@ada asked about pricing", author: "@ada", text: "Thanks for asking!", ...over });

test("a draft waits in the Outbox, not posted, with the post it answers and who wrote it", () => {
  const { outbox } = open();
  const post = outbox.add(draft());
  assert.equal(post.status, "pending");
  assert.equal(post.surface, "x");
  assert.equal(outbox.pendingCount(), 1);
  assert.equal(outbox.pendingCount("grace"), 0);
  assert.deepEqual(outbox.list("ada").map((p) => p.id), [post.id]);
  assert.deepEqual(outbox.list("grace"), []);
  assert.equal(outbox.get(post.id)?.text, "Thanks for asking!");
  assert.equal(outbox.get("nope"), null);
});

test("a second reply to a post that already has one waiting or posted is refused, but one after a denial or a failure is allowed", () => {
  const { outbox } = open();
  const first = outbox.add(draft());
  refused(() => outbox.add(draft({ text: "Another" })), "conflict", /already a reply/);
  outbox.add(draft({ botId: "grace" }));
  outbox.deny(first.id);
  const retry = outbox.add(draft({ text: "Second try" }));
  outbox.claim(retry.id);
  refused(() => outbox.add(draft({ text: "Third" })), "conflict", /already a reply/);
  outbox.sent(retry.id, "https://x.com/i/web/status/1");
  refused(() => outbox.add(draft({ text: "After it went" })), "conflict", /already a reply/);
  outbox.failed(retry.id, "403");
  assert.equal(outbox.add(draft({ text: "Fourth" })).status, "pending");
});

test("an empty draft is refused, a long one is kept so the person can shorten it, and a draft is clipped in its context", () => {
  const { outbox } = open();
  refused(() => outbox.add(draft({ text: "   " })), "invalid", /some words/);
  const long = outbox.add(draft({ text: "a".repeat(300), context: "c".repeat(2000), author: "@".padEnd(300, "x") }));
  assert.equal(long.text.length, 300);
  assert.equal(long.context.length, 600);
  assert.equal(long.author.length, 100);
});

test("only so many drafts may wait at once", () => {
  const { outbox } = open();
  for (let n = 0; n < SURFACE_LIMITS.outbox; n += 1) outbox.add(draft({ inReplyTo: String(n + 1) }));
  refused(() => outbox.add(draft({ inReplyTo: "99999" })), "limit", /already 50 posts waiting/);
});

test("the words of a waiting draft can be changed, and no others", () => {
  const { outbox } = open();
  const post = outbox.add(draft());
  assert.equal(outbox.edit(post.id, "  Better words ").text, "Better words");
  outbox.deny(post.id);
  refused(() => outbox.edit(post.id, "x"), "conflict", /already been decided/);
  refused(() => outbox.edit("nope", "x"), "not_found", /not in the Outbox/);
});

test("approving takes the draft once: it cannot be claimed twice, and the words posted are the words on the card at that moment", () => {
  const { outbox } = open();
  const post = outbox.add(draft());
  outbox.edit(post.id, "Edited just before");
  const claimed = outbox.claim(post.id);
  assert.equal(claimed.text, "Edited just before");
  assert.equal(outbox.get(post.id)?.status, "posting");
  refused(() => outbox.claim(post.id), "conflict", /already been decided/);
  refused(() => outbox.deny(post.id), "conflict", /already been decided/);
  assert.equal(outbox.pendingCount(), 0);
  outbox.sent(post.id, "https://x.com/i/web/status/5");
  assert.equal(outbox.get(post.id)?.status, "sent");
  assert.equal(outbox.get(post.id)?.url, "https://x.com/i/web/status/5");
});

test("a draft that is empty or too long cannot be approved until it is fixed", () => {
  const { outbox } = open();
  const post = outbox.add(draft({ text: "a".repeat(281) }));
  refused(() => outbox.claim(post.id), "invalid", /longer than 280/);
  assert.equal(outbox.get(post.id)?.status, "pending", "a refused approval leaves it waiting");
  outbox.edit(post.id, "short");
  assert.equal(outbox.claim(post.id).text, "short");
  const blank = outbox.add(draft({ inReplyTo: "2" }));
  outbox.edit(blank.id, "  ");
  refused(() => outbox.claim(blank.id), "invalid", /some words/);
});

test("a post X refused is recorded with why, and is never posted again by itself", () => {
  const { outbox } = open();
  const post = outbox.add(draft());
  outbox.claim(post.id);
  outbox.failed(post.id, "x".repeat(900));
  const after = outbox.get(post.id);
  assert.equal(after?.status, "failed");
  assert.equal(after?.error?.length, 500);
  refused(() => outbox.claim(post.id), "conflict", /already been decided/);
  outbox.sent("nope", "u");
  outbox.failed("nope", "e");
});

test("a post that was being sent when the app closed is reported as not known, never sent again on a guess", async () => {
  const first = open();
  const post = first.outbox.add(draft());
  first.outbox.claim(post.id);
  await first.storage.flush();
  const second = open({ dir: first.dir });
  const found = second.outbox.get(post.id);
  assert.equal(found?.status, "failed");
  assert.match(found?.error ?? "", /Look on X before posting it again/);
  refused(() => second.outbox.claim(post.id), "conflict", /already been decided/);
});

test("denying records the decision and posts nothing", () => {
  const { outbox } = open();
  const post = outbox.add(draft());
  const denied = outbox.deny(post.id);
  assert.equal(denied.status, "denied");
  assert.ok((denied.decidedAt ?? 0) > 0);
  assert.equal(outbox.pendingCount(), 0);
});

test("the oldest decided posts are forgotten first and a waiting one is never dropped to make room", () => {
  const { outbox } = open();
  const waiting = outbox.add(draft({ inReplyTo: "1" }));
  for (let n = 0; n < 205; n += 1) {
    const post = outbox.add(draft({ inReplyTo: String(1000 + n) }));
    outbox.deny(post.id);
  }
  const all = outbox.list();
  assert.equal(all.length, 201);
  assert.ok(all.some((p) => p.id === waiting.id));
  assert.equal(all.filter((p) => p.status === "denied").length, 200);
});

test("the outbox survives a restart, and a Bot that is deleted takes its drafts", async () => {
  const first = open();
  first.outbox.add(draft());
  first.outbox.add(draft({ botId: "grace" }));
  await first.storage.flush();
  const second = open({ dir: first.dir });
  assert.equal(second.outbox.list().length, 2);
  second.outbox.removeBot("ada");
  assert.deepEqual(second.outbox.list().map((p) => p.botId), ["grace"]);
  let heard = 0;
  second.outbox.onChange(() => (heard += 1));
  second.outbox.removeBot("nobody");
  assert.equal(heard, 0, "nothing changed, so nobody is told");
  second.outbox.removeBot("grace");
  assert.equal(heard, 1);
});

test("junk in the outbox file is left out, and what is real is kept", async () => {
  const { storage } = open();
  const real = { id: "p1", botId: "ada", surface: "x", inReplyTo: "1", context: "", author: "@a", text: "hi", status: "pending", createdAt: 1 };
  storage.writeJson("bot-outbox.json", { posts: [null, 7, { id: "p2" }, { ...real, id: "p3", status: "sent-ish" }, { ...real, id: "p4", surface: "slack" }, real] });
  await storage.flush();
  assert.deepEqual(new Outbox(storage).list().map((post) => post.id), ["p1"]);
});

test("the hub's port and public address are saved with the surfaces, checked, and kept across a restart", async () => {
  const first = open();
  assert.deepEqual(first.store.hubSettings(), { port: 47_823, publicUrl: "" });
  assert.deepEqual(first.store.setHubSettings({ port: 5001, publicUrl: "https://bot.example.com/" }), { port: 5001, publicUrl: "https://bot.example.com" });
  refused(() => first.store.setHubSettings({ port: 80 }), "invalid", /port must be/);
  assert.equal(first.store.hubSettings().port, 5001, "a refused change leaves what was there");
  first.store.save("ada", "webhook", { routineId: "r", enabled: true });
  await first.storage.flush();
  const second = open({ dir: first.dir });
  assert.deepEqual(second.store.hubSettings(), { port: 5001, publicUrl: "https://bot.example.com" });
  assert.equal(second.store.get("ada", "webhook")?.enabled, true, "surfaces and settings share a file without hurting each other");
  const damaged = open();
  damaged.storage.writeJson("bot-surfaces.json", { surfaces: [], hub: { port: "x", publicUrl: "http://no" } });
  await damaged.storage.flush();
  assert.deepEqual(open({ dir: damaged.dir }).store.hubSettings(), { port: 47_823, publicUrl: "" });
});

test("where X was last read to is kept per Bot across a restart, and nothing that is not a post id is kept", async () => {
  const first = open();
  const cursors = new XCursors(first.storage);
  assert.equal(cursors.get("ada"), undefined);
  cursors.set("ada", "1004");
  cursors.set("grace", "2000");
  cursors.set("ada", "not a number");
  cursors.set("ada", "");
  assert.equal(cursors.get("ada"), "1004");
  await first.storage.flush();
  const again = new XCursors(open({ dir: first.dir }).storage);
  assert.equal(again.get("ada"), "1004");
  assert.equal(again.get("grace"), "2000");
  again.forget("ada");
  again.forget("ada");
  assert.equal(again.get("ada"), undefined);
  assert.equal(again.get("grace"), "2000");
  const damaged = open();
  damaged.storage.writeJson("bot-x-cursors.json", { cursors: { ada: 7, grace: "x1", mia: "55" } });
  await damaged.storage.flush();
  const read = new XCursors(open({ dir: damaged.dir }).storage);
  assert.deepEqual([read.get("ada"), read.get("grace"), read.get("mia")], [undefined, undefined, "55"]);
  const notAnObject = open();
  notAnObject.storage.writeJson("bot-x-cursors.json", { cursors: [1, 2] });
  await notAnObject.storage.flush();
  assert.equal(new XCursors(open({ dir: notAnObject.dir }).storage).get("0"), undefined);
});
