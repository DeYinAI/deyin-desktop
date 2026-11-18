import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/loop.js";
import type { AgentMessage } from "../src/types.js";
import { createBuiltinRegistry } from "../src/tools/index.js";
import { PermissionEngine } from "../src/permissions.js";
import { startMockOpenAI, textResponse, toolCallResponse } from "./helpers/mock-openai.js";

/**
 * These tests drive the real loop against a mock provider. They prove the
 * reviewer is a separate call, that its verdict decides whether the run
 * continues, and that the round budget and user controls are honoured.
 */

const reviewerReply = (verdict: string, reason = "r", next?: string) =>
  textResponse(JSON.stringify({ verdict, reason, ...(next ? { next } : {}) }));

/** Is this request the reviewer's (no tools declared, system prompt is the reviewer's)? */
function isReviewerRequest(body: Record<string, unknown>): boolean {
  const tools = body.tools;
  const messages = body.messages as { role: string; content: string }[] | undefined;
  return (tools === undefined || (Array.isArray(tools) && tools.length === 0)) &&
    Array.isArray(messages) &&
    messages[0]?.content?.includes("goal reviewer") === true;
}

test("goal loop: reviewer 'continue' then 'done' drives two rounds and ends the goal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-goal-loop-"));
  const server = await startMockOpenAI((i) => {
    // 0: worker answers (no tool call) -> review #1 -> continue
    if (i === 0) return textResponse("Did step one.");
    if (i === 1) return reviewerReply("continue", "step two remains", "do step two");
    // 2: worker does step two
    if (i === 2) return textResponse("Did step two.");
    // 3: review #2 -> done
    if (i === 3) return reviewerReply("done", "objective satisfied");
    return textResponse("done");
  });

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "goal agent" },
      { role: "user", content: "do two steps" },
    ];
    const patches: { rounds?: number; status?: string; reason?: string }[] = [];
    const verdicts: string[] = [];
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
      goalMaxRounds: 5,
      toolContext: { goalText: "do two steps" },
      applyGoal: (patch) => patches.push(patch),
      onEvent: (e) => {
        events.push(e);
        if (e.type === "goal-verdict") verdicts.push(e.verdict);
      },
    });

    assert.equal(result.reason, "completed");
    // One reviewer call per round end.
    const reviewerCalls = server.requests.filter(isReviewerRequest);
    assert.equal(reviewerCalls.length, 2, "reviewer ran once per round");
    // Verdicts surfaced to the UI, in order.
    assert.deepEqual(verdicts, ["continue", "done"]);
    // The goal was continued exactly once, then marked done.
    assert.equal(patches.filter((p) => p.status === "active").length, 1);
    assert.equal(patches.at(-1)?.status, "done");
    assert.equal(patches.at(-1)?.reason, "objective satisfied");
    // The continuation restated the objective as untrusted data.
    const continuation = messages.find((m) => m.role === "user" && m.content.includes("<untrusted_objective>"));
    assert.ok(continuation, "a continuation was injected");
    assert.match(continuation!.content, /Round 1 of 5/);
    assert.match(continuation!.content, /step two remains/);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("goal loop: the round budget stops a goal the reviewer never accepts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-goal-budget-"));
  const server = await startMockOpenAI((i) => {
    void (server.requests[i] as Record<string, unknown> | undefined);
    // Reviewer calls are every other request once the worker has spoken.
    return textResponse("still working");
  });
  // Every reply is worker text, so every request is a worker request; the
  // reviewer will read it as continue because its own reply is not JSON.
  void server;

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "goal agent" },
      { role: "user", content: "never finishes" },
    ];
    const patches: { rounds?: number; status?: string }[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      goalMaxRounds: 2,
      toolContext: { goalText: "never finishes" },
      applyGoal: (patch) => patches.push(patch),
    });

    assert.equal(result.reason, "completed");
    assert.equal(patches.at(-1)?.status, "exhausted", "budget exhaustion is recorded on the goal");
    assert.equal(result.summary?.goalRounds, 2, "exactly the budgeted rounds were spent");
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("goal loop: a paused goal read before the review stops the run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-goal-paused-"));
  const server = await startMockOpenAI((i) => {
    if (i === 0) return textResponse("working");
    return reviewerReply("continue");
  });

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "goal agent" },
      { role: "user", content: "ship it" },
    ];
    const patches: { status?: string }[] = [];
    const verdicts: string[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      goalMaxRounds: 5,
      toolContext: { goalText: "ship it" },
      // The user paused mid-run: the loop must honour it before reviewing.
      readGoal: () => ({ text: "ship it", status: "paused", rounds: 1 }),
      applyGoal: (patch) => patches.push(patch),
      onEvent: (e) => {
        if (e.type === "goal-verdict") verdicts.push(e.verdict);
      },
    });

    assert.equal(result.reason, "completed");
    assert.equal(server.requests.filter(isReviewerRequest).length, 0, "reviewer was not asked for a paused goal");
    assert.deepEqual(verdicts, ["paused"]);
    assert.equal(patches.length, 0, "a paused goal is not rewritten");
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("goal loop: a blocked verdict ends the goal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-goal-blocked-"));
  const server = await startMockOpenAI((i) => {
    if (i === 0) return textResponse("I need credentials.");
    return reviewerReply("blocked", "missing API credentials");
  });

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "goal agent" },
      { role: "user", content: "deploy it" },
    ];
    const patches: { status?: string; reason?: string }[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      goalMaxRounds: 5,
      toolContext: { goalText: "deploy it" },
      applyGoal: (patch) => patches.push(patch),
    });

    assert.equal(result.reason, "completed");
    assert.equal(patches.at(-1)?.status, "blocked");
    assert.match(patches.at(-1)?.reason ?? "", /credentials/);
    // No continuation was injected for a blocked verdict.
    assert.equal(messages.filter((m) => m.role === "user" && m.content.includes("<untrusted_objective>")).length, 0);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("goal loop is off with goalLoop:false, leaving the classic nudge path alone", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-goal-off-"));
  const server = await startMockOpenAI((i) => {
    if (i === 0) return textResponse("claiming done");
    if (i === 1) return toolCallResponse("c1", "report_goal_met", { met: true, reason: "verified" });
    return textResponse("complete");
  });

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "goal agent" },
      { role: "user", content: "verify" },
    ];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      goalLoop: false,
      toolContext: { goalText: "verify" },
    });

    assert.equal(result.reason, "completed");
    // Zero reviewer calls; the classic [goal check] nudge was used instead.
    assert.equal(server.requests.filter(isReviewerRequest).length, 0);
    assert.ok(messages.some((m) => m.role === "user" && m.content.includes("[goal check]")));
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a reviewer that returns garbage asks for another round instead of ending the goal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-goal-garbage-"));
  let reviewerCalls = 0;
  const server = await startMockOpenAI((_i, body) => {
    // Request-aware script: the reviewer retries internally, so a fixed index
    // would drift. The first review attempt is garbage; the next is a verdict.
    if (isReviewerRequest(body)) {
      reviewerCalls += 1;
      return reviewerCalls <= 2
        ? textResponse("I think it's probably fine?")
        : reviewerReply("done", "now proven");
    }
    return textResponse("did something");
  });

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "goal agent" },
      { role: "user", content: "finish it" },
    ];
    const verdicts: string[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      goalMaxRounds: 5,
      toolContext: { goalText: "finish it" },
      onEvent: (e) => {
        if (e.type === "goal-verdict") verdicts.push(e.verdict);
      },
    });

    assert.equal(result.reason, "completed");
    // Unusable verdict -> continue; the run was not ended on a broken reviewer.
    assert.equal(verdicts[0], "continue");
    assert.ok(verdicts.includes("done"), `expected a done verdict, saw ${verdicts.join(",")}`);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
