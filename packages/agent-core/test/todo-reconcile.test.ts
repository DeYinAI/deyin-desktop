import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgent } from "../src/loop.js";
import { PermissionEngine } from "../src/permissions.js";
import { createBuiltinRegistry } from "../src/tools/index.js";
import type { AgentMessage, TodoItem } from "../src/types.js";
import { startMockOpenAI, textResponse, toolCallResponse } from "./helpers/mock-openai.js";

function baseMessages(): AgentMessage[] {
  return [
    { role: "system", content: "You are a test agent." },
    { role: "user", content: "do the work" },
  ];
}

test("a final answer with open todos triggers one reconcile nudge, then completes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-todo-nudge-"));
  // Script: (0) text answer with open todos -> nudge, (1) todo_write marking
  // everything completed, (2) final text answer -> done.
  const server = await startMockOpenAI((i) =>
    i === 0
      ? textResponse("All done, I think.")
      : i === 1
        ? toolCallResponse("call_tw", "todo_write", {
            todos: [
              { id: "t1", content: "step one", status: "completed" },
              { id: "t2", content: "step two", status: "completed" },
            ],
          })
        : textResponse("Now really done."),
  );

  try {
    const messages = baseMessages();
    const todos: TodoItem[] = [
      { id: "t1", content: "step one", status: "completed" },
      { id: "t2", content: "step two", status: "in_progress" },
    ];
    const gates: { code: string; message: string }[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "test-token",
      model: "test-model",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "allow",
      cwd,
      todos,
      onEvent: (ev) => {
        if (ev.type === "evidence-gate") gates.push({ code: ev.code, message: ev.message });
      },
    });

    assert.equal(result.reason, "completed");
    assert.equal(result.finalText, "Now really done.");
    assert.equal(gates.length, 1);
    assert.equal(gates[0]!.code, "open_todos");

    // The injected reconcile turn must be on the transcript.
    const reconcile = messages.find(
      (m) => m.role === "user" && String(m.content).includes("[todo reconcile]"),
    );
    assert.ok(reconcile, "reconcile nudge missing from transcript");
    assert.match(String(reconcile.content), /t2: step two \(in_progress\)/);

    // The todo_write call from the nudge updated the shared array.
    assert.equal(todos.every((t) => t.status === "completed"), true);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the reconcile nudge is budgeted: the run finishes even if todos stay open", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-todo-nudge-cap-"));
  // The model never touches todo_write — text answers all the way.
  let calls = 0;
  const server = await startMockOpenAI(() => {
    calls += 1;
    return textResponse(`answer ${calls}`);
  });

  try {
    const messages = baseMessages();
    const todos: TodoItem[] = [{ id: "t1", content: "never done", status: "pending" }];
    const gates: { code: string }[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "test-token",
      model: "test-model",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "allow",
      cwd,
      todos,
      onEvent: (ev) => {
        if (ev.type === "evidence-gate") gates.push({ code: ev.code });
      },
    });

    assert.equal(result.reason, "completed");
    // Nudged exactly to budget, then the final answer went through.
    assert.equal(gates.length, 2);
    assert.equal(result.finalText, "answer 3");
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("todoReconcile: false restores the old fire-and-forget turn end", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-todo-nudge-off-"));
  const server = await startMockOpenAI(() => textResponse("done, ignoring todos"));

  try {
    const messages = baseMessages();
    const todos: TodoItem[] = [{ id: "t1", content: "open item", status: "pending" }];
    const gates: { code: string }[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "test-token",
      model: "test-model",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "allow",
      cwd,
      todos,
      todoReconcile: false,
      onEvent: (ev) => {
        if (ev.type === "evidence-gate") gates.push({ code: ev.code });
      },
    });

    assert.equal(result.reason, "completed");
    assert.equal(gates.length, 0);
    assert.equal(result.steps, 1);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
