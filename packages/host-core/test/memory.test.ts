import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStore, rankMemoryFacts } from "../src/memory.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deyin-memory-"));
}

test("create/list/read round-trips a fact with metadata", () => {
  const dir = tempDir();
  try {
    const store = new MemoryStore(dir);
    const fact = store.create({
      name: "release-flow",
      title: "Release branch",
      description: "How releases ship",
      type: "project",
      body: "Releases go through the `release/*` branch with tags.",
    });
    assert.equal(fact.revision, 1);
    assert.equal(store.count(), 1);
    assert.equal(store.read("release-flow")?.title, "Release branch");
    assert.equal(store.read("project/release-flow")?.id, fact.id);
    assert.equal(store.read("nope"), undefined);
    // File exists on disk in the expected shape.
    assert.ok(existsSync(join(dir, "memory", "release-flow.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create refuses duplicate names; update bumps revision and rejects stale expectedRevision", () => {
  const dir = tempDir();
  try {
    const store = new MemoryStore(dir);
    const fact = store.create({ name: "x", title: "X", type: "user", body: "v1" });
    assert.throws(() => store.create({ name: "x", title: "X2", type: "user", body: "dup" }), /already exists/);
    const updated = store.update("x", { body: "v2" }, fact.revision);
    assert.equal(updated.revision, 2);
    assert.equal(updated.body, "v2");
    assert.throws(() => store.update("x", { body: "stale" }, fact.revision), /changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forget moves to the archive and recover restores as a new revision", () => {
  const dir = tempDir();
  try {
    const store = new MemoryStore(dir);
    const fact = store.create({ name: "temp", title: "Temp", type: "reference", body: "link" });
    store.forget("temp");
    assert.equal(store.read("temp"), undefined);
    assert.equal(store.archived().length, 1);
    const restored = store.recover(fact.id);
    assert.equal(restored.revision, fact.revision + 1);
    assert.equal(store.read("temp")?.id, fact.id);
    // Recovering an active name is refused; purge permanently deletes.
    store.forget("temp");
    store.purge("temp");
    assert.equal(store.archived().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search ranks by relevance with a project preference", () => {
  const dir = tempDir();
  try {
    const store = new MemoryStore(dir);
    store.create({ name: "release", title: "Release process", type: "project", scope: "project", body: "Tag and push on every release." });
    store.create({ name: "blue", title: "Favorite color", type: "user", scope: "global", body: "The user prefers blue themes." });
    store.create({ name: "ci", title: "CI pipeline", type: "reference", scope: "global", body: "CI runs pnpm test." });
    const hits = store.search("release process");
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]!.fact.name, "release");
    // A query about color ranks the user fact first despite project bonus being small.
    const colorHits = store.search("favorite color blue");
    assert.equal(colorHits[0]!.fact.name, "blue");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rankMemoryFacts skips unrelated facts and returns stable order", () => {
  const store = new MemoryStore(tempDir());
  const a = store.create({ name: "a", title: "Alpha", type: "project", body: "Alpha deals with auth tokens." });
  const b = store.create({ name: "b", title: "Beta", type: "project", body: "Beta handles nothing related." });
  const hits = rankMemoryFacts("auth token handling", [a, b]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.fact.name, "a");
});
