import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FileStorage, VaultStore, type SecretCipher } from "@deyin/host-core";
import { createVaultHandlers } from "../src/main/bots/vault-handlers.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const rot: SecretCipher = {
  encrypt: (plain) => `enc:${Buffer.from(plain).toString("base64")}`,
  decrypt: (stored) => (stored.startsWith("enc:") ? Buffer.from(stored.slice(4), "base64").toString() : null),
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "deyin-vaulth-"));
  dirs.push(dir);
  const storage = new FileStorage(dir, rot);
  storages.push(storage);
  const store = new VaultStore(storage);
  return { store, handlers: createVaultHandlers(store) };
}

const login = { kind: "login", title: "GitHub", username: "ada", password: "hunter2hunter2", sites: ["github.com"] };

test("an empty Vault is an empty snapshot that says how it is protected", () => {
  const { handlers } = setup();
  assert.deepEqual(handlers.get(), { items: [], grants: [], protection: "encrypted" });
});

test("saving returns the item without its password, and the snapshot shows it", () => {
  const { handlers } = setup();
  const saved = handlers.save(login);
  assert.equal(saved.ok, true);
  assert.equal(JSON.stringify(saved).includes("hunter2"), false);
  const snapshot = handlers.get();
  assert.equal(snapshot.items.length, 1);
  assert.equal(JSON.stringify(snapshot).includes("hunter2"), false);
});

test("a refused save is text for the person, not an exception", () => {
  const { handlers, store } = setup();
  const refused = handlers.save({ kind: "login", title: "" });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.code, "invalid");
  assert.deepEqual(store.list(), []);
  assert.equal(handlers.save("nonsense").ok, false);
  assert.equal(handlers.save(null).ok, false);
});

test("saving with an id changes that item and keeps the password that was not sent again", () => {
  const { handlers, store } = setup();
  const first = handlers.save(login);
  assert.ok(first.ok);
  const changed = handlers.save({ id: first.value.id, kind: "login", title: "GitHub work", username: "ada", sites: ["github.com"] });
  assert.ok(changed.ok);
  assert.equal(changed.value.title, "GitHub work");
  assert.equal(store.field(first.value.id, "password"), "hunter2hunter2");
});

test("removing an item takes its permissions with it", () => {
  const { handlers, store } = setup();
  const saved = handlers.save(login);
  assert.ok(saved.ok);
  store.grant("bot-1", saved.value.id, "github.com");
  assert.deepEqual(handlers.remove(saved.value.id), { ok: true, value: null });
  assert.deepEqual(handlers.get(), { items: [], grants: [], protection: "encrypted" });
  const again = handlers.remove(saved.value.id);
  assert.equal(again.ok === false && again.code, "not_found");
});

test("one permission can be taken back, and a second try says it is already gone", () => {
  const { handlers, store } = setup();
  const saved = handlers.save(login);
  assert.ok(saved.ok);
  store.grant("bot-1", saved.value.id, "github.com");
  assert.deepEqual(handlers.get().grants.map((grant) => `${grant.botId}/${grant.itemId}/${grant.host}`), [`bot-1/${saved.value.id}/github.com`]);
  assert.deepEqual(handlers.revoke("bot-1", saved.value.id, "github.com"), { ok: true, value: null });
  assert.deepEqual(handlers.get().grants, []);
  assert.equal(store.hasGrant("bot-1", saved.value.id, "github.com"), false);
  const again = handlers.revoke("bot-1", saved.value.id, "github.com");
  assert.equal(again.ok === false && again.code, "not_found");
});

test("arguments that are not text are refused before the store sees them", () => {
  const { handlers, store } = setup();
  const saved = handlers.save(login);
  assert.ok(saved.ok);
  store.grant("bot-1", saved.value.id, "github.com");
  for (const bad of [undefined, null, 5, {}, [], ""]) {
    const refusal = (result: { ok: boolean; error?: string }, what: RegExp) => {
      assert.equal(result.ok, false, JSON.stringify(bad));
      assert.match(result.error ?? "", what, JSON.stringify(bad));
    };
    refusal(handlers.remove(bad), /The item is required/);
    refusal(handlers.revoke(bad, saved.value.id, "github.com"), /The Bot is required/);
    refusal(handlers.revoke("bot-1", bad, "github.com"), /The item is required/);
    refusal(handlers.revoke("bot-1", saved.value.id, bad), /The site is required/);
  }
  assert.equal(store.list().length, 1);
  assert.equal(store.hasGrant("bot-1", saved.value.id, "github.com"), true);
});
