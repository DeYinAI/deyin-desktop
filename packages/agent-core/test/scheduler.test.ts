import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  normalizeWritePaths,
  validateNonOverlappingWriteClaims,
  wholeWorkspaceWriteClaim,
  writePathSetsOverlap,
} from "../src/scheduler/write-claims.js";
import { SubagentScheduler } from "../src/scheduler/subagent-scheduler.js";

test("write paths overlap detection", () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-claims-"));
  try {
    const a = normalizeWritePaths(cwd, ["src/a.ts"]);
    const b = normalizeWritePaths(cwd, ["src/a.ts"]);
    const c = normalizeWritePaths(cwd, ["src/b.ts"]);
    assert.equal(writePathSetsOverlap(a, b), true);
    assert.equal(writePathSetsOverlap(a, c), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("whole workspace claims overlap", () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-ws-"));
  try {
    const whole = wholeWorkspaceWriteClaim(cwd);
    const partial = normalizeWritePaths(cwd, ["src/x.ts"]);
    assert.equal(writePathSetsOverlap(whole, partial), true);
    assert.throws(() => validateNonOverlappingWriteClaims([whole, partial]));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("non-overlapping writers can run in parallel", async () => {
  const sched = new SubagentScheduler({ maxSubagentConcurrency: 6, maxParallelWriters: 3 });
  const cwd = mkdtempSync(join(tmpdir(), "deyin-sched-"));
  try {
    const a = normalizeWritePaths(cwd, ["src/a.ts"]);
    const b = normalizeWritePaths(cwd, ["src/b.ts"]);

    const r1 = sched.tryAcquire({ writer: true, writePaths: a, nested: false });
    const r2 = sched.tryAcquire({ writer: true, writePaths: b, nested: false });
    assert.equal(r1.acquired, true);
    assert.equal(r2.acquired, true);
    r1.release?.();
    r2.release?.();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("overlapping writer rejected at acquire", () => {
  const sched = new SubagentScheduler({ maxSubagentConcurrency: 6, maxParallelWriters: 3 });
  const cwd = mkdtempSync(join(tmpdir(), "deyin-sched2-"));
  try {
    const a = normalizeWritePaths(cwd, ["src/shared.ts"]);
    const r1 = sched.tryAcquire({ writer: true, writePaths: a, nested: false });
    assert.equal(r1.acquired, true);
    const r2 = sched.tryAcquire({ writer: true, writePaths: a, nested: true });
    assert.equal(r2.acquired, false);
    r1.release?.();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("parent write blocks conflicting subagent", () => {
  const sched = new SubagentScheduler({ maxSubagentConcurrency: 6, maxParallelWriters: 3 });
  const cwd = mkdtempSync(join(tmpdir(), "deyin-parent-"));
  try {
    const path = normalizeWritePaths(cwd, ["src/main.ts"]);
    const release = sched.reserveParentWrite(path);
    const r = sched.tryAcquire({ writer: true, writePaths: path, nested: true });
    assert.equal(r.acquired, false);
    release();
    const r2 = sched.tryAcquire({ writer: true, writePaths: path, nested: true });
    assert.equal(r2.acquired, true);
    r2.release?.();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("readers do not block writers on different paths", () => {
  const sched = new SubagentScheduler({ maxSubagentConcurrency: 6, maxParallelWriters: 3 });
  const empty = { paths: [], wholeWorkspace: false, workspaceRoot: process.cwd() };
  const r1 = sched.tryAcquire({ writer: false, writePaths: empty, nested: false });
  assert.equal(r1.acquired, true);
  const cwd = mkdtempSync(join(tmpdir(), "deyin-read-"));
  try {
    const w = normalizeWritePaths(cwd, ["out.txt"]);
    const r2 = sched.tryAcquire({ writer: true, writePaths: w, nested: false });
    assert.equal(r2.acquired, true);
    r1.release?.();
    r2.release?.();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
