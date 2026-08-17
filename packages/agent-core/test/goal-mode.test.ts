import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgent } from "../src/loop.js";
import { PermissionEngine } from "../src/permissions.js";
import { createBuiltinRegistry } from "../src/tools/index.js";
import type { AgentMessage } from "../src/types.js";
import { startMockOpenAI, textResponse, toolCallResponse } from "./helpers/mock-openai.js";

test("report_goal_met reports through onGoalReport and marks the goal met", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-goal-"));
  const server = await startMockOpenAI((i) =>
    i === 0
      ? toolCallResponse("call_goal", "report_goal_met", { met: true, reason: "All tests pass" })
      : textResponse("Goal complete."),
  );

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "goal agent" },
      { role: "user", content: "make the build green" },
    ];
    const reports: Array<{ met: boolean; reason: string }> = [];
    await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      toolContext: {
        goalText: "make the build green",
        onGoalReport: (report) => reports.push(report),
      },
    });

    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0], { met: true, reason: "All tests pass" });

    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg && toolMsg.role === "tool");
    assert.match(toolMsg.content, /Goal marked as met: All tests pass/);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("report_goal_met with met=true errors when no goal is active", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-goal-2-"));
  const server = await startMockOpenAI((i) =>
    i === 0
      ? toolCallResponse("call_goal", "report_goal_met", { met: true, reason: "done" })
      : textResponse("ok"),
  );

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "goal agent" },
      { role: "user", content: "do a thing" },
    ];
    const reports: Array<{ met: boolean; reason: string }> = [];
    await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      toolContext: {
        onGoalReport: (report) => reports.push(report),
      },
    });

    // No goalText → the tool must refuse and never report.
    assert.equal(reports.length, 0);
    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg && toolMsg.role === "tool");
    assert.match(toolMsg.content, /No active goal/);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
