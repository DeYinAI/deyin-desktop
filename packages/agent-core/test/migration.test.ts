import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backfillSessionFile, stripSessionV2Meta } from "../src/migration/backfill.js";
import { migrateCliConfigV9 } from "../src/migration/config-v9.js";
import { SESSION_SCHEMA_VERSION } from "../src/migration/session-v2.js";
import { loadCliConfig } from "../src/config.js";
import { SessionStore } from "../src/session.js";

test("migration: old v1 sessions load and upgrade to v2", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-migrate-"));
  try {
    const store = new SessionStore(dir);
    const meta = store.create({ cwd: "/tmp", model: "GLM-5.2", agent: "build" });
    store.append(meta.id, { role: "user", content: "hello" });

    // Simulate v1 meta on disk.
    const file = join(dir, `${meta.id}.jsonl`);
    const v1Meta = {
      type: "meta",
      meta: {
        id: meta.id,
        title: "",
        createdAt: meta.createdAt,
        cwd: "/tmp",
        model: "GLM-5.2",
        agent: "build",
      },
    };
    writeFileSync(file, `${JSON.stringify(v1Meta)}\n${JSON.stringify({ type: "message", message: { role: "user", content: "hello" } })}\n`);

    const loaded = store.load(meta.id);
    assert.ok(loaded);
    assert.equal(loaded!.meta.schemaVersion, SESSION_SCHEMA_VERSION);
    assert.ok(loaded!.meta.prefixHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration: backfill adds prefix_hash and cache_stats", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-backfill-"));
  try {
    const id = "s_old123";
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(
      file,
      `${JSON.stringify({
        type: "meta",
        meta: { id, title: "", createdAt: "2026-01-01T00:00:00Z", cwd: "/w", model: "m", agent: "build" },
      })}\n${JSON.stringify({ type: "message", message: { role: "system", content: "sys" } })}\n`,
    );

    const result = backfillSessionFile(file);
    assert.equal(result.migrated, true);
    assert.ok(result.prefixHash);

    const raw = readFileSync(file, "utf8");
    assert.ok(raw.includes("prefixHash"));
    assert.ok(raw.includes("cacheStats"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration: upgrade → rollback → upgrade path", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-roundtrip-"));
  try {
    const upgraded = {
      id: "s1",
      title: "",
      createdAt: "2026-01-01T00:00:00Z",
      cwd: "/w",
      model: "m",
      agent: "build",
      schemaVersion: SESSION_SCHEMA_VERSION,
      prefixHash: "abc123",
      cacheStats: {
        sessionCacheHit: 100,
        sessionCacheMiss: 10,
        hitRate: 0.9,
        logRewriteVersion: 0,
        lastUpdated: "2026-01-01",
      },
    };

    const rolledBack = stripSessionV2Meta(upgraded);
    assert.equal((rolledBack as { schemaVersion?: number }).schemaVersion, undefined);

    const file = join(dir, "s1.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ type: "meta", meta: rolledBack })}\n${JSON.stringify({ type: "message", message: { role: "system", content: "x" } })}\n`,
    );

    const reUpgraded = backfillSessionFile(file);
    assert.equal(reUpgraded.migrated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration: config v9 adds plannerModel and scheduler settings", () => {
  const resolved = loadCliConfig({ cwd: process.cwd(), globalDir: "/nonexistent" });
  const v9 = migrateCliConfigV9(resolved, [{ plannerModel: "deepseek-reasoner", scheduler: { maxSubagentConcurrency: 8, maxParallelWriters: 2 } }]);
  assert.equal(v9.plannerModel, "deepseek-reasoner");
  assert.equal(v9.maxSubagentConcurrency, 8);
  assert.equal(v9.maxParallelWriters, 2);
  assert.equal(v9.configSchemaVersion, 9);
});
