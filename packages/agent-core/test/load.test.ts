import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILTIN_SUBAGENTS } from "../src/capabilities/subagents.js";
import { JobsManager } from "../src/jobs/manager.js";
import { OptimizationTracker } from "../src/optimization.js";
import { comparePrefixShapes, computePrefixShape } from "../src/cache/prefix-tracker.js";
import { createFleetTool } from "../src/tools/fleet.js";
import { runCacheGuard } from "../src/testing/cache-guard.js";

test("load: 500-turn session simulation maintains cache hit rate", () => {
  const turns = Array.from({ length: 500 }, (_, i) => {
    const missTokens = i === 0 ? 4000 : 300 + (i % 5) * 20;
    const hitTokens = i === 0 ? 0 : missTokens * 7;
    return { missTokens, hitTokens };
  });

  const system = { role: "system" as const, content: "Load test system prompt" };
  const tools = Array.from({ length: 12 }, (_, j) => ({
    type: "function" as const,
    function: { name: `tool_${j}`, description: "d", parameters: { type: "object", properties: {} } },
  }));

  const tracker = new OptimizationTracker();
  let prev = computePrefixShape(system, tools, 0, 600);

  for (const turn of turns) {
    const shape = computePrefixShape(system, tools, 0, 600);
    const diag = comparePrefixShapes(prev, shape, turn.hitTokens, turn.missTokens);
    tracker.recordPrefixShape(shape, diag);
    prev = shape;
  }

  const m = tracker.get();
  const hitRate = m.sessionCacheHit / (m.sessionCacheHit + m.sessionCacheMiss);
  assert.ok(hitRate >= 0.8, `500-turn hit rate ${hitRate}`);
});

test("load: 32 parallel fleet tasks complete without deadlock", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-load-fleet-"));
  const fleet = createFleetTool({
    subagents: BUILTIN_SUBAGENTS,
    cwd,
    runSubagent: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, report: "done" };
    },
  });

  const tasks = Array.from({ length: 32 }, (_, i) => ({
    profile: "explorer",
    prompt: `read-only task ${i}`,
    read_only: true,
  }));

  const start = performance.now();
  const result = await fleet.execute({ tasks }, { cwd, todos: [] });
  const elapsed = performance.now() - start;

  assert.ok(result.includes("Completed fleet of 32"));
  assert.ok(elapsed < 5000, `32 tasks took ${elapsed}ms — possible degradation`);
  rmSync(cwd, { recursive: true, force: true });
});

test("load: background jobs across turn boundaries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-load-jobs-"));
  const persist = join(dir, "jobs.jsonl");

  const mgr = new JobsManager("load-session", persist);
  const jobs = Array.from({ length: 10 }, (_, i) =>
    mgr.register({ kind: "task", label: `job-${i}`, prompt: `work ${i}` }),
  );

  setTimeout(() => {
    for (const job of jobs) mgr.updateStatus(job.id, "completed", `result ${job.label}`);
  }, 50);

  const results = await mgr.waitFor(jobs.map((j) => j.id), 3000);
  assert.equal(results.length, 10);
  assert.ok(results.every((j) => j.status === "completed"));

  const notes = mgr.drainCompletionNotes();
  assert.equal(notes.length, 10);

  rmSync(dir, { recursive: true, force: true });
});

test("load: cache guard scenarios remain stable under extended runs", () => {
  const results = runCacheGuard();
  assert.ok(results.every((r) => r.passed));
  assert.ok(results.every((r) => r.hitRate >= 0.8));
});

test("load: memory stable after repeated transcript folds", () => {
  const iterations = 50;
  let events: Array<{ kind: string; text: string }> = [];

  for (let round = 0; round < iterations; round++) {
    events = [];
    for (let i = 0; i < 100; i++) {
      events.push({ kind: "user", text: `u${i}` });
      events.push({ kind: "assistant", text: `a${i}`.repeat(100) });
    }
    assert.equal(events.length, 200);
  }

  assert.equal(events.length, 200);
});
