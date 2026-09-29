import assert from "node:assert/strict";
import { test } from "node:test";
import { describeEvidenceGate, describeStreamRetry } from "../src/run-notices.js";

const DELIVERY_CODES = ["no_todos", "no_acceptance_criteria", "unsigned_steps", "unverified_mutations", "incomplete_todos"];

test("delivery-mode gates keep the red 'not verifiable yet' reading", () => {
  for (const code of DELIVERY_CODES) {
    const notice = describeEvidenceGate(code, "Cannot finalize: something");
    assert.equal(notice.tone, "error", code);
    assert.equal(notice.text, `Delivery gate (${code}) — step not verifiable yet`, code);
  }
});

test("keep-going nudges are neutral notices, never a delivery-gate failure", () => {
  const cases: Array<[string, string, string]> = [
    ["empty_response", "The model returned an empty response; asked it to continue.", "The model returned an empty response; asked it to continue"],
    [
      "unfinished_turn",
      "The model stopped after announcing an action without doing it; asked it to continue.",
      "The model stopped after announcing an action without doing it; asked it to continue",
    ],
    [
      "output_truncated",
      "The model hit its output-token limit mid-response; asked it to continue.",
      "The model hit its output-token limit mid-response; asked it to continue",
    ],
  ];
  for (const [code, message, expected] of cases) {
    const notice = describeEvidenceGate(code, message);
    assert.equal(notice.tone, "notice", code);
    assert.equal(notice.text, expected, code);
    assert.ok(!/delivery gate/i.test(notice.text), `${code} must not read as a delivery gate`);
  }
});

test("a nudge with no message still says something useful", () => {
  const notice = describeEvidenceGate("empty_response", "");
  assert.equal(notice.tone, "notice");
  assert.ok(notice.text.length > 10);
});

test("open todos, goal and diagnostics nudges say what the host did about it", () => {
  assert.deepEqual(describeEvidenceGate("open_todos", "2 todo(s) still open at turn end."), {
    tone: "notice",
    text: "2 todo(s) still open at turn end — asked the model to finish them",
  });
  assert.deepEqual(describeEvidenceGate("compiler_diagnostics", "3 diagnostic error(s)/warning(s) detected after file changes."), {
    tone: "notice",
    text: "3 diagnostic error(s)/warning(s) detected after file changes — sent to the model to fix",
  });
  // The goal text can be a paragraph long; the timeline line must not quote it.
  const goal = describeEvidenceGate("unverified_goal", `Active goal "${"ship it ".repeat(60)}" has not been reported as met or blocked.`);
  assert.equal(goal.tone, "notice");
  assert.ok(goal.text.length < 120, `goal line should stay short, got ${goal.text.length} chars`);
});

test("loop-guard interventions arrive as loop-guard:<code> and read as notices", () => {
  assert.deepEqual(describeEvidenceGate("loop-guard:no-progress", "no new evidence for 4 rounds — asking for a re-plan"), {
    tone: "notice",
    text: "Loop guard — no new evidence for 4 rounds — asking for a re-plan",
  });
  assert.deepEqual(describeEvidenceGate("loop-guard:storm", ""), { tone: "notice", text: "Loop guard redirected the model" });
});

test("a code from a newer core falls back to the original delivery-gate reading", () => {
  const notice = describeEvidenceGate("some_future_code", "whatever");
  assert.equal(notice.tone, "error");
  assert.equal(notice.text, "Delivery gate (some_future_code) — step not verifiable yet");
});

test("stream retry lines carry the reason, the wait and the attempt count", () => {
  assert.equal(
    describeStreamRetry({ attempt: 2, maxAttempts: 5, reason: "The provider returned HTTP 503", delayMs: 3200 }),
    "The provider returned HTTP 503 — retrying in 3s (2/5)",
  );
});

test("stream retry never says 'in 0s' and tolerates a trailing full stop or empty reason", () => {
  assert.equal(
    describeStreamRetry({ attempt: 1, maxAttempts: 5, reason: "No data from the model for 300s — the connection looks stalled.", delayMs: 100 }),
    "No data from the model for 300s — the connection looks stalled — retrying in 1s (1/5)",
  );
  assert.match(describeStreamRetry({ attempt: 1, maxAttempts: 2, reason: "", delayMs: 1500 }), /^The connection to the model was interrupted — retrying in 2s \(1\/2\)$/);
});
