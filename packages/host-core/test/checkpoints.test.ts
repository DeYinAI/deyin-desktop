import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CheckpointStore } from "../src/checkpoints.js";
import {
  checkpointFileOpsFromRoot,
  revertCheckpoint,
  revertCheckpoints,
} from "../src/checkpoint-revert.js";
import { FileStorage } from "../src/storage.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deyin-cp-test-"));
}

function storePair() {
  const dir = tempDir();
  const storage = new FileStorage(join(dir, "data"));
  const checkpoints = new CheckpointStore(storage);
  const root = join(dir, "workspace");
  mkdirSync(root, { recursive: true });
  const ops = checkpointFileOpsFromRoot(root, async (path) => {
    const abs = resolve(root, path.replace(/^\.\//, ""));
    if (!abs.startsWith(root)) throw new Error("escape");
    return abs;
  });
  return { dir, storage, checkpoints, root, ops, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("CheckpointStore records and lists entries", async () => {
  const { checkpoints, cleanup } = storePair();
  try {
    await checkpoints.record("t1", "cp1", {
      path: "a.txt",
      before: "",
      after: "hello",
      operation: "write",
    });
    const list = checkpoints.list("t1");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.checkpointId, "cp1");
    assert.equal(list[0]!.path, "a.txt");
  } finally {
    cleanup();
  }
});

test("revertCheckpoint restores file content and marks entries reverted", async () => {
  const { checkpoints, storage, root, ops, cleanup } = storePair();
  try {
    const file = join(root, "foo.ts");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "original", "utf8");

    await checkpoints.record("t1", "cp_run", {
      path: "foo.ts",
      before: "original",
      after: "modified",
      operation: "edit",
    });
    writeFileSync(file, "modified", "utf8");

    const result = await revertCheckpoint(checkpoints, storage, ops, "t1", "cp_run");
    assert.equal(result.ok, true);
    assert.deepEqual(result.revertedPaths, ["foo.ts"]);
    assert.equal(readFileSync(file, "utf8"), "original");
    assert.equal(checkpoints.activeEntries("t1", "cp_run").length, 0);
  } finally {
    cleanup();
  }
});

test("revertCheckpoint deletes new files when before was empty", async () => {
  const { checkpoints, storage, root, ops, cleanup } = storePair();
  try {
    const file = join(root, "new.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "brand new", "utf8");

    await checkpoints.record("t1", "cp_new", {
      path: "new.txt",
      before: "",
      after: "brand new",
      operation: "write",
    });

    const result = await revertCheckpoint(checkpoints, storage, ops, "t1", "cp_new");
    assert.equal(result.ok, true);
    assert.equal(existsSync(file), false);
  } finally {
    cleanup();
  }
});

test("revertCheckpoint uses earliest before for multiple edits to same path", async () => {
  const { checkpoints, storage, root, ops, cleanup } = storePair();
  try {
    const file = join(root, "x.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "C", "utf8");

    await checkpoints.record("t1", "cp1", {
      path: "x.txt",
      before: "A",
      after: "B",
      operation: "edit",
    });
    await checkpoints.record("t1", "cp1", {
      path: "x.txt",
      before: "B",
      after: "C",
      operation: "edit",
    });

    const result = await revertCheckpoint(checkpoints, storage, ops, "t1", "cp1");
    assert.equal(result.ok, true);
    assert.equal(readFileSync(file, "utf8"), "A");
  } finally {
    cleanup();
  }
});

test("revertCheckpoints reverts multiple checkpoint ids", async () => {
  const { checkpoints, storage, root, ops, cleanup } = storePair();
  try {
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(a, "A2", "utf8");
    writeFileSync(b, "B2", "utf8");

    await checkpoints.record("t1", "cp1", { path: "a.txt", before: "A1", after: "A2", operation: "edit" });
    await checkpoints.record("t1", "cp2", { path: "b.txt", before: "B1", after: "B2", operation: "edit" });

    const result = await revertCheckpoints(checkpoints, storage, ops, "t1", ["cp1", "cp2"]);
    assert.equal(result.ok, true);
    assert.equal(readFileSync(a, "utf8"), "A1");
    assert.equal(readFileSync(b, "utf8"), "B1");
  } finally {
    cleanup();
  }
});

test("revert is blocked when agent is running", async () => {
  const { checkpoints, storage, ops, cleanup } = storePair();
  try {
    await checkpoints.record("t1", "cp1", {
      path: "z.txt",
      before: "",
      after: "x",
      operation: "write",
    });
    const result = await revertCheckpoint(checkpoints, storage, ops, "t1", "cp1", {
      isAgentRunning: () => true,
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /in progress/i);
  } finally {
    cleanup();
  }
});

test("second revert of same checkpoint is idempotent", async () => {
  const { checkpoints, storage, root, ops, cleanup } = storePair();
  try {
    const file = join(root, "idempotent.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "v2", "utf8");
    await checkpoints.record("t1", "cp1", {
      path: "idempotent.txt",
      before: "v1",
      after: "v2",
      operation: "edit",
    });
    const first = await revertCheckpoint(checkpoints, storage, ops, "t1", "cp1");
    assert.equal(first.ok, true);
    writeFileSync(file, "manual", "utf8");
    const second = await revertCheckpoint(checkpoints, storage, ops, "t1", "cp1");
    assert.equal(second.ok, true);
    assert.equal(second.revertedPaths.length, 0);
    assert.equal(readFileSync(file, "utf8"), "manual");
  } finally {
    cleanup();
  }
});
