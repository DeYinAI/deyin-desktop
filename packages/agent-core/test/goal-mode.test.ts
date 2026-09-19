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

test("active goal completion gate nudges unverified goal completion", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-goal-gate-"));
  // Step 0: model prematurely answers with plain text (no tool call)
  // Step 1: model receives [goal check] nudge and reports goal met
  // Step 2: model answers with completion
  const server = await startMockOpenAI((i) => {
    if (i === 0) return textResponse("I think I am done without verifying.");
    if (i === 1) return toolCallResponse("call_g", "report_goal_met", { met: true, reason: "Verified build passes" });
    return textResponse("All verified and complete.");
  });

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "goal agent" },
      { role: "user", content: "verify test suite" },
    ];
    const reports: Array<{ met: boolean; reason: string }> = [];
    const events: any[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      toolContext: {
        goalText: "verify test suite",
        onGoalReport: (report) => reports.push(report),
      },
      onEvent: (e) => events.push(e),
    });

    assert.equal(result.reason, "completed");
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.met, true);

    // Verify evidence-gate event was fired with unverified_goal
    const gateEvent = events.find((e) => e.type === "evidence-gate" && e.code === "unverified_goal");
    assert.ok(gateEvent, "expected unverified_goal evidence-gate event");

    // Verify nudge prompt was injected into transcript
    const nudgeMsg = messages.find((m) => m.role === "user" && m.content.includes("[goal check]"));
    assert.ok(nudgeMsg, "expected [goal check] user message in transcript");
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("active goal completion gate respects budget when model refuses report_goal_met", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-goal-budget-"));
  // Model repeatedly answers with plain text without calling report_goal_met
  const server = await startMockOpenAI(() => textResponse("Still not calling report_goal_met."));

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "goal agent" },
      { role: "user", content: "verify test suite" },
    ];
    const events: any[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      toolContext: {
        goalText: "verify test suite",
      },
      onEvent: (e) => events.push(e),
    });

    // Should finish completed rather than wedging in an infinite loop
    assert.equal(result.reason, "completed");
    const gateEvents = events.filter((e) => e.type === "evidence-gate" && e.code === "unverified_goal");
    assert.equal(gateEvents.length, 2); // Budget is 2 nudges
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("goalReconcile: false disables active goal completion gate", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-goal-disabled-"));
  const server = await startMockOpenAI(() => textResponse("Immediate text answer."));

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "goal agent" },
      { role: "user", content: "verify test suite" },
    ];
    const events: any[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      goalReconcile: false,
      toolContext: {
        goalText: "verify test suite",
      },
      onEvent: (e) => events.push(e),
    });

    assert.equal(result.reason, "completed");
    const gateEvents = events.filter((e) => e.type === "evidence-gate" && e.code === "unverified_goal");
    assert.equal(gateEvents.length, 0);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
