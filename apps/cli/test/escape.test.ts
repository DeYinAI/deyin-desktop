import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeShellCommand } from "@deyin/agent-core";
import { createContext } from "../src/context.js";

test("executeShellCommand runs properly in workspace cwd", async () => {
  const ws = mkdtempSync(join(tmpdir(), "deyin-escape-"));
  try {
    const res = await executeShellCommand("echo 'escape-ok'", ws);
    assert.equal(res.exitCode, 0);
    assert.ok(res.output.includes("escape-ok"));

    const fail = await executeShellCommand("exit 3", ws);
    assert.equal(fail.exitCode, 3);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("session created with ! command records fenced user message without orphan tool turns", () => {
  const ws = mkdtempSync(join(tmpdir(), "deyin-escape-sess-"));
  const dataDir = mkdtempSync(join(tmpdir(), "deyin-data-"));
  const previous = process.env.DEYIN_DATA_DIR;
  process.env.DEYIN_DATA_DIR = dataDir;

  try {
    const ctx = createContext({ cwd: ws });
    const sess = ctx.sessions.create({ cwd: ws, model: "test-model", agent: "build" });
    const userMsg = {
      role: "user" as const,
      content: `! git status\n\n\`\`\`\nOn branch main\nnothing to commit\n\`\`\``,
    };
    ctx.sessions.append(sess.id, userMsg);

    const reloaded = ctx.sessions.load(sess.id);
    assert.ok(reloaded);
    assert.equal(reloaded.messages.length, 1);
    const firstMsg = reloaded.messages[0];
    assert.ok(firstMsg);
    assert.equal(firstMsg.role, "user");
    assert.ok(firstMsg.content.includes("On branch main"));
  } finally {
    if (previous === undefined) delete process.env.DEYIN_DATA_DIR;
    else process.env.DEYIN_DATA_DIR = previous;
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
