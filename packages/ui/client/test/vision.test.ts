import assert from "node:assert/strict";
import test from "node:test";
import { resolveVisionModel } from "../src/vision.js";
import type { ModelInfo } from "@deyin/contract";

const MODELS: ModelInfo[] = [
  { id: "GLM-5.2", name: "GLM-5.2", vision: false },
  { id: "GLM-4.5V", name: "GLM-4.5V", vision: true },
  { id: "DeepSeek-V4-Pro", name: "DeepSeek-V4-Pro", vision: false },
];

test("vision routing: vision-capable selection passes through", () => {
  assert.deepEqual(resolveVisionModel(MODELS, "GLM-4.5V"), { model: "GLM-4.5V" });
});

test("vision routing: auto-route off keeps the selection — the provider decides", () => {
  assert.deepEqual(resolveVisionModel(MODELS, "GLM-5.2", { autoRoute: false }), { model: "GLM-5.2" });
});

test("vision routing: auto-route on switches to the first vision model in the plan", () => {
  assert.deepEqual(resolveVisionModel(MODELS, "GLM-5.2", { autoRoute: true }), {
    model: "GLM-4.5V",
    routedTo: "GLM-4.5V",
  });
});

test("vision routing: no vision model in the plan keeps the selection (never blocks)", () => {
  const textOnly: ModelInfo[] = [
    { id: "GLM-5.2", name: "GLM-5.2", vision: false },
    { id: "Kimi-K3", name: "Kimi K3" },
  ];
  assert.deepEqual(resolveVisionModel(textOnly, "GLM-5.2", { autoRoute: true }), { model: "GLM-5.2" });
});

test("vision routing: unknown capabilities keep the selection (API decides)", () => {
  const unknown: ModelInfo[] = [{ id: "Kimi-K3", name: "Kimi K3" }];
  assert.deepEqual(resolveVisionModel(unknown, "Kimi-K3"), { model: "Kimi-K3" });
});

test("vision routing: unknown selected model keeps the selection", () => {
  assert.deepEqual(resolveVisionModel(MODELS, "not-in-list"), { model: "not-in-list" });
});
