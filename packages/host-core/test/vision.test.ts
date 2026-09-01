import assert from "node:assert/strict";
import test from "node:test";
import { modelSupportsVision, visionCapability } from "../src/models.js";

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

test("modelSupportsVision: OpenRouter architecture.input_modalities declares image input", () => {
  assert.equal(
    modelSupportsVision("GLM-5.2", { architecture: { input_modalities: ["text", "image"] } }),
    true,
  );
  assert.equal(
    modelSupportsVision("GLM-5.2", { architecture: { input_modalities: ["text"] } }),
    false,
  );
});

test("modelSupportsVision: top-level input_modalities declares image input", () => {
  assert.equal(modelSupportsVision("DeepSeek-V4-Pro", { input_modalities: ["image", "text"] }), true);
  assert.equal(modelSupportsVision("DeepSeek-V4-Pro", { input_modalities: ["text"] }), false);
});

test("modelSupportsVision: arrow-form modality strings count image inputs", () => {
  assert.equal(modelSupportsVision("GLM-5.2", { modality: "text+image->text" }), true);
  assert.equal(modelSupportsVision("GLM-5.2", { modalities: ["text+image->text"] }), true);
  assert.equal(modelSupportsVision("GLM-5.2", { modality: "text->text" }), false);
  assert.equal(modelSupportsVision("GLM-5.2", { modality: "text->image" }), false, "output-only image is not vision");
});

test("modelSupportsVision: explicit vision:false outranks modality metadata", () => {
  assert.equal(
    modelSupportsVision("whatever", { vision: false, architecture: { input_modalities: ["image"] } }),
    false,
  );
});

test("visionCapability: known metadata is preserved, unknown stays undefined", () => {
  assert.equal(visionCapability("GLM-5.2", { vision: true }), true);
  assert.equal(visionCapability("gemini-2.5-pro", { vision: false }), false);
  assert.equal(visionCapability("whatever", { architecture: { input_modalities: ["text", "image"] } }), true);
  // No metadata and no id match: the old code stored a fabricated false that
  // blocked image sends on third-party providers; unknown lets the API decide.
  assert.equal(visionCapability("DeepSeek-V4-Pro"), undefined);
  assert.equal(visionCapability("Kimi-K3", { capabilities: ["text"] }), false);
});
