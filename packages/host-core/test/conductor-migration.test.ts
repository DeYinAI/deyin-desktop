import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConductorWorkflowsStore } from "../src/conductor-flow/store.js";
import { SETTINGS_SCHEMA_VERSION, migrateSettings, settingsFromStored } from "../src/defaults.js";
import {
  LEGACY_CONDUCTOR_TOOL_NAMES,
  legacyConductorToolName,
  migrateProjectsState,
} from "../src/legacy-conductor.js";
import { FileStorage } from "../src/storage.js";
import { ProjectsStore } from "../src/stores.js";
import type { ConductorWorkflowDefinition, ProjectsState, Thread } from "../src/types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deyin-conductor-migrate-"));
}

/** A saved state written before Conductor's internal ids moved off "bot". */
function legacyState(): ProjectsState {
  const botThread = {
    id: "t-conductor",
    title: "Ship the release",
    updatedAt: 10,
    mode: "bot",
    previousMode: "bot",
    events: [
      { kind: "user", text: "ship it" },
      { kind: "tool", name: "merge_bot_diff", summary: "merge bot branch bot/stage-a", result: "ok" },
      { kind: "tool", name: "bash", summary: "ls" },
    ],
  } as unknown as Thread;
  const agentThread: Thread = { id: "t-agent", title: "Fix bug", updatedAt: 5, mode: "agent", events: [] };
  const plainThread: Thread = { id: "t-plain", title: "No mode", updatedAt: 1, events: [] };
  return {
    projects: [{ id: "p1", name: "app", root: "/work/app", threads: [botThread, agentThread, plainThread] }],
    activeProjectId: "p1",
    activeThreadId: "t-conductor",
    workspaceRoot: "/work/app",
  };
}

test("migrateProjectsState moves legacy bot threads to conductor and leaves everything else intact", () => {
  const { state, changed } = migrateProjectsState(legacyState());
  assert.equal(changed, true);
  const [conductor, agent, plain] = state.projects[0]!.threads;
  assert.equal(conductor!.mode, "conductor");
  assert.equal(conductor!.previousMode, "conductor");
  assert.equal(conductor!.title, "Ship the release", "the thread itself is intact");
  assert.equal(conductor!.id, "t-conductor");
  assert.equal(agent!.mode, "agent");
  assert.equal(plain!.mode, undefined, "a thread with no mode stays modeless (the default is agent)");
  assert.equal(state.activeThreadId, "t-conductor");
  assert.equal(state.workspaceRoot, "/work/app");
});

test("migrateProjectsState renames legacy tool names in saved events so old history still renders", () => {
  const { state } = migrateProjectsState(legacyState());
  const events = state.projects[0]!.threads[0]!.events;
  const tools = events.filter((e) => e.kind === "tool").map((e) => (e.kind === "tool" ? e.name : ""));
  assert.deepEqual(tools, ["merge_conductor_diff", "bash"]);
  const merge = events[1]!;
  assert.equal(merge.kind === "tool" ? merge.result : null, "ok", "only the name changes");
});

test("migrateProjectsState is idempotent, does not mutate its input, and reports no change when clean", () => {
  const input = legacyState();
  const snapshot = JSON.stringify(input);
  const once = migrateProjectsState(input);
  assert.equal(JSON.stringify(input), snapshot, "input untouched");
  const twice = migrateProjectsState(once.state);
  assert.equal(twice.changed, false);
  assert.equal(twice.state, once.state, "a clean state is returned as is, not copied");
});

test("migrateProjectsState tolerates malformed state", () => {
  const empty = migrateProjectsState({ projects: [], activeProjectId: null, activeThreadId: null, workspaceRoot: null });
  assert.equal(empty.changed, false);
  const broken = migrateProjectsState({ projects: [{ id: "p", threads: undefined }] } as unknown as ProjectsState);
  assert.equal(broken.changed, false);
});

test("legacy tool names map one-to-one and unknown names pass through", () => {
  assert.equal(legacyConductorToolName("bot_workflow_run"), "conductor_workflow_run");
  assert.equal(legacyConductorToolName("bot_workflow_validate"), "conductor_workflow_validate");
  assert.equal(legacyConductorToolName("inspect_bot_run"), "inspect_conductor_run");
  assert.equal(legacyConductorToolName("merge_bot_diff"), "merge_conductor_diff");
  assert.equal(legacyConductorToolName("list_external_bots"), "list_external_bots", "these keep their names");
  assert.equal(legacyConductorToolName("delegate_external_bot"), "delegate_external_bot");
  assert.equal(new Set(Object.values(LEGACY_CONDUCTOR_TOOL_NAMES)).size, Object.keys(LEGACY_CONDUCTOR_TOOL_NAMES).length);
});

test("ProjectsStore migrates a legacy projects.json on load and persists it once", async () => {
  const dir = tempDir();
  try {
    const storage = new FileStorage(dir);
    storage.writeJson("projects.json", legacyState());
    await storage.flush();

    const reopened = new FileStorage(dir);
    const store = new ProjectsStore(reopened);
    assert.equal(store.get().projects[0]!.threads[0]!.mode, "conductor");

    await reopened.flush();
    const onDisk = JSON.parse(readFileSync(join(dir, "projects.json"), "utf8")) as ProjectsState;
    assert.equal(onDisk.projects[0]!.threads[0]!.mode, "conductor", "the migrated state was written back");
    assert.equal(onDisk.projects[0]!.threads[1]!.mode, "agent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings v23 moves botRolePreferences to conductorRolePreferences", () => {
  assert.ok(SETTINGS_SCHEMA_VERSION >= 23);
  const migrated = migrateSettings({ schemaVersion: 22, botRolePreferences: { plan: "claude", review: "codex", bogus: "x" } });
  assert.deepEqual(migrated.conductorRolePreferences, { plan: "claude", review: "codex" });
  assert.equal("botRolePreferences" in migrated, false, "the old key is gone");
});

test("settings: an already-set conductorRolePreferences wins over the legacy key", () => {
  const migrated = migrateSettings({
    schemaVersion: 22,
    botRolePreferences: { plan: "claude" },
    conductorRolePreferences: { plan: "zcode" },
  });
  assert.deepEqual(migrated.conductorRolePreferences, { plan: "zcode" });
});

test("settings: a legacy blob stored by the web client is migrated and flagged for write-back", () => {
  const stored = JSON.stringify({ schemaVersion: 22, botRolePreferences: { code: "opencode" } });
  const { settings, needsWrite } = settingsFromStored(stored);
  assert.equal(needsWrite, true);
  assert.deepEqual(settings.conductorRolePreferences, { code: "opencode" });
});

function workflow(id: string): ConductorWorkflowDefinition {
  return { id, name: id, description: "", stages: [], createdAt: 1, updatedAt: 1 } as unknown as ConductorWorkflowDefinition;
}

test("ConductorWorkflowsStore adopts pipelines saved in the legacy bot-workflows.json", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "bot-workflows.json"), JSON.stringify({ workflows: [workflow("legacy-1")] }));
    const store = new ConductorWorkflowsStore(new FileStorage(dir));
    assert.deepEqual(store.list().map((w) => w.id), ["legacy-1"]);

    const saved = new FileStorage(dir);
    const next = new ConductorWorkflowsStore(saved);
    next.save(workflow("new-1"));
    await saved.flush();
    const written = JSON.parse(readFileSync(join(dir, "conductor-workflows.json"), "utf8")) as { workflows: Array<{ id: string }> };
    assert.deepEqual(written.workflows.map((w) => w.id).sort(), ["legacy-1", "new-1"], "legacy pipelines are carried into the new file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConductorWorkflowsStore prefers conductor-workflows.json once it exists", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "bot-workflows.json"), JSON.stringify({ workflows: [workflow("stale")] }));
    writeFileSync(join(dir, "conductor-workflows.json"), JSON.stringify({ workflows: [workflow("current")] }));
    const store = new ConductorWorkflowsStore(new FileStorage(dir));
    assert.deepEqual(store.list().map((w) => w.id), ["current"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
