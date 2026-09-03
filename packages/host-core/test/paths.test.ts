import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertInsideRoot } from "../src/host/paths.js";
import { isPathInsideRoot, logicalResolve } from "../src/pathInside.js";

test("assertInsideRoot rejects a symlink inside root that points outside", () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "deyin-outside-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "top secret");
    // Plant a symlink inside root that points at the outside directory.
    symlinkSync(outside, join(root, "escape"), "dir");
    // `escape/secret.txt` resolves under root by string ops, but realpath is outside.
    assert.throws(() => assertInsideRoot(root, "escape/secret.txt"), /escapes workspace root/);
    // New-file path through the symlink dir must also be rejected.
    assert.throws(() => assertInsideRoot(root, "escape/new.txt"), /escapes workspace root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("assertInsideRoot allows in-root file and directory paths", () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-path-"));
  try {
    const file = join(root, "src", "a.ts");
    const dir = join(root, "src");
    assert.equal(assertInsideRoot(root, file), file);
    assert.equal(assertInsideRoot(root, dir), dir);
    assert.equal(assertInsideRoot(root, root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertInsideRoot rejects absolute paths outside root", () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-path-"));
  try {
    assert.throws(() => assertInsideRoot(root, "/etc/passwd"), /escapes workspace root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertInsideRoot rejects ../ escape", () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-path-"));
  try {
    assert.throws(() => assertInsideRoot(root, join(root, "..", "sibling")), /escapes workspace root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertInsideRoot rejects sibling-prefix paths", () => {
  const parent = mkdtempSync(join(tmpdir(), "deyin-path-"));
  try {
    const root = join(parent, "foo");
    const sibling = join(parent, "foobar", "secret.txt");
    // root need not exist on disk for resolve + prefix check
    assert.throws(() => assertInsideRoot(root, sibling), /escapes workspace root/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("assertInsideRoot resolves relative paths against root even when cwd differs", () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-path-"));
  const other = mkdtempSync(join(tmpdir(), "deyin-cwd-"));
  const prev = process.cwd();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "x");
    process.chdir(other);
    assert.equal(assertInsideRoot(root, "src/a.ts"), resolve(root, "src", "a.ts"));
    assert.throws(() => assertInsideRoot(root, "../outside"), /escapes workspace root/);
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("assertInsideRoot maps POSIX paths onto WSL UNC workspace roots", () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-wsl-"));
  writeFileSync(join(root, "oracle_cloud_account.txt"), "creds");
  try {
    const unc = `\\\\wsl.localhost\\Ubuntu-22.04${root.replace(/\//g, "\\")}`;
    const posix = `${root}/oracle_cloud_account.txt`;
    const resolved = assertInsideRoot(unc, posix);
    assert.equal(resolved, `${unc}\\oracle_cloud_account.txt`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isPathInsideRoot allows in-root and rejects escapes (pure)", () => {
  const root = "/tmp/deyin-ws-foo";
  assert.equal(isPathInsideRoot(root, root), true);
  assert.equal(isPathInsideRoot(root, `${root}/src/a.ts`), true);
  assert.equal(isPathInsideRoot(root, "src/a.ts"), true);
  assert.equal(isPathInsideRoot(root, "../outside"), false);
  assert.equal(isPathInsideRoot(root, "/etc/passwd"), false);
  assert.equal(isPathInsideRoot(root, "/tmp/deyin-ws-foobar/secret"), false);
});

test("isPathInsideRoot handles backslash roots", () => {
  const root = "C:\\Users\\me\\proj";
  assert.equal(isPathInsideRoot(root, "C:\\Users\\me\\proj\\src\\a.ts"), true);
  assert.equal(isPathInsideRoot(root, "C:\\Users\\me\\proj2\\a.ts"), false);
  assert.equal(logicalResolve(root, "..\\other"), "c:/Users/me/other");
});
