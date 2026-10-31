import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { State } from "../src/core/state.js";
import { JsonStore } from "../src/store.js";
import { request, makeRig, trigger } from "./helpers.js";

const temp = () => mkdtempSync(join(tmpdir(), "superagent-store-"));

test("a fresh store loads defaults and writes nothing until something changes", () => {
  const dir = temp();
  try {
    const store = new JsonStore(dir);
    const { settings, state } = store.load();
    assert.equal(settings.enabled, false);
    assert.equal(state.tickets.size, 0);
    store.flush();
    assert.throws(() => readFileSync(join(dir, "state.json")), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state round-trips through disk and reloads with counters intact", () => {
  const dir = temp();
  try {
    const rig = makeRig();
    rig.engine.receive(request());
    rig.engine.evaluateDue();
    const store = new JsonStore(dir);
    store.load();
    const data = rig.state.toJSON();
    writeFileSync(join(dir, "state.json"), JSON.stringify(data));
    const reloaded = new JsonStore(dir).load().state;
    assert.equal(reloaded.triggers.size, 1);
    assert.equal(reloaded.nextId("e"), "e2", "counters continue");
    assert.equal(reloaded.threads.get("github:1")?.evaluating?.id, "e1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("autosave coalesces changes and flush writes immediately", async () => {
  const dir = temp();
  try {
    const store = new JsonStore(dir, { debounceMs: 20 });
    const { state } = store.load();
    store.autosave();
    state.ensureThread({ source: "github", id: "1" }, "2026-01-01T00:00:00.000Z");
    state.touch();
    state.touch();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const saved = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { threads: unknown[] };
    assert.equal(saved.threads.length, 1);
    state.ensureThread({ source: "github", id: "2" }, "2026-01-01T00:00:00.000Z");
    state.touch();
    store.flush();
    assert.equal((JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { threads: unknown[] }).threads.length, 2);
    store.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a torn state file falls back to the previous generation; both unreadable refuses to start", () => {
  const dir = temp();
  try {
    const store = new JsonStore(dir);
    const { state } = store.load();
    state.ensureThread({ source: "github", id: "1" }, "2026-01-01T00:00:00.000Z");
    state.touch();
    store.flush();
    state.ensureThread({ source: "github", id: "2" }, "2026-01-01T00:00:00.000Z");
    state.touch();
    store.flush();
    writeFileSync(join(dir, "state.json"), "{ torn");
    const warnings: string[] = [];
    const recovered = new JsonStore(dir, { logger: { warn: (message) => warnings.push(message) } }).load().state;
    assert.equal(recovered.threads.size, 1, "the .bak generation holds the first write");
    assert.match(warnings.join(), /recovered/);
    writeFileSync(join(dir, "state.json.bak"), "also torn");
    assert.throws(() => new JsonStore(dir).load(), /unreadable and was left untouched/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings saves are optimistic: a stale revision is refused", () => {
  const dir = temp();
  try {
    const store = new JsonStore(dir);
    store.load();
    const first = store.saveSettings({ enabled: true, github: { repository: "a/b" } }, 0);
    assert.equal(first.revision, 1);
    assert.equal(first.previous.enabled, false);
    assert.throws(() => store.saveSettings({ enabled: false }, 0), (error: unknown) => (error as { code?: string }).code === "conflict");
    assert.throws(() => store.saveSettings({ eval: { mode: "bogus" } }, 1), /eval.mode/);
    const reloaded = new JsonStore(dir);
    assert.equal(reloaded.load().settings.github.repository, "a/b");
    assert.equal(reloaded.settingsRevision, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prune drops old unreferenced triggers and settled receipts but keeps live ones", () => {
  const rig = makeRig();
  const old = request({ at: "2025-01-01T00:00:00.000Z", id: "old" });
  const fresh = request({ at: "2026-01-01T00:00:00.000Z", id: "fresh", number: 2 });
  rig.engine.receive(old);
  rig.engine.receive(fresh);
  rig.engine.evaluateDue();
  // `old` is waiting in an evaluation, so it is referenced and must be kept.
  assert.equal(rig.state.prune(new Date("2026-03-01T00:00:00.000Z")), 0);
  rig.engine.decide("old", { kind: "ignore", reason: "no" });
  assert.equal(rig.state.prune(new Date("2026-03-01T00:00:00.000Z")), 1);
  assert.equal(rig.state.triggers.has("old"), false);
  assert.equal(rig.state.triggers.has("fresh"), true);
  assert.ok(State.from(rig.state.toJSON()).triggers.has("fresh"));
});

test("the history is bounded: the oldest unreferenced messages go first, however recent", () => {
  const rig = makeRig();
  for (let n = 0; n < 5100; n++) rig.state.triggers.set(`t${n}`, { ...trigger({ id: `t${n}` }), at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() });
  assert.equal(rig.state.prune(new Date("2026-01-02T00:00:00.000Z")), 100);
  assert.equal(rig.state.triggers.size, 5000);
  assert.equal(rig.state.triggers.has("t0"), false);
  assert.equal(rig.state.triggers.has("t99"), false);
  assert.equal(rig.state.triggers.has("t100"), true);
  assert.equal(rig.state.triggers.has("t5099"), true);
});
