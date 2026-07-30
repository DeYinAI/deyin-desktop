import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readTextFile, readTree, writeTextFile } from "../src/host/files.js";

test("readTree ignores build/system dirs, sorts directories first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-tree-"));
  try {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "zeta.txt"), "z");
    writeFileSync(join(dir, "src", "index.ts"), "code");

    const tree = await readTree(dir);
    assert.deepEqual(
      tree.map((n) => `${n.type}:${n.name}`),
      ["directory:src", "file:zeta.txt"],
    );
    assert.equal(tree[0]?.children?.[0]?.name, "index.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTextFile returns utf8 content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-read-"));
  try {
    writeFileSync(join(dir, "a.txt"), "héllo\nwörld");
    assert.equal(await readTextFile(join(dir, "a.txt")), "héllo\nwörld");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeTextFile writes utf8 content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-write-"));
  try {
    const path = join(dir, "out.txt");
    await writeTextFile(path, "saved\ncontent");
    assert.equal(await readTextFile(path), "saved\ncontent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
