import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileStorage, plainCipher } from "../src/storage.js";
import { AgentsStore, SettingsStore } from "../src/stores.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deyin-test-"));
}

test("FileStorage round-trips JSON and merges the fallback", () => {
  const dir = tempDir();
  try {
    const storage = new FileStorage(join(dir, "data"));
    assert.deepEqual(storage.readJson("missing.json", { a: 1 }), { a: 1 });
    storage.writeJson("settings.json", { a: 2 });
    assert.deepEqual(storage.readJson("settings.json", { a: 1, b: "x" }), { a: 2, b: "x" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileStorage writes files 0600 on POSIX", { skip: process.platform === "win32" }, () => {
  const dir = tempDir();
  try {
    const storage = new FileStorage(join(dir, "data"));
    storage.writeJson("secret.json", { key: "value" });
    const mode = statSync(join(dir, "data", "secret.json")).mode & 0o777;
    assert.equal(mode, 0o600);
    const dirMode = statSync(join(dir, "data")).mode & 0o777;
    assert.equal(dirMode, 0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plainCipher round-trips and rejects foreign ciphertext", () => {
  assert.equal(plainCipher.decrypt(plainCipher.encrypt("s3cret")), "s3cret");
  assert.equal(plainCipher.decrypt("bm90LXBsYWlu"), null);
});

test("stores persist through Storage and keep provider keys ciphered", () => {
  const dir = tempDir();
  try {
    const storage = new FileStorage(dir);
    const settings = new SettingsStore(storage);
    settings.set({ fontSize: 19 });
    assert.equal(new SettingsStore(storage).get().fontSize, 19);

    const agents = new AgentsStore(storage);
    agents.setKey("openference", "sk-test-123");
    assert.equal(agents.getKey("openference"), "sk-test-123");
    // The persisted file must not contain the raw key without the plain: marker semantics.
    const persisted = storage.readJson<{ providers: { id: string; keyCipher?: string }[] }>("agents.json", { providers: [] });
    const record = persisted.providers.find((p) => p.id === "openference");
    assert.equal(record?.keyCipher, "plain:sk-test-123");
    // A fresh store (fresh read from disk) still decrypts.
    assert.equal(new AgentsStore(storage).getKey("openference"), "sk-test-123");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
