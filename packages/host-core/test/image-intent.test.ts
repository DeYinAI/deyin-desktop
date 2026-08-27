import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectImageGenerationIntent,
  imageGenerationBlockedMessage,
  pickImageModelForGeneration,
} from "../src/image-intent.js";
import type { ModelInfo } from "../src/types.js";

test("detectImageGenerationIntent: recognizes common generation requests", () => {
  assert.deepEqual(detectImageGenerationIntent("generate image of a bird"), { prompt: "generate image of a bird" });
  assert.deepEqual(detectImageGenerationIntent("draw me a cat in watercolor"), {
    prompt: "draw me a cat in watercolor",
  });
  assert.deepEqual(detectImageGenerationIntent("create a picture of a sunset over mountains"), {
    prompt: "create a picture of a sunset over mountains",
  });
  assert.deepEqual(detectImageGenerationIntent("/generate-image red fox in snow"), { prompt: "red fox in snow" });
  assert.deepEqual(detectImageGenerationIntent("show me an illustration of a rocket"), {
    prompt: "show me an illustration of a rocket",
  });
});

test("detectImageGenerationIntent: rejects meta, analysis, and code requests", () => {
  assert.equal(detectImageGenerationIntent("can you generate images?"), null);
  assert.equal(detectImageGenerationIntent("how do image models work?"), null);
  assert.equal(detectImageGenerationIntent("write code to generate images with stable diffusion"), null);
  assert.equal(detectImageGenerationIntent("what is in this image?"), null);
  assert.equal(detectImageGenerationIntent("analyze the attached screenshot"), null);
  assert.equal(detectImageGenerationIntent("explain image generation"), null);
  assert.equal(detectImageGenerationIntent(""), null);
});

test("pickImageModelForGeneration: prefers dedicated text-to-image models", () => {
  const models: ModelInfo[] = [
    { id: "GLM-5.2", name: "GLM", kind: "chat" },
    { id: "SDXL Lightning", name: "SDXL", kind: "image" },
    { id: "Gemini flash-image", name: "Gemini", kind: "chat", imageOutput: true },
  ];
  assert.deepEqual(pickImageModelForGeneration(models), { id: "SDXL Lightning", route: "endpoint" });
});

test("pickImageModelForGeneration: falls back to chat models that draw", () => {
  const models: ModelInfo[] = [
    { id: "GLM-5.2", name: "GLM", kind: "chat" },
    { id: "Gemini flash-image", name: "Gemini", kind: "chat", imageOutput: true },
  ];
  assert.deepEqual(pickImageModelForGeneration(models), { id: "Gemini flash-image", route: "chat" });
});

test("pickImageModelForGeneration: returns undefined when no image models", () => {
  const models: ModelInfo[] = [{ id: "GLM-5.2", name: "GLM", kind: "chat" }];
  assert.equal(pickImageModelForGeneration(models), undefined);
});

test("imageGenerationBlockedMessage: mentions settings", () => {
  assert.match(imageGenerationBlockedMessage(), /Settings → Models/);
});
