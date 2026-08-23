import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatStoredModelRef,
  getModelReasoningMode,
  modelEffortKey,
  parseStoredModelRef,
  resolveModelReasoning,
} from "../src/model-reasoning.js";

test("resolveModelReasoning honors per-model overrides", () => {
  const key = modelEffortKey("openference", "GLM-5.2");
  const base = { thinking: true, modelEfforts: { [key]: "high" } as Record<string, string> };

  assert.deepEqual(resolveModelReasoning(base, "openference", "GLM-5.2"), {
    thinking: true,
    effort: "high",
  });
  assert.deepEqual(resolveModelReasoning(base, "openference", "Other"), { thinking: true });
  assert.deepEqual(
    resolveModelReasoning({ ...base, modelEfforts: { [key]: "off" } }, "openference", "GLM-5.2"),
    { thinking: false },
  );
  assert.deepEqual(
    resolveModelReasoning({ thinking: false, modelEfforts: {} }, "openference", "GLM-5.2"),
    { thinking: false },
  );
});

test("getModelReasoningMode ignores invalid stored values", () => {
  const settings = {
    modelEfforts: { [modelEffortKey("openai", "gpt-4.1")]: "turbo" },
    thinking: true,
  };
  assert.equal(getModelReasoningMode(settings, "openai", "gpt-4.1"), undefined);
});

test("parseStoredModelRef splits provider and model ids", () => {
  assert.deepEqual(parseStoredModelRef("openference::DeepSeek-V4-Pro"), {
    providerId: "openference",
    modelId: "DeepSeek-V4-Pro",
  });
  assert.deepEqual(parseStoredModelRef("GLM-5.2"), { providerId: "openference", modelId: "GLM-5.2" });
  assert.equal(parseStoredModelRef(""), null);
});

test("formatStoredModelRef round-trips parseStoredModelRef", () => {
  const ref = formatStoredModelRef("ollama", "qwen");
  assert.deepEqual(parseStoredModelRef(ref), { providerId: "ollama", modelId: "qwen" });
});
