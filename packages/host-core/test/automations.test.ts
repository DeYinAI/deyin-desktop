import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationsStore, AutomationRunsStore, SshHostsStore } from "../src/automations.js";
import { FileStorage, plainCipher } from "../src/storage.js";

test("AutomationsStore CRUD and toggle", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-auto-"));
  const storage = new FileStorage(dir, plainCipher);
  const store = new AutomationsStore(storage);

  const created = store.create({
    name: "Nightly",
    enabled: true,
    payload: { kind: "prompt", prompt: "Summarize changes" },
    trigger: { kind: "cron", expression: "0 9 * * *" },
    target: { kind: "local", workspacePath: "/tmp/proj" },
    model: "GLM-5.2",
    providerId: "openference",
  });
  assert.equal(store.list().length, 1);
  store.setEnabled(created.id, false);
  assert.equal(store.get(created.id)?.enabled, false);
  store.remove(created.id);
  assert.equal(store.list().length, 0);
});

test("AutomationRunsStore keeps a bounded history", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-runs-"));
  const storage = new FileStorage(dir, plainCipher);
  const runs = new AutomationRunsStore(storage);
  const run = runs.create("auto-1");
  assert.equal(run.status, "queued");
  runs.setStatus(run.id, "running");
  runs.appendEvent(run.id, { type: "text-delta", delta: "hi" });
  runs.finish(run.id, "completed", { finalText: "hi" });
  const listed = runs.list("auto-1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.status, "completed");
  assert.equal(listed[0]?.events.length, 1);
});

test("AutomationRunsStore abortStale clears leftover running/queued", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-stale-"));
  const storage = new FileStorage(dir, plainCipher);
  const runs = new AutomationRunsStore(storage);
  const a = runs.create("auto-1");
  runs.setStatus(a.id, "running");
  const b = runs.create("auto-2");
  assert.equal(b.status, "queued");
  const n = runs.abortStale("app-restarted");
  assert.equal(n, 2);
  assert.equal(runs.get(a.id)?.status, "aborted");
  assert.equal(runs.get(b.id)?.status, "aborted");
});

test("AutomationRunsStore mirror records a run from elsewhere once, in order, and updates it when it ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-mirror-"));
  const storage = new FileStorage(dir, plainCipher);
  const runs = new AutomationRunsStore(storage);
  const local = runs.create("auto-1");
  runs.finish(local.id, "completed", { finalText: "here" });
  const elsewhere = { id: "engine-run_1", automationId: "auto-1", status: "running" as const, startedAt: 1_000, events: [] };

  assert.equal(runs.mirror(elsewhere), true);
  assert.equal(runs.mirror(elsewhere), false, "the same record again changes nothing");
  assert.deepEqual(runs.list("auto-1").map((r) => r.id), [local.id, "engine-run_1"], "an older run sorts after a newer local one");
  assert.equal(runs.lastForAutomation("auto-1")?.id, local.id);

  assert.equal(runs.mirror({ ...elsewhere, status: "completed", finishedAt: 2_000, finalText: "there" }), true);
  assert.equal(runs.list("auto-1").length, 2, "updated in place, not repeated");
  assert.equal(runs.get("engine-run_1")?.finalText, "there");

  await storage.flush();
  const reopened = new AutomationRunsStore(storage);
  assert.equal(reopened.get("engine-run_1")?.status, "completed", "it is saved");
});

test("AutomationRunsStore mirror keeps only the newest runs of an automation, like any other run", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-mirror-trim-"));
  const runs = new AutomationRunsStore(new FileStorage(dir, plainCipher));
  for (let i = 0; i < 25; i += 1) {
    runs.mirror({ id: `engine-${i}`, automationId: "auto-1", status: "completed", startedAt: 1_000 + i, events: [] });
  }
  const kept = runs.list("auto-1");
  assert.equal(kept.length, 20);
  assert.equal(kept[0]?.id, "engine-24");
  assert.equal(kept.at(-1)?.id, "engine-5");
  assert.equal(runs.get("engine-0"), undefined);
});

test("SshHostsStore encrypts credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-ssh-"));
  const storage = new FileStorage(dir, plainCipher);
  const hosts = new SshHostsStore(storage);
  const info = hosts.add({
    label: "Prod",
    host: "example.com",
    username: "deploy",
    authMethod: "privateKey",
  });
  hosts.setCredentials(info.id, { privateKey: "-----BEGIN PRIVATE KEY-----\nabc" });
  const resolved = hosts.resolveCredentials(info.id);
  assert.ok(resolved?.privateKey?.includes("BEGIN PRIVATE KEY"));
  const listed = hosts.list();
  assert.equal(listed[0]?.hasKey, true);
});

test("AutomationsStore migrates a legacy bare prompt to a payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-auto-legacy-"));
  const storage = new FileStorage(dir, plainCipher);
  // A file written before the payload union existed.
  storage.writeJson("automations.json", {
    automations: [
      {
        id: "legacy-1",
        name: "Old",
        enabled: true,
        prompt: "Do the old thing",
        trigger: { kind: "manual" },
        target: { kind: "local", workspacePath: "/tmp/proj" },
        model: "GLM-5.2",
        providerId: "openference",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
  await storage.flush();

  const migrated = new AutomationsStore(storage).get("legacy-1");
  assert.deepEqual(migrated?.payload, { kind: "prompt", prompt: "Do the old thing" });
  assert.equal("prompt" in (migrated as unknown as Record<string, unknown>), false);
});

test("AutomationsStore supports skill and subagent payloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-auto-caps-"));
  const store = new AutomationsStore(new FileStorage(dir, plainCipher));
  const base = {
    enabled: true,
    trigger: { kind: "manual" },
    target: { kind: "local", workspacePath: "/tmp/proj" },
    model: "GLM-5.2",
    providerId: "openference",
  } as const;

  const skill = store.create({ ...base, name: "Skill run", payload: { kind: "skill", skill: "threat-model" } });
  const sub = store.create({ ...base, name: "Sub run", payload: { kind: "subagent", subagent: "reviewer", input: "HEAD~1" } });

  assert.deepEqual(store.get(skill.id)?.payload, { kind: "skill", skill: "threat-model" });
  assert.deepEqual(store.get(sub.id)?.payload, { kind: "subagent", subagent: "reviewer", input: "HEAD~1" });
});
