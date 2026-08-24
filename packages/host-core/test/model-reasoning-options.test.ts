import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_REASONING_MODES,
  getModelReasoningOptions,
  parseModelReasoningMeta,
  reasoningModeLabel,
} from "../src/model-reasoning.js";

test("parseModelReasoningMeta reads supported_efforts from catalog", () => {
  assert.deepEqual(
    parseModelReasoningMeta({
      reasoning: {
        supported_efforts: ["high", "medium", "low", "minimal"],
        mandatory: true,
      },
    }),
    {
      supportedEfforts: ["high", "medium", "low", "minimal"],
      mandatory: true,
    },
  );
});

test("parseModelReasoningMeta falls back to supported_parameters", () => {
  assert.deepEqual(parseModelReasoningMeta({ supported_parameters: ["temperature", "reasoning_effort"] }), {
    supportedEfforts: null,
  });
});

test("getModelReasoningOptions uses catalog efforts when present", () => {
  const options = getModelReasoningOptions({
    reasoning: { supportedEfforts: ["max", "high", "medium", "low", "none"] },
  });
  assert.deepEqual(
    options.map((o) => o.id),
    ["max", "high", "medium", "low", "off"],
  );
});

test("getModelReasoningOptions falls back to default list with Max", () => {
  assert.deepEqual(
    getModelReasoningOptions(undefined).map((o) => o.id),
    DEFAULT_REASONING_MODES.map((m) => m.id),
  );
  assert.ok(DEFAULT_REASONING_MODES.some((m) => m.id === "max"));
});

test("getModelReasoningOptions hides Off when reasoning is mandatory", () => {
  const options = getModelReasoningOptions({
    reasoning: { supportedEfforts: ["high", "medium", "low", "none"], mandatory: true },
  });
  assert.deepEqual(
    options.map((o) => o.id),
    ["high", "medium", "low"],
  );
});

test("reasoningModeLabel includes Max label", () => {
  assert.equal(
    reasoningModeLabel(
      { thinking: true, modelEfforts: { "openference::GLM-5.2": "max" } },
      "openference",
      "GLM-5.2",
    ),
    "Max",
  );
});
