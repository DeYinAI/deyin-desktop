import assert from "node:assert/strict";
import test from "node:test";
import { resolveVisionModel, visionBlockedMessage } from "../src/vision.js";
import type { ModelInfo } from "@deyin/contract";

const MODELS: ModelInfo[] = [
  { id: "GLM-5.2", name: "GLM-5.2", vision: false },
  { id: "GLM-4.5V", name: "GLM-4.5V", vision: true },
  { id: "DeepSeek-V4-Pro", name: "DeepSeek-V4-Pro", vision: false },
];

test("vision routing: vision-capable selection passes through", () => {
  assert.deepEqual(resolveVisionModel(MODELS, "GLM-4.5V"), { model: "GLM-4.5V" });
});

test("vision routing: auto-route off keeps text-only selection as blocked", () => {
  assert.equal(resolveVisionModel(MODELS, "GLM-5.2", { autoRoute: false }), null);
});

test("vision routing: auto-route on switches to the first vision model in the plan", () => {
  assert.deepEqual(resolveVisionModel(MODELS, "GLM-5.2", { autoRoute: true }), {
    model: "GLM-4.5V",
    routedTo: "GLM-4.5V",
  });
});

test("vision routing: no vision model in the plan returns null (friendly error)", () => {
  const textOnly: ModelInfo[] = [
    { id: "GLM-5.2", name: "GLM-5.2", vision: false },
    { id: "Kimi-K3", name: "Kimi K3" },
  ];
  assert.equal(resolveVisionModel(textOnly, "GLM-5.2", { autoRoute: true }), null);
});

test("vision routing: unknown capabilities keep the selection (API decides)", () => {
  const unknown: ModelInfo[] = [{ id: "Kimi-K3", name: "Kimi K3" }];
  assert.deepEqual(resolveVisionModel(unknown, "Kimi-K3"), { model: "Kimi-K3" });
});

test("vision routing: unknown selected model keeps the selection", () => {
  assert.deepEqual(resolveVisionModel(MODELS, "not-in-list"), { model: "not-in-list" });
});

test("vision blocked message mentions local vision plugin on desktop", () => {
  assert.match(visionBlockedMessage({ localVisionAvailable: true }), /Local Vision/);
  assert.match(visionBlockedMessage({ localVisionAvailable: true }), /moondream/);
});

test("vision blocked message omits local vision on web", () => {
  const msg = visionBlockedMessage({ localVisionAvailable: false });
  assert.doesNotMatch(msg, /Local Vision/);
  assert.match(msg, /Auto route to cloud vision/);
});
