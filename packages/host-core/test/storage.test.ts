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
    settings.set({ fontSize: 17 });
    assert.equal(new SettingsStore(storage).get().fontSize, 17);

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

test("provider wire formats: responses/anthropic persist, authHeader round-trips, junk falls back", () => {
  const dir = tempDir();
  try {
    const storage = new FileStorage(dir);
    const agents = new AgentsStore(storage);
    agents.addProvider({ name: "Claude", baseUrl: "https://api.anthropic.com" });
    const claude = agents.listProviders(true).find((p) => p.name === "Claude");
    assert.ok(claude, "provider added");
    agents.updateProvider(claude!.id, { apiFormat: "anthropic", authHeader: true });
    const updated = agents.listProviders(true).find((p) => p.id === claude!.id);
    assert.equal(updated?.apiFormat, "anthropic");
    assert.equal(updated?.authHeader, true);

    // Unknown formats in persisted files are normalized to chat-completions.
    storage.writeJson("agents.json", {
      ...storage.readJson("agents.json", {}),
      providers: [
        { id: "legacy", name: "Legacy", kind: "custom", apiFormat: "weird-format", enabled: true, models: [], disabledModels: [] },
      ],
    });
    const normalized = new AgentsStore(storage).listProviders(true).find((p) => p.id === "legacy");
    assert.equal(normalized?.apiFormat, "chat-completions");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider base URLs must be http(s) — the API key is sent to that origin", () => {
  const dir = tempDir();
  try {
    const storage = new FileStorage(dir);
    const agents = new AgentsStore(storage);
    // Valid schemes are accepted.
    agents.addProvider({ name: "Local", baseUrl: "http://localhost:11434/v1" });
    assert.ok(agents.listProviders(true).some((p) => p.name === "Local"), "http:// accepted");
    // Missing / non-http schemes are rejected outright.
    agents.addProvider({ name: "Bad", baseUrl: "api.example.com/v1" });
    agents.addProvider({ name: "Bad2", baseUrl: "file:///etc/passwd" });
    agents.addProvider({ name: "Bad3", baseUrl: "ftp://example.com/v1" });
    const providers = agents.listProviders(true);
    assert.ok(!providers.some((p) => p.name === "Bad"), "scheme-less URL rejected");
    assert.ok(!providers.some((p) => p.name === "Bad2"), "file: URL rejected");
    assert.ok(!providers.some((p) => p.name === "Bad3"), "ftp: URL rejected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
