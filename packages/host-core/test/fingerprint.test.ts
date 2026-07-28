import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateFingerprint, workspaceFingerprint } from "../src/host/fingerprint.js";

test("workspaceFingerprint is stable for the same machine + workspace", () => {
  const a = workspaceFingerprint("machine-1", "/home/user/project");
  const b = workspaceFingerprint("machine-1", "/home/user/project");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("workspaceFingerprint differs across machines and workspaces", () => {
  const base = workspaceFingerprint("machine-1", "/home/user/project");
  assert.notEqual(workspaceFingerprint("machine-2", "/home/user/project"), base);
  assert.notEqual(workspaceFingerprint("machine-1", "/home/user/other"), base);
});

test("workspaceFingerprint handles the no-workspace (default project) case", () => {
  const withNull = workspaceFingerprint("machine-1", null);
  assert.match(withNull, /^[0-9a-f]{64}$/);
  // null and "" both mean "no folder open" and must share one fingerprint,
  // distinct from any real workspace.
  assert.equal(withNull, workspaceFingerprint("machine-1", ""));
  assert.notEqual(withNull, workspaceFingerprint("machine-1", "/home/user/project"));
});

test("truncateFingerprint shortens to head…tail", () => {
  const full = "d4e9a1b2c3d4e5f6a7b8c9d0e1f2c731";
  assert.equal(truncateFingerprint(full), "d4e9…c731");
  assert.equal(truncateFingerprint("short"), "short");
});
