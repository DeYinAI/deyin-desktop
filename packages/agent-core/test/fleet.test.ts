import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILTIN_SUBAGENTS } from "../src/capabilities/subagents.js";
import { createFleetTool } from "../src/tools/fleet.js";
import { JobsManager } from "../src/jobs/manager.js";
import type { ToolContext } from "../src/types.js";

test("fleet preflight rejects overlapping write paths", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-fleet-"));
  try {
    const tool = createFleetTool({
      subagents: BUILTIN_SUBAGENTS,
      cwd,
      runSubagent: async () => ({ ok: true, report: "ok" }),
    });
    const ctx: ToolContext = { cwd, todos: [] };
    const result = await tool.execute(
      {
        tasks: [
          { profile: "test-runner", prompt: "edit a", write_paths: ["src/a.ts"] },
          { profile: "test-runner", prompt: "edit a too", write_paths: ["src/a.ts"] },
        ],
      },
      ctx,
    );
    assert.ok(result.includes("fleet preflight"));
    assert.ok(result.includes("conflict"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("fleet runs parallel non-overlapping tasks", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-fleet2-"));
  try {
    let parallel = 0;
    let maxParallel = 0;
    const tool = createFleetTool({
      subagents: BUILTIN_SUBAGENTS,
      cwd,
      runSubagent: async () => {
        parallel++;
        maxParallel = Math.max(maxParallel, parallel);
        await new Promise((r) => setTimeout(r, 20));
        parallel--;
        return { ok: true, report: "done" };
      },
    });
    const result = await tool.execute(
      {
        tasks: [
          { profile: "explorer", prompt: "research a", read_only: true },
          { profile: "explorer", prompt: "research b", read_only: true },
        ],
      },
      { cwd, todos: [] },
    );
    assert.ok(result.includes("Completed fleet"));
    assert.ok(maxParallel >= 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("jobs manager lifecycle and persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-jobs-"));
  try {
    const persist = join(dir, "jobs.jsonl");
    const mgr = new JobsManager("sess-1", persist);
    const job = mgr.register({ kind: "task", label: "test", prompt: "do work" });
    assert.equal(job.status, "running");

    mgr.updateStatus(job.id, "completed", "all good");
    assert.equal(mgr.getCompleted().length, 1);

    const notes = mgr.drainCompletionNotes();
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.jobId, job.id);

    const mgr2 = new JobsManager("sess-1", persist);
    assert.ok(mgr2.get(job.id));
    assert.equal(mgr2.get(job.id)?.status, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("jobs waitFor resolves when jobs complete", async () => {
  const mgr = new JobsManager("sess-wait");
  const job = mgr.register({ kind: "task", label: "bg", prompt: "x" });
  setTimeout(() => mgr.updateStatus(job.id, "completed", "result text"), 50);
  const results = await mgr.waitFor([job.id], 2000);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.status, "completed");
});
