import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EvidenceLedger,
  blockPrematureCompletion,
  checkFinalizationReadiness,
  checkMutationReadiness,
  commandsMatch,
} from "../src/evidence/index.js";
import { completeStepTool } from "../src/tools/complete-step.js";
import type { TodoItem, ToolContext } from "../src/types.js";

test("EvidenceLedger tracks mutations from write tools", () => {
  const ledger = new EvidenceLedger();
  ledger.observeToolCall("write", { path: "src/a.ts" }, true);
  assert.equal(ledger.getMutations().length, 1);
  assert.equal(ledger.getMutations()[0]?.toolName, "write");
  assert.deepEqual(ledger.getMutations()[0]?.paths, ["src/a.ts"]);
});

test("EvidenceLedger classifies bash verification vs mutation", () => {
  const ledger = new EvidenceLedger();
  ledger.observeToolCall("bash", { command: "npm test" }, true);
  ledger.observeToolCall("bash", { command: "echo hello" }, true);
  assert.equal(ledger.getVerifications().length, 1);
  assert.equal(ledger.getMutations().length, 1);
});

test("EvidenceLedger persists across snapshot round-trip", () => {
  const ledger = new EvidenceLedger();
  ledger.recordMutation({ toolName: "edit", paths: ["x.ts"] });
  ledger.recordVerification({ command: "npm test" });
  ledger.recordToolCall({ toolName: "bash", timestamp: Date.now(), command: "npm test", ok: true });
  const restored = EvidenceLedger.fromSnapshot(ledger.toSnapshot());
  assert.equal(restored.getMutations().length, 1);
  assert.equal(restored.getVerifications().length, 1);
  assert.ok(restored.hasRecentVerification("npm test"));
});

test("commandsMatch accepts substring equivalence", () => {
  assert.ok(commandsMatch("npm test --runInBand", "npm test"));
  assert.ok(commandsMatch("npm test", "npm test"));
  assert.ok(!commandsMatch("npm run lint", "npm test"));
});

test("checkMutationReadiness rejects empty todos", () => {
  const gate = checkMutationReadiness([]);
  assert.equal(gate.ok, false);
  assert.equal(gate.code, "no_todos");
});

test("checkMutationReadiness rejects todos without acceptance criteria", () => {
  const gate = checkMutationReadiness([{ id: "1", content: "Ship", status: "pending" }]);
  assert.equal(gate.ok, false);
  assert.equal(gate.code, "no_acceptance_criteria");
});

test("checkMutationReadiness passes when criteria exist", () => {
  const gate = checkMutationReadiness([
    { id: "1", content: "Ship", status: "pending", acceptanceCriteria: "npm test passes" },
  ]);
  assert.equal(gate.ok, true);
});

test("checkFinalizationReadiness requires sign-offs", () => {
  const ledger = new EvidenceLedger();
  ledger.recordMutation({ toolName: "write", paths: ["a.ts"] });
  const todos: TodoItem[] = [
    { id: "s1", content: "Implement", status: "in_progress", acceptanceCriteria: "tests pass" },
  ];
  const gate = checkFinalizationReadiness(todos, ledger);
  assert.equal(gate.ok, false);
  assert.equal(gate.code, "unsigned_steps");
});

test("checkFinalizationReadiness passes when all steps signed off and completed", () => {
  const ledger = new EvidenceLedger();
  ledger.recordMutation({ toolName: "write", paths: ["a.ts"] });
  ledger.recordToolCall({ toolName: "bash", timestamp: Date.now(), command: "npm test", ok: true });
  ledger.recordSignOff({
    stepId: "s1",
    verificationCommand: "npm test",
    diffSummary: "Added feature",
  });
  const todos: TodoItem[] = [
    { id: "s1", content: "Implement", status: "completed", acceptanceCriteria: "tests pass", signedOff: true },
  ];
  const gate = checkFinalizationReadiness(todos, ledger);
  assert.equal(gate.ok, true);
});

test("blockPrematureCompletion catches done language without evidence", () => {
  const ledger = new EvidenceLedger();
  const todos: TodoItem[] = [{ id: "s1", content: "Work", status: "pending", acceptanceCriteria: "lint" }];
  const gate = blockPrematureCompletion("All done — the task is complete.", todos, ledger);
  assert.equal(gate.ok, false);
});

function toolCtx(todos: TodoItem[], ledger: EvidenceLedger): ToolContext {
  return { cwd: process.cwd(), todos, evidenceLedger: ledger };
}

test("complete_step validates verification ran recently", async () => {
  const ledger = new EvidenceLedger();
  ledger.recordMutation({ toolName: "write", paths: ["a.ts"] });
  const todos: TodoItem[] = [{ id: "s1", content: "Ship", status: "in_progress", acceptanceCriteria: "tests" }];
  const missing = await completeStepTool.execute(
    { step_id: "s1", verification_command: "npm test", diff_summary: "Added a.ts" },
    toolCtx(todos, ledger),
  );
  assert.match(missing, /verification_command not found/);

  ledger.recordToolCall({ toolName: "bash", timestamp: Date.now(), command: "npm test", ok: true });
  const ok = await completeStepTool.execute(
    { step_id: "s1", verification_command: "npm test", diff_summary: "Added a.ts", review_notes: "LGTM" },
    toolCtx(todos, ledger),
  );
  assert.match(ok, /signed off/i);
  assert.equal(todos[0]?.signedOff, true);
  assert.ok(ledger.hasSignOffForStep("s1"));
});

test("complete_step rejects missing step_id", async () => {
  const ledger = new EvidenceLedger();
  ledger.recordToolCall({ toolName: "bash", timestamp: Date.now(), command: "npm test", ok: true });
  const result = await completeStepTool.execute(
    { step_id: "missing", verification_command: "npm test", diff_summary: "n/a" },
    toolCtx([], ledger),
  );
  assert.match(result, /not found/);
});

test("complete_step rejects duplicate sign-off", async () => {
  const ledger = new EvidenceLedger();
  ledger.recordMutation({ toolName: "write", paths: ["a.ts"] });
  ledger.recordToolCall({ toolName: "bash", timestamp: Date.now(), command: "npm test", ok: true });
  ledger.recordSignOff({ stepId: "s1", verificationCommand: "npm test", diffSummary: "done" });
  const todos: TodoItem[] = [{ id: "s1", content: "Ship", status: "in_progress", acceptanceCriteria: "tests" }];
  const result = await completeStepTool.execute(
    { step_id: "s1", verification_command: "npm test", diff_summary: "again" },
    toolCtx(todos, ledger),
  );
  assert.match(result, /already signed off/);
});
