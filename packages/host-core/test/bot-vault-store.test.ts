import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BotError } from "../src/bots/types.js";
import { VAULT_LIMITS } from "../src/bots/vault.js";
import { VaultStore } from "../src/bots/vault-store.js";
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

const FILE = "vault.json";
const VISA = "4242424242424242";

function open(options: { dir?: string; cipher?: SecretCipher } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "deyin-vault-"));
  if (!dirs.includes(dir)) dirs.push(dir);
  const storage = new FileStorage(dir, options.cipher ?? rot);
  storages.push(storage);
  let clock = 1000;
  let n = 0;
  const store = new VaultStore(storage, { now: () => (clock += 10), newId: () => `item-${(n += 1)}` });
  return { dir, storage, store };
}

const login = (over: Record<string, unknown> = {}) => ({ kind: "login", title: "GitHub", username: "ada", password: "hunter2hunter2", sites: ["github.com"], ...over });
const card = (over: Record<string, unknown> = {}) => ({ kind: "card", title: "Visa", number: VISA, securityCode: "123", expMonth: 4, expYear: new Date().getFullYear() + 3, holderName: "Ada", ...over });
const contact = (over: Record<string, unknown> = {}) => ({ kind: "contact", title: "Home", email: "ada@example.com", address: { line1: "1 Main St" }, ...over });

const refuses = (fn: () => unknown, code: BotError["code"], pattern: RegExp): void => {
  assert.throws(fn, (error) => error instanceof BotError && error.code === code && pattern.test(error.message));
};

test("a fresh Vault is empty and writes nothing", async () => {
  const h = open();
  assert.deepEqual(h.store.list(), []);
  assert.deepEqual(h.store.secretValues(), []);
  await h.storage.flush();
  assert.equal(existsSync(join(h.dir, FILE)), false);
});

test("saving a login returns a view without the password, and writes the password encrypted", async () => {
  const h = open();
  const view = h.store.put(login());
  assert.equal(view.kind, "login");
  assert.equal(JSON.stringify(view).includes("hunter2"), false);
  assert.equal(view.kind === "login" && view.hasPassword, true);
  assert.equal(h.store.field(view.id, "password"), "hunter2hunter2");
  assert.equal(h.store.field(view.id, "username"), "ada");
  await h.storage.flush();
  const raw = readFileSync(join(h.dir, FILE), "utf8");
  assert.equal(raw.includes("hunter2hunter2"), false, "the password is not on disk in the clear");
  assert.equal(raw.includes(Buffer.from("hunter2hunter2").toString("base64")), true, "it is on disk, through the cipher");
});

test("a card's number and security code are encrypted, and only the last four and brand are plain", async () => {
  const h = open();
  const view = h.store.put(card());
  await h.storage.flush();
  const raw = readFileSync(join(h.dir, FILE), "utf8");
  assert.equal(raw.includes(VISA), false);
  assert.equal(raw.includes('"123"'), false);
  assert.equal(raw.includes('"last4": "4242"'), true);
  assert.equal(view.kind === "card" && view.brand, "visa");
  assert.equal(h.store.field(view.id, "number"), VISA);
  assert.equal(h.store.field(view.id, "securityCode"), "123");
  assert.equal(h.store.field(view.id, "expiry")?.length, 5);
});

test("the list is by name, and get finds one", () => {
  const h = open();
  h.store.put(login({ title: "Zeta" }));
  h.store.put(login({ title: "alpha" }));
  h.store.put(contact({ title: "Mid" }));
  assert.deepEqual(h.store.list().map((item) => item.title), ["alpha", "Mid", "Zeta"]);
  const first = h.store.list()[0];
  assert.ok(first);
  assert.equal(h.store.get(first.id)?.title, "alpha");
  assert.equal(h.store.get("nope"), null);
});

test("items and permissions survive a restart", async () => {
  const first = open();
  const saved = first.store.put(login());
  first.store.grant("ada-bot", saved.id, "github.com");
  await first.storage.flush();
  const second = open({ dir: first.dir });
  assert.equal(second.store.list().length, 1);
  assert.equal(second.store.field(saved.id, "password"), "hunter2hunter2");
  assert.equal(second.store.hasGrant("ada-bot", saved.id, "github.com"), true);
});

test("changing a login keeps the password unless a new one is given", () => {
  const h = open();
  const saved = h.store.put(login());
  const renamed = h.store.put({ ...login({ id: saved.id, title: "GitHub work", sites: ["github.com", "gist.github.com"] }), password: undefined });
  assert.equal(renamed.title, "GitHub work");
  assert.equal(renamed.kind === "login" && renamed.sites.length, 2);
  assert.equal(renamed.createdAt, saved.createdAt);
  assert.ok(renamed.updatedAt > saved.updatedAt);
  assert.equal(h.store.field(saved.id, "password"), "hunter2hunter2");
  h.store.put(login({ id: saved.id, password: "a-new-password" }));
  assert.equal(h.store.field(saved.id, "password"), "a-new-password");
  assert.equal(h.store.list().length, 1, "an update does not add an item");
});

test("changing a card keeps its number unless a new one is given", () => {
  const h = open();
  const saved = h.store.put(card());
  const moved = h.store.put({ ...card({ id: saved.id, expMonth: 11 }), number: undefined, securityCode: undefined });
  assert.equal(moved.kind === "card" && moved.expMonth, 11);
  assert.equal(moved.kind === "card" && moved.last4, "4242");
  assert.equal(h.store.field(saved.id, "number"), VISA);
  assert.equal(h.store.field(saved.id, "securityCode"), "123", "an omitted code is kept too");
  const fresh = h.store.put(card({ id: saved.id, number: "5555555555554444" }));
  assert.equal(fresh.kind === "card" && fresh.brand, "mastercard");
  assert.equal(fresh.kind === "card" && fresh.last4, "4444");
});

test("an item cannot change kind, and an unknown id is not found", () => {
  const h = open();
  const saved = h.store.put(login());
  refuses(() => h.store.put(contact({ id: saved.id })), "invalid", /kind cannot be changed/);
  refuses(() => h.store.put(login({ id: "ghost" })), "not_found", /not in the Vault/);
});

test("a refused change leaves the Vault as it was", async () => {
  const h = open();
  const saved = h.store.put(login());
  await h.storage.flush();
  const before = readFileSync(join(h.dir, FILE), "utf8");
  refuses(() => h.store.put(login({ id: saved.id, sites: [] })), "invalid", /at least one site/);
  refuses(() => h.store.put({ kind: "card", title: "x" }), "invalid", /./);
  await h.storage.flush();
  assert.equal(readFileSync(join(h.dir, FILE), "utf8"), before);
  assert.equal(h.store.list().length, 1);
});

test("the Vault holds a limited number of items", () => {
  const h = open();
  for (let i = 0; i < VAULT_LIMITS.items; i += 1) h.store.put(contact({ title: `c${i}` }));
  refuses(() => h.store.put(contact({ title: "one too many" })), "limit", /Vault is full/);
  const first = h.store.list()[0];
  assert.ok(first);
  h.store.remove(first.id);
  assert.doesNotThrow(() => h.store.put(contact({ title: "now there is room" })));
});

test("only one contact is the default shipping address", () => {
  const h = open();
  const a = h.store.put(contact({ title: "A", defaultShipping: true }));
  const b = h.store.put(contact({ title: "B", defaultShipping: true }));
  const flags = Object.fromEntries(h.store.list().map((item) => [item.title, item.kind === "contact" && item.defaultShipping]));
  assert.deepEqual(flags, { A: false, B: true });
  h.store.put(contact({ id: a.id, title: "A", defaultShipping: false }));
  assert.equal(h.store.get(b.id)?.kind === "contact" && (h.store.get(b.id) as { defaultShipping: boolean }).defaultShipping, true, "saving a non-default leaves the default alone");
});

test("removing an item removes its secrets and every permission to use it", async () => {
  const h = open();
  const a = h.store.put(login());
  const b = h.store.put(login({ title: "Other", sites: ["example.com"], password: "a-different-secret" }));
  h.store.grant("bot-1", a.id, "github.com");
  h.store.grant("bot-1", b.id, "example.com");
  h.store.remove(a.id);
  assert.equal(h.store.get(a.id), null);
  assert.equal(h.store.field(a.id, "password"), null);
  assert.equal(h.store.hasGrant("bot-1", a.id, "github.com"), false);
  assert.equal(h.store.hasGrant("bot-1", b.id, "example.com"), true);
  await h.storage.flush();
  assert.equal(readFileSync(join(h.dir, FILE), "utf8").includes(Buffer.from("hunter2hunter2").toString("base64")), false);
  refuses(() => h.store.remove(a.id), "not_found", /not in the Vault/);
});

test("a site can be added to a login, once, within the limit; other kinds have none", () => {
  const h = open();
  const saved = h.store.put(login());
  const c = h.store.put(contact());
  assert.equal(h.store.addSite(saved.id, "https://accounts.github.com/x"), true);
  assert.equal(h.store.addSite(saved.id, "accounts.github.com"), true, "already there is fine");
  const view = h.store.get(saved.id);
  assert.deepEqual(view?.kind === "login" && view.sites, ["github.com", "accounts.github.com"]);
  assert.equal(h.store.addSite(saved.id, "co.uk"), false);
  assert.equal(h.store.addSite(saved.id, "javascript:1"), false);
  assert.equal(h.store.addSite("ghost", "example.com"), false);
  assert.equal(h.store.addSite(c.id, "example.com"), false);
  for (let i = 0; i < VAULT_LIMITS.sites; i += 1) h.store.addSite(saved.id, `s${i}.example.com`);
  const full = h.store.get(saved.id);
  assert.equal(full?.kind === "login" && full.sites.length, VAULT_LIMITS.sites);
  assert.equal(h.store.addSite(saved.id, "one-more.example.com"), false);
});

test("a field is only read for an item that has it, and an unreadable secret is null", async () => {
  const h = open();
  const saved = h.store.put(login());
  assert.equal(h.store.field("ghost", "username"), null);
  assert.equal(h.store.field(saved.id, "number"), null);
  await h.storage.flush();
  const raw = JSON.parse(readFileSync(join(h.dir, FILE), "utf8")) as { items: Array<{ secrets: { password: string } }> };
  assert.ok(raw.items[0]);
  raw.items[0].secrets.password = "garbled";
  writeFileSync(join(h.dir, FILE), JSON.stringify(raw));
  const broken = open({ dir: h.dir });
  assert.equal(broken.store.field(saved.id, "password"), null);
  assert.deepEqual(broken.store.secretValues(), []);
});

test("a decrypt that throws is an unreadable secret, not a crash", () => {
  const throwing: SecretCipher = { encrypt: rot.encrypt, decrypt: () => { throw new Error("keychain locked"); } };
  const h = open({ cipher: throwing });
  const saved = h.store.put(login());
  assert.equal(h.store.field(saved.id, "password"), null);
  assert.deepEqual(h.store.secretValues(), []);
});

test("every saved secret can be listed, in each form it could appear, and the list follows changes", () => {
  const h = open();
  assert.deepEqual(h.store.secretValues(), []);
  const l = h.store.put(login());
  const c = h.store.put(card());
  const values = h.store.secretValues();
  for (const secret of ["hunter2hunter2", VISA, "4242 4242 4242 4242", "4242-4242-4242-4242", "123"]) assert.ok(values.includes(secret), secret);
  h.store.put(login({ id: l.id, password: "brand-new-password" }));
  assert.ok(h.store.secretValues().includes("brand-new-password"));
  assert.equal(h.store.secretValues().includes("hunter2hunter2"), false, "an old password is no longer a secret to hide");
  h.store.remove(c.id);
  assert.equal(h.store.secretValues().includes(VISA), false);
});

test("a Bot's permission is per Bot, item and site, and does not repeat", async () => {
  const h = open();
  const saved = h.store.put(login());
  assert.equal(h.store.hasGrant("bot-1", saved.id, "github.com"), false);
  h.store.grant("bot-1", saved.id, "github.com");
  h.store.grant("bot-1", saved.id, "github.com");
  assert.equal(h.store.hasGrant("bot-1", saved.id, "github.com"), true);
  assert.equal(h.store.hasGrant("bot-2", saved.id, "github.com"), false);
  assert.equal(h.store.hasGrant("bot-1", saved.id, "gist.github.com"), false);
  refuses(() => h.store.grant("bot-1", "ghost", "github.com"), "not_found", /not in the Vault/);
  refuses(() => h.store.grant("", saved.id, "github.com"), "not_found", /not in the Vault/);
  await h.storage.flush();
  const file = JSON.parse(readFileSync(join(h.dir, FILE), "utf8")) as { grants: unknown[] };
  assert.equal(file.grants.length, 1, "granting twice saves one permission");
});

test("permissions are capped, and a deleted Bot keeps none", () => {
  const h = open();
  const saved = h.store.put(login());
  for (let i = 0; i < VAULT_LIMITS.grants; i += 1) h.store.grant(`bot-${i % 50}`, saved.id, `h${i}.example.com`);
  refuses(() => h.store.grant("bot-x", saved.id, "x.example.com"), "limit", /Too many/);
  h.store.revokeBot("bot-0");
  assert.equal(h.store.hasGrant("bot-0", saved.id, "h0.example.com"), false);
  assert.equal(h.store.hasGrant("bot-1", saved.id, "h1.example.com"), true);
  assert.doesNotThrow(() => h.store.grant("bot-x", saved.id, "x.example.com"));
  assert.doesNotThrow(() => h.store.revokeBot("nobody"));
});

test("permissions can be listed oldest first, and one taken back leaves the rest", async () => {
  const h = open();
  const a = h.store.put(login());
  const b = h.store.put(login({ title: "GitLab", sites: ["gitlab.com"] }));
  h.store.grant("bot-1", a.id, "github.com");
  h.store.grant("bot-2", b.id, "gitlab.com");
  h.store.grant("bot-1", b.id, "gitlab.com");
  const listed = h.store.grants();
  assert.deepEqual(listed.map((g) => `${g.botId}/${g.itemId}/${g.host}`), [`bot-1/${a.id}/github.com`, `bot-2/${b.id}/gitlab.com`, `bot-1/${b.id}/gitlab.com`]);
  listed[0]!.host = "evil.example";
  assert.equal(h.store.hasGrant("bot-1", a.id, "github.com"), true, "the list is a copy");
  h.store.revoke("bot-2", b.id, "gitlab.com");
  assert.equal(h.store.hasGrant("bot-2", b.id, "gitlab.com"), false);
  assert.equal(h.store.hasGrant("bot-1", b.id, "gitlab.com"), true);
  assert.equal(h.store.hasGrant("bot-1", a.id, "github.com"), true);
  await h.storage.flush();
  const reopened = open({ dir: h.dir }).store;
  assert.equal(reopened.grants().length, 2);
  refuses(() => h.store.revoke("bot-2", b.id, "gitlab.com"), "not_found", /already gone/);
  refuses(() => h.store.revoke("bot-1", b.id, "other.example"), "not_found", /already gone/);
});

test("taking back one permission leaves the same Bot's other sites and items", () => {
  const h = open();
  const a = h.store.put(login());
  const b = h.store.put(login({ title: "Other" }));
  h.store.grant("bot-1", a.id, "github.com");
  h.store.grant("bot-1", a.id, "gist.github.com");
  h.store.grant("bot-1", b.id, "github.com");
  h.store.revoke("bot-1", a.id, "github.com");
  assert.deepEqual(
    h.store.grants().map((g) => `${g.itemId}/${g.host}`).sort(),
    [`${a.id}/gist.github.com`, `${b.id}/github.com`].sort(),
  );
});

test("the snapshot is the items, the permissions and how they are protected, with no secrets", () => {
  const h = open();
  const saved = h.store.put(login());
  h.store.put(card());
  h.store.grant("bot-1", saved.id, "github.com");
  const snapshot = h.store.snapshot();
  assert.deepEqual(snapshot.items, h.store.list());
  assert.equal(snapshot.items.length, 2);
  assert.equal(snapshot.grants.length, 1);
  assert.equal(snapshot.protection, "encrypted");
  const plain: SecretCipher = { encrypt: (v) => `plain:${v}`, decrypt: (v) => (v.startsWith("plain:") ? v.slice(6) : null) };
  assert.equal(open({ cipher: plain }).store.snapshot().protection, "file-permissions");
  assert.equal(JSON.stringify(snapshot).includes("hunter2"), false);
  assert.equal(JSON.stringify(snapshot).includes(VISA), false);
});

test("listeners hear about changes, and stop when they unsubscribe", () => {
  const h = open();
  let heard = 0;
  const stop = h.store.onChange(() => (heard += 1));
  const saved = h.store.put(login());
  h.store.addSite(saved.id, "example.com");
  h.store.grant("b", saved.id, "github.com");
  h.store.revokeBot("b");
  h.store.grant("b", saved.id, "github.com");
  h.store.revoke("b", saved.id, "github.com");
  h.store.remove(saved.id);
  assert.equal(heard, 7);
  stop();
  h.store.put(login());
  assert.equal(heard, 7);
  assert.throws(() => h.store.put({}), BotError);
  assert.equal(heard, 7, "a refusal is not a change");
});

test("protection says whether the cipher is real", () => {
  assert.equal(open().store.protection(), "encrypted");
  const plain: SecretCipher = { encrypt: (v) => `plain:${v}`, decrypt: (s) => (s.startsWith("plain:") ? s.slice(6) : null) };
  assert.equal(open({ cipher: plain }).store.protection(), "file-permissions");
  const broken: SecretCipher = { encrypt: () => { throw new Error("no keychain"); }, decrypt: () => null };
  assert.equal(open({ cipher: broken }).store.protection(), "file-permissions");
});

test("damaged entries on disk are skipped, the rest kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-vault-"));
  dirs.push(dir);
  const good = open({ dir });
  good.store.put(login());
  await good.storage.flush();
  const raw = JSON.parse(readFileSync(join(dir, FILE), "utf8")) as { items: unknown[]; grants: unknown[] };
  raw.items.push({ id: "bad" }, null, 7);
  raw.grants.push({ botId: 1 });
  writeFileSync(join(dir, FILE), JSON.stringify(raw));
  const again = open({ dir });
  assert.equal(again.store.list().length, 1);
  writeFileSync(join(dir, FILE), JSON.stringify({ items: "no", grants: 3 }));
  assert.equal(open({ dir }).store.list().length, 0);
  writeFileSync(join(dir, FILE), "not json");
  assert.equal(open({ dir }).store.list().length, 0);
});
