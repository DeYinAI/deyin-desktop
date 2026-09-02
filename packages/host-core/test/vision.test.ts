import assert from "node:assert/strict";
import test from "node:test";
import { modelSupportsVision } from "../src/models.js";

test("modelSupportsVision: explicit catalog metadata wins", () => {
 assert.equal(modelSupportsVision("GLM-5.2", { vision: true }), true);
 assert.equal(modelSupportsVision("gemini-2.5-pro", { vision: false }), false);
 assert.equal(modelSupportsVision("whatever", { vision: 1 }), true);
 assert.equal(modelSupportsVision("whatever", { vision: "true" }), true);
});

test("modelSupportsVision: capabilities declare vision", () => {
 assert.equal(modelSupportsVision("whatever", { capabilities: ["vision"] }), true);
 assert.equal(modelSupportsVision("whatever", { capabilities: ["text", "image_input"] }), true);
 assert.equal(modelSupportsVision("whatever", { capabilities: ["text"] }), false);
 assert.equal(modelSupportsVision("whatever", { capabilities: { vision: true } }), true);
 assert.equal(modelSupportsVision("whatever", { capabilities: { vision: false } }), false);
});

test("modelSupportsVision: modality metadata declares image input", () => {
 assert.equal(
 modelSupportsVision("GLM-5.2", { architecture: { input_modalities: ["text", "image"] } }),
 true,
 );
 assert.equal(
 modelSupportsVision("GLM-5.2", { architecture: { input_modalities: ["text"] } }),
 false,
 );
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

test("modelSupportsVision: no catalog metadata is NOT assumed vision-capable", () => {
 // The id heuristic is gone: a custom provider's catalog is the only source of
 // truth, and when it says nothing the stored `vision` stays undefined so the
 // client sends images anyway and the provider's own error surfaces instead.
 assert.equal(modelSupportsVision("gpt-4o-mini"), false);
 assert.equal(modelSupportsVision("claude-sonnet-4"), false);
 assert.equal(modelSupportsVision("GLM-4.5V"), false);
 assert.equal(modelSupportsVision("DeepSeek-V4-Pro"), false);
});