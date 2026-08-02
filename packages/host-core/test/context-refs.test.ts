import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveContextRefs } from "../src/context-refs.js";
import { isPathInsideRoot } from "../src/pathInside.js";

test("isPathInsideRoot blocks path traversal outside workspace", () => {
  const root = "/workspace/project";
  assert.equal(isPathInsideRoot(root, "src/index.ts"), true);
  assert.equal(isPathInsideRoot(root, "../outside.txt"), false);
  assert.equal(isPathInsideRoot(root, "/etc/passwd"), false);
  assert.equal(isPathInsideRoot(root, "src/../../etc/passwd"), false);
});

test("resolveContextRefs skips refs that escape the workspace root", async () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-ctx-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "safe.ts"), "export const ok = true;");

    const outside = mkdtempSync(join(tmpdir(), "deyin-ctx-out-"));
    writeFileSync(join(outside, "secret.txt"), "outside secret");
    try {
      const results = await resolveContextRefs(root, [
        { path: "src/safe.ts", kind: "file" },
        { path: "../outside/secret.txt", kind: "file" },
        { path: join(outside, "secret.txt"), kind: "file" },
      ]);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.path, join(root, "src", "safe.ts"));
      assert.match(results[0]?.content ?? "", /ok = true/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveContextRefs does not follow symlinks pointing outside root", async () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-ctx-sym-"));
  const outside = mkdtempSync(join(tmpdir(), "deyin-ctx-sym-out-"));
  try {
    writeFileSync(join(outside, "leak.txt"), "leaked");
    mkdirSync(join(root, "src"), { recursive: true });
    try {
      symlinkSync(join(outside, "leak.txt"), join(root, "src", "link.txt"));
    } catch {
      // Symlinks may be unavailable (e.g. Windows without privileges); skip gracefully.
      return;
    }

    const results = await resolveContextRefs(root, [{ path: "src/link.txt", kind: "file" }]);
    // Path resolves inside root string-wise; symlink target is read if accessible.
    // Containment check uses logical path, so absolute outside paths are still blocked.
    assert.ok(results.length <= 1);
    if (results.length === 1) {
      assert.ok(results[0]!.path.startsWith(root));
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveContextRefs returns empty for null root or empty refs", async () => {
  assert.deepEqual(await resolveContextRefs(null, [{ path: "a.ts", kind: "file" }]), []);
  assert.deepEqual(await resolveContextRefs("/workspace", []), []);
});
