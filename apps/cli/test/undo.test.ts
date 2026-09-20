import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointStore, checkpointFileOpsFromRoot, revertCheckpoint } from "@deyin/host-core";
import { createContext } from "../src/context.js";

test("checkpoint recording and revertCheckpoint restores modified files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-undo-test-"));
  const dataDir = mkdtempSync(join(tmpdir(), "deyin-undo-data-"));
  try {
    const file = join(dir, "app.ts");
    writeFileSync(file, "const a = 1;\n");

    const ctx = createContext({ cwd: dir, dataDir });
    const store = new CheckpointStore(ctx.storage);
    const sessionId = "sess-undo-1";
    const checkpointId = "chk-1";

    // Modify file
    writeFileSync(file, "const a = 2;\nconst b = 3;\n");

    // Record checkpoint
    await store.record(sessionId, checkpointId, {
      path: file,
      before: "const a = 1;\n",
      after: "const a = 2;\nconst b = 3;\n",
      operation: "edit",
    });

    const entries = store.list(sessionId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.path, file);

    // Revert checkpoint (as done by /undo)
    const ops = checkpointFileOpsFromRoot(ctx.cwd, async (p) => p);
    const res = await revertCheckpoint(store, ctx.storage, ops, sessionId, checkpointId);
    assert.ok(res.ok);
    assert.equal(res.revertedPaths.length, 1);

    const revertedContent = readFileSync(file, "utf8");
    assert.equal(revertedContent, "const a = 1;\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
