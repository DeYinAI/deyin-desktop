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
  // Subagent settings default.
  assert.deepEqual(migrated.subagentModels, {});
  assert.deepEqual(migrated.subagentEfforts, {});
  assert.deepEqual(migrated.modelEfforts, {});
  assert.equal(migrated.subagentMaxSteps, DEFAULT_SETTINGS.subagentMaxSteps);
  assert.equal(migrated.subagentConcurrency, DEFAULT_SETTINGS.subagentConcurrency);
  assert.equal(migrated.autoVisionRouting, false);
});

test("migrateSettings sanitizes subagent model/effort maps and clamps run limits", () => {
  const migrated = migrateSettings({
    subagentModels: { explorer: "openference::glm-5.2", reviewer: "", broken: 42, empty: "  " },
    subagentEfforts: { reviewer: "high", explorer: "turbo", broken: true },
    subagentMaxSteps: 9999,
    subagentConcurrency: 0,
  });
  assert.deepEqual(migrated.subagentModels, { explorer: "openference::glm-5.2" });
  assert.deepEqual(migrated.subagentEfforts, { reviewer: "high" });
  assert.equal(migrated.subagentMaxSteps, 200);
  assert.equal(migrated.subagentConcurrency, 1);
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

test("v11: dropped fields fall out and kept fields survive", () => {
  const v10 = {
    schemaVersion: 10,
    theme: "light",
    fontSize: 15,
    memoryEnabled: true,
    enableCoordinator: true,
    plannerModel: "openference::GLM-5.2",
    enableFleet: true,
    computerUseEnabled: true,
    automationsCatchUp: false,
    optimizationCompression: false,
    cacheHitRateTarget: 0.9,
    legacyOnboardComplete: true,
    bogusFutureField: "x",
  } as unknown as Record<string, unknown>;
  const migrated = migrateSettings(v10);
  assert.equal(migrated.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.equal(migrated.theme, "light");
  assert.equal(migrated.fontSize, 15);
  assert.equal(migrated.memoryEnabled, true);
  // Removed knobs are gone (not defaulted, gone).
  assert.equal("enableCoordinator" in migrated, false);
  assert.equal("plannerModel" in migrated, false);
  assert.equal("enableFleet" in migrated, false);
  assert.equal(migrated.computerUseEnabled, true);
  // Re-added in v14 (automations revival): a v10 file's value survives.
  assert.equal(migrated.automationsCatchUp, false);
  assert.equal("optimizationCompression" in migrated, false);
  assert.equal("cacheHitRateTarget" in migrated, false);
  assert.equal("legacyOnboardComplete" in migrated, false);
  assert.equal("bogusFutureField" in migrated, false);
});

test("roleModels: keeps known roles, drops unknown keys and blank refs", () => {
  const migrated = migrateSettings({
    roleModels: {
      plan: "openference::GLM-5.2",
      implement: "  anthropic::claude-opus-5  ",
      tool: "Kimi-K3",
      ask: "   ",
      coordinator: "openference::GLM-5.2",
      delivery: 42,
    },
  } as unknown as Record<string, unknown>);
  assert.deepEqual(migrated.roleModels, {
    plan: "openference::GLM-5.2",
    implement: "anthropic::claude-opus-5",
    tool: "Kimi-K3",
  });
});

test("roleModels: defaults to empty and survives garbage", () => {
  assert.deepEqual(migrateSettings({}).roleModels, {});
  assert.deepEqual(migrateSettings({ roleModels: ["plan"] }).roleModels, {});
  assert.deepEqual(migrateSettings({ roleModels: null }).roleModels, {});
});
