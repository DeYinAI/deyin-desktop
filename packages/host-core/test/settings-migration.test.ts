import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, migrateSettings } from "../src/defaults.js";
import { FileStorage } from "../src/storage.js";
import { AgentsStore, SettingsStore } from "../src/stores.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deyin-migrate-"));
}

test("migrateSettings fills new keys with defaults and stamps the schema version", () => {
  const migrated = migrateSettings({ theme: "light", language: "zh" });
  assert.equal(migrated.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.equal(migrated.theme, "light");
  assert.equal(migrated.language, "zh");
  assert.equal(migrated.agentMode, "agent");
  assert.equal(migrated.terminalScrollback, DEFAULT_SETTINGS.terminalScrollback);
  assert.equal(migrated.revealTerminalOnAgentCommand, true);
  assert.deepEqual(migrated.onboard, { workspaceOpened: false, terminalUsed: false, taskRun: false });
});

test("migrateSettings clamps out-of-range values and repairs invalid enums", () => {
  const migrated = migrateSettings({
    fontSize: 99,
    codeFontSize: 1,
    terminalFontSize: 400,
    terminalScrollback: -5,
    theme: "hotdog" as never,
    agentMode: "yolo" as never,
    approvalMode: "sudo" as never,
  });
  assert.equal(migrated.fontSize, 18);
  assert.equal(migrated.codeFontSize, 10);
  assert.equal(migrated.terminalFontSize, 20);
  assert.equal(migrated.terminalScrollback, 200);
  assert.equal(migrated.theme, "dark");
  assert.equal(migrated.agentMode, "agent");
  assert.equal(migrated.approvalMode, "full-access");
});

test("SettingsStore persists the migrated shape for v1 files", () => {
  const dir = tempDir();
  try {
    const storage = new FileStorage(dir);
    // Simulate a v1 settings.json (no schemaVersion, no new keys).
    storage.writeJson("settings.json", { theme: "dark", language: "de", fontSize: 14 });
    const store = new SettingsStore(storage);
    assert.equal(store.get().schemaVersion, SETTINGS_SCHEMA_VERSION);
    assert.equal(store.get().language, "de");
    // The upgrade was written back to disk.
    const onDisk = storage.readJson<{ schemaVersion?: number; defaultShell?: string | null }>("settings.json", {});
    assert.equal(onDisk.schemaVersion, SETTINGS_SCHEMA_VERSION);
    assert.equal(onDisk.defaultShell, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AgentsStore migrates legacy caps arrays into the disabled set", () => {
  const dir = tempDir();
  try {
    const storage = new FileStorage(dir);
    storage.writeJson("agents.json", {
      caps: [
        { id: "review-code", kind: "skill", name: "review-code", description: "", enabled: true },
        { id: "test-runner", kind: "subagent", name: "Test Runner", description: "", enabled: false },
      ],
      providers: [],
    });
    const agents = new AgentsStore(storage);
    assert.ok(agents.disabledCaps().has("test-runner"));
    assert.ok(!agents.disabledCaps().has("review-code"));
    // The legacy array is gone from disk after migration.
    const onDisk = storage.readJson<{ caps?: unknown; disabledCaps?: string[] }>("agents.json", {});
    assert.equal(onDisk.caps, undefined);
    assert.deepEqual(onDisk.disabledCaps, ["test-runner"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AgentsStore toggles persist and plugin secrets round-trip ciphered", () => {
  const dir = tempDir();
  try {
    const storage = new FileStorage(dir);
    const agents = new AgentsStore(storage);
    agents.setCapEnabled("skill:review-code", false);
    assert.ok(new AgentsStore(storage).disabledCaps().has("skill:review-code"));
    agents.setCapEnabled("skill:review-code", true);
    assert.ok(!new AgentsStore(storage).disabledCaps().has("skill:review-code"));

    agents.setPluginSecret("my-plugin", "API_KEY", "secret-value");
    assert.deepEqual(new AgentsStore(storage).getPluginSecrets("my-plugin"), { API_KEY: "secret-value" });
    agents.removePluginSecrets("my-plugin");
    assert.deepEqual(new AgentsStore(storage).getPluginSecrets("my-plugin"), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
