import assert from "node:assert/strict";
import test from "node:test";
import { modelSupportsVision } from "../src/models.js";

test("modelSupportsVision: explicit catalog metadata wins over the heuristic", () => {
  assert.equal(modelSupportsVision("GLM-5.2", { vision: true }), true);
  assert.equal(modelSupportsVision("gemini-2.5-pro", { vision: false }), false);
  assert.equal(modelSupportsVision("whatever", { capabilities: ["vision"] }), true);
  assert.equal(modelSupportsVision("whatever", { capabilities: ["text"] }), false);
  assert.equal(modelSupportsVision("whatever", { capabilities: { vision: true } }), true);
});

test("modelSupportsVision: heuristic recognizes known vision families", () => {
  for (const id of ["GLM-4.5V", "glm-4v", "qwen2.5-vl-72b", "gpt-4o-mini", "gpt-4.1", "gpt-5", "gemini-2.5-flash", "claude-sonnet-4", "pixtral-large", "grok-4"]) {
    assert.equal(modelSupportsVision(id), true, `${id} should be vision-capable`);
  }
});

test("modelSupportsVision: heuristic rejects known text-only models", () => {
  for (const id of ["GLM-5.2", "DeepSeek-V4-Pro", "Kimi-K3", "Qwen-Max", "llama-3.2-3b", "o3-mini-typo"]) {
    assert.equal(modelSupportsVision(id), false, `${id} should not be vision-capable`);
  }
});
