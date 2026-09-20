import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitStatusTool, gitLogTool } from "../src/tools/git.js";
import type { ToolContext } from "../src/types.js";

function makeContext(cwd: string): ToolContext {
  return {
    cwd,
    todos: [],
  };
}

test("git_status and git_log error cleanly on non-repo instead of silent false results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-non-repo-"));
  try {
    const ctx = makeContext(dir);
    const statusRes = await gitStatusTool.execute({}, ctx);
    assert.match(statusRes, /ERROR: Not a git repository/);

    const logRes = await gitLogTool.execute({}, ctx);
    assert.match(logRes, /ERROR: Not a git repository/);
    assert.notEqual(logRes, "No commits.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
