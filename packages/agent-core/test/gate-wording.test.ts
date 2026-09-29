import assert from "node:assert/strict";
import { test } from "node:test";
import { describeEvidenceGate } from "@deyin/host-core/shared";
import { EvidenceLedger, checkFinalizationReadiness, checkMutationReadiness, type GateResult } from "../src/evidence/index.js";
import type { TodoItem } from "../src/types.js";

/**
 * The renderers and the CLI word `evidence-gate` events with a code list kept in
 * host-core (it cannot import agent-core). These tests fail if the core starts
 * emitting a delivery-mode code that the wording does not know, which would
 * silently downgrade a blocking gate to a neutral notice.
 */

const todo = (overrides: Partial<TodoItem> = {}): TodoItem => ({
  id: "t1",
  content: "Fix the loader",
  status: "in_progress",
  ...overrides,
});

function deliveryGateFailures(): GateResult[] {
  const unsigned = new EvidenceLedger();

  const withUnverifiedMutation = new EvidenceLedger();
  withUnverifiedMutation.recordMutation({ toolName: "edit", paths: ["src/a.ts"], stepId: "t1" });

  return [
    checkMutationReadiness([]),
    checkMutationReadiness([todo()]),
    checkFinalizationReadiness([], unsigned),
    checkFinalizationReadiness([todo()], unsigned),
    checkFinalizationReadiness([todo({ signedOff: true })], withUnverifiedMutation),
    checkFinalizationReadiness([todo({ signedOff: true, status: "in_progress" })], unsigned),
  ];
}

test("every delivery-mode gate the core can raise is worded as a blocking gate", () => {
  const failures = deliveryGateFailures();
  assert.ok(failures.every((f) => !f.ok), "fixtures must all be failing gates");

  const codes = failures.map((f) => f.code);
  assert.deepEqual(
    [...new Set(codes)].sort(),
    ["incomplete_todos", "no_acceptance_criteria", "no_todos", "unsigned_steps", "unverified_mutations"],
    "the fixtures should cover every delivery gate code",
  );

  for (const failure of failures) {
    const notice = describeEvidenceGate(failure.code, failure.message);
    assert.equal(notice.tone, "error", `${failure.code} blocks delivery and must keep the error treatment`);
    assert.match(notice.text, /^Delivery gate \(/);
  }
});
