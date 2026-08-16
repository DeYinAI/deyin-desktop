import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computePrefixShape } from "../src/cache/prefix-tracker.js";
import { JobsManager } from "../src/jobs/manager.js";
import { invalidateCorruptedCacheStats } from "../src/migration/session-v2.js";

test("edge: cache stats invalidated when prefix hash corrupted", () => {
  const system = { role: "system" as const, content: "test" };
  const tools = [{ type: "function" as const, function: { name: "read", description: "d", parameters: {} } }];
  const shape = computePrefixShape(system, tools, 0, 50);

  const reset = invalidateCorruptedCacheStats("deadbeefdeadbeef", shape.prefixHash, {
    sessionCacheHit: 9000,
    sessionCacheMiss: 1000,
    hitRate: 0.9,
    logRewriteVersion: 0,
    lastUpdated: new Date().toISOString(),
  });

  assert.ok(reset);
  assert.equal(reset!.sessionCacheHit, 0);
  assert.equal(reset!.hitRate, 0);
});

test("edge: background jobs recovered after crash on reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-edge-jobs-"));
  const persist = join(dir, "jobs.jsonl");

  writeFileSync(
    persist,
    `${JSON.stringify({
      id: "job-stale",
      sessionId: "sess-crash",
      kind: "task",
      label: "bg",
      prompt: "work",
      startTime: Date.now() - 120_000,
      status: "running",
    })}\n`,
  );

  const mgr = new JobsManager("sess-crash", persist);
  assert.equal(mgr.get("job-stale")?.status, "failed");

  rmSync(dir, { recursive: true, force: true });
});
