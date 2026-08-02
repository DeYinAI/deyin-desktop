import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EvidenceLedger } from "../../src/evidence/index.js";
import { runAgent } from "../../src/loop.js";
import { PermissionEngine } from "../../src/permissions.js";
import { createBuiltinRegistry } from "../../src/tools/index.js";
import type { AgentMessage } from "../../src/types.js";
import { startMockOpenAI, textResponse, toolCallResponse } from "./helpers.js";

test("E2E: delivery mode full workflow — todos → mutate → verify → sign-off", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-evidence-e2e-"));
  const todos = [
    {
      id: "step-1",
      content: "Implement feature",
      status: "in_progress" as const,
      acceptanceCriteria: "tests pass and file exists",
    },
  ];

  const messages: AgentMessage[] = [
    { role: "system", content: "Delivery agent — follow evidence gates." },
    { role: "user", content: "Ship the feature with verification" },
  ];

  const ledger = new EvidenceLedger();

  const server = await startMockOpenAI((i) => {
    if (i === 0) {
      return toolCallResponse("todo", "todo_write", {
        todos: [{ id: "step-1", content: "Implement feature", status: "in_progress", acceptanceCriteria: "tests pass" }],
      });
    }
    if (i === 1) {
      return toolCallResponse("write", "write", { path: "feature.ts", contents: "export const done = true;\n" });
    }
    if (i === 2) {
      return toolCallResponse("test", "bash", { command: "echo test" });
    }
    if (i === 3) {
      return toolCallResponse("sign", "complete_step", {
        step_id: "step-1",
        verification_command: "echo test",
        diff_summary: "Added feature.ts",
        review_notes: "Looks good",
      });
    }
    if (i === 4) {
      return toolCallResponse("todo_done", "todo_write", {
        todos: [{ id: "step-1", content: "Implement feature", status: "completed", acceptanceCriteria: "tests pass" }],
      });
    }
    return textResponse("Step signed off and delivery complete.");
  });

  try {
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
      maxSteps: 12,
    });

    assert.equal(result.reason, "completed");
    assert.ok(ledger.getMutations().length >= 1);
    assert.ok(ledger.getVerifications().length >= 1);
    assert.ok(ledger.hasSignOffForStep("step-1"));
    assert.ok(ledger.hasSignOffForStep("step-1"));
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E2E: delivery mode blocks completion without sign-off", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-evidence-block-"));
  const todos = [
    { id: "s1", content: "Work", status: "in_progress" as const, acceptanceCriteria: "done" },
  ];
  const ledger = new EvidenceLedger();
  const gateCodes: string[] = [];

  const server = await startMockOpenAI(() => textResponse("All done — implementation complete."));

  try {
    await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages: [
        { role: "system", content: "delivery" },
        { role: "user", content: "finish" },
      ],
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      todos,
      evidenceGatesEnabled: true,
      evidenceLedger: ledger,
      maxSteps: 2,
      onEvent: (e) => {
        if (e.type === "evidence-gate") gateCodes.push(e.code);
      },
    });

    assert.ok(gateCodes.length >= 1);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
