import assert from "node:assert/strict";
import { test } from "node:test";
import { takeoverOutcome, takeoverRequest } from "../src/main/bots/takeover.js";

test("the card asks one question with the reason, and a way to say done and a way to say no", () => {
  const request = takeoverRequest("Solve the captcha on github.com");
  assert.equal(request.type, "ask-question");
  assert.equal(request.questions.length, 1);
  const [question] = request.questions;
  assert.equal(question?.prompt, "Solve the captcha on github.com");
  assert.equal(question?.allow_multiple, undefined);
  assert.deepEqual(question?.options.map((option) => option.id), ["done", "declined"]);
  assert.equal(question?.options[0]?.recommended, true);
  assert.equal(question?.options[1]?.recommended, undefined);
});

test("only a plain done is done", () => {
  assert.equal(takeoverOutcome(JSON.stringify({ takeover: "done" })), "done");
  assert.equal(takeoverOutcome(JSON.stringify({ takeover: "declined" })), "declined");
  assert.equal(takeoverOutcome(JSON.stringify({ takeover: "other:maybe" })), "declined");
  assert.equal(takeoverOutcome(JSON.stringify({ takeover: ["done"] })), "declined");
  assert.equal(takeoverOutcome(JSON.stringify({ somethingElse: "done" })), "declined");
  assert.equal(takeoverOutcome(JSON.stringify({ __cancelled: "AskQuestion was cancelled before answers were returned." })), "declined");
});

test("a reply that is not an answer is a no, not a crash", () => {
  for (const reply of ["", "AskQuestion timed out before answers were returned.", "null", "[]", '"done"', "42", "{"]) {
    assert.equal(takeoverOutcome(reply), "declined", reply);
  }
});
