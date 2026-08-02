import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EvidenceLedger } from "../src/evidence/index.js";
import { runAgent } from "../src/loop.js";
import { PermissionEngine } from "../src/permissions.js";
import { createBuiltinRegistry } from "../src/tools/index.js";
import type { AgentMessage } from "../src/types.js";
import { startMockOpenAI, textResponse, toolCallResponse } from "./helpers/mock-openai.js";

test("delivery mode blocks write without todos", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-evidence-"));
  writeFileSync(join(cwd, "hello.txt"), "hi");
  const server = await startMockOpenAI((i) =>
    i === 0 ? toolCallResponse("call_w", "write", { path: "out.txt", contents: "x" }) : textResponse("ok"),
  );

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "delivery agent" },
      { role: "user", content: "write a file" },
    ];
    const ledger = new EvidenceLedger();
    const gateEvents: string[] = [];
    await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      evidenceGatesEnabled: true,
      evidenceLedger: ledger,
      onEvent: (e) => {
        if (e.type === "evidence-gate") gateEvents.push(e.code);
      },
    });
    assert.ok(gateEvents.includes("no_todos"));
    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg && toolMsg.role === "tool" && toolMsg.content.includes("delivery gate"));
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("delivery mode allows mutation after todos with acceptance criteria", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-evidence-2-"));
  const server = await startMockOpenAI((i) => {
    if (i === 0) {
      return toolCallResponse("call_todo", "todo_write", {
        todos: [{ id: "s1", content: "Write file", status: "in_progress", acceptanceCriteria: "file exists" }],
      });
    }
    if (i === 1) return toolCallResponse("call_w", "write", { path: "out.txt", contents: "done" });
    return textResponse("written");
  });

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "delivery agent" },
      { role: "user", content: "write out.txt" },
    ];
    const ledger = new EvidenceLedger();
    const todos = [{ id: "s1", content: "Write file", status: "in_progress" as const, acceptanceCriteria: "file exists" }];
    await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      todos,
      evidenceGatesEnabled: true,
      evidenceLedger: ledger,
    });
    assert.ok(ledger.getMutations().length >= 1);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("delivery mode blocks premature completion text", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-evidence-3-"));
  const server = await startMockOpenAI(() => textResponse("All done — the implementation is complete."));

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "delivery agent" },
      { role: "user", content: "finish the task" },
    ];
    const ledger = new EvidenceLedger();
    const todos = [{ id: "s1", content: "Work", status: "pending" as const, acceptanceCriteria: "tests pass" }];
    let gateCount = 0;
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      todos,
      evidenceGatesEnabled: true,
      evidenceLedger: ledger,
      maxSteps: 3,
      onEvent: (e) => {
        if (e.type === "evidence-gate") gateCount += 1;
      },
    });
    assert.ok(gateCount >= 1);
    assert.equal(result.reason, "max-steps");
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
