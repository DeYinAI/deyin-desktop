import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultImageModelParams,
  imageParamsToExtra,
  pickImageModelParamsRecord,
  resolveImageModelParams,
} from "../src/image-model-params.js";

test("defaultImageModelParams: lightning vs base step counts", () => {
  assert.equal(defaultImageModelParams("SDXL Lightning").numSteps, 4);
  assert.equal(defaultImageModelParams("SDXL Base 1.0").numSteps, 20);
});

test("imageParamsToExtra maps camelCase settings to OpenAI body fields", () => {
  assert.deepEqual(
    imageParamsToExtra({
      negativePrompt: "blur",
      numSteps: 20,
      guidance: 7.5,
      seed: 42,
      strength: 0.35,
    }),
    {
      negative_prompt: "blur",
      num_steps: 20,
      guidance: 7.5,
      seed: 42,
      strength: 0.35,
    },
  );
});

test("pickImageModelParamsRecord clamps and sanitizes saved settings", () => {
  const parsed = pickImageModelParamsRecord({
    "openference::SDXL Base 1.0": {
      numSteps: 99,
      guidance: 8,
      negativePrompt: " bad ",
      strength: 1.5,
    },
  });
  assert.deepEqual(parsed["openference::SDXL Base 1.0"], {
    numSteps: 20,
    guidance: 8,
    negativePrompt: "bad",
    strength: 1,
  });
});

test("resolveImageModelParams merges saved overrides with model defaults", () => {
  const resolved = resolveImageModelParams("SDXL Base 1.0", { guidance: 8.5 });
  assert.equal(resolved.numSteps, 20);
  assert.equal(resolved.guidance, 8.5);
  assert.ok(resolved.negativePrompt?.includes("blurry"));
});
