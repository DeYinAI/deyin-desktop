import assert from "node:assert/strict";
import test from "node:test";
import { formatAskQuestionResponse, cancelledAskQuestionPayload } from "../src/interaction.js";

test("formatAskQuestionResponse returns cancellation message", () => {
  const raw = JSON.stringify(cancelledAskQuestionPayload());
  assert.equal(formatAskQuestionResponse(raw), "AskQuestion was cancelled before answers were returned.");
});

test("formatAskQuestionResponse passes through normal answers", () => {
  const raw = JSON.stringify({ q1: "opt-a" });
  assert.equal(formatAskQuestionResponse(raw), raw);
});
