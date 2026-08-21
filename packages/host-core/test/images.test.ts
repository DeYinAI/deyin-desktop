import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyModelKinds, generateImages, isImageModel, modelEmitsImages, modelImageCapability } from "../src/images.js";
import { ImageStore, imageDataUrl } from "../src/host/image-store.js";

/** 1x1 transparent PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("isImageModel: catalog metadata wins over the heuristic", () => {
  assert.equal(isImageModel("some-house-model", { type: "image" }), true);
  assert.equal(isImageModel("some-house-model", { output_modalities: ["image"] }), true);
  assert.equal(isImageModel("some-house-model", { capabilities: ["text-to-image"] }), true);
  assert.equal(isImageModel("some-house-model", { type: "chat" }), false);
  // Text *and* image output is a chat model that draws, not an endpoint model.
  assert.equal(isImageModel("some-house-model", { output_modalities: ["text", "image"] }), false);
  assert.equal(modelEmitsImages("some-house-model", { output_modalities: ["text", "image"] }), true);
});

test("modelImageCapability: reads OpenRouter architecture blocks", () => {
  assert.equal(
    modelImageCapability("house/model", { architecture: { output_modalities: ["text", "image"], input_modalities: ["text", "image"] } }),
    "chat",
  );
  assert.equal(modelImageCapability("house/drawer", { architecture: { modality: "text->image" } }), "endpoint");
  assert.equal(modelImageCapability("house/vision", { architecture: { modality: "text+image->text" } }), "none");
  assert.equal(
    modelImageCapability("house/both", { architecture: { modality: "text+image->text+image" } }),
    "chat",
  );
});

test("modelImageCapability: explicit text-only metadata beats a suggestive id", () => {
  // A catalog that describes its outputs is trusted over the id heuristic.
  assert.equal(modelImageCapability("acme-flux-chat", { output_modalities: ["text"] }), "none");
  assert.equal(modelImageCapability("acme-flux-chat"), "endpoint");
});

test("modelImageCapability: chat models that draw are recognized by id", () => {
  for (const id of ["gemini-2.5-flash-image", "google/nano-banana", "some-image-preview"]) {
    assert.equal(modelImageCapability(id), "chat", `${id} should draw in chat`);
  }
  for (const id of ["gemini-2.5-flash", "gpt-5", "claude-sonnet-4"]) {
    assert.equal(modelImageCapability(id), "none", `${id} should not draw`);
  }
});

test("isImageModel: heuristic recognizes known text-to-image families", () => {
  for (const id of ["SDXL Lightning", "SDXL Base 1.0", "stable-diffusion-xl", "flux-schnell", "dall-e-3", "playground-v2.5", "qwen-image"]) {
    assert.equal(isImageModel(id), true, `${id} should be an image model`);
  }
});

test("isImageModel: heuristic leaves chat models alone", () => {
  for (const id of ["GLM-5.2", "DeepSeek-V4-Pro", "Kimi-K3", "Qwen-Max", "gpt-5", "claude-sonnet-4", "qwen2.5-vl-72b"]) {
    assert.equal(isImageModel(id), false, `${id} should not be an image model`);
  }
});

test("generateImages: reads OpenAI b64_json responses", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ data: [{ b64_json: PNG, revised_prompt: "a fox, cinematic" }] }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    const images = await generateImages({
      apiBaseUrl: "https://api.example.com/v1",
      token: "t",
      model: "SDXL Lightning",
      prompt: "a fox",
      size: "1024x1024",
    });
    assert.equal(images.length, 1);
    assert.equal(images[0]?.base64, PNG);
    assert.equal(images[0]?.mediaType, "image/png");
    assert.equal(images[0]?.revisedPrompt, "a fox, cinematic");
    assert.equal(calls[0]?.url, "https://api.example.com/v1/images/generations");
    assert.equal(calls[0]?.body.model, "SDXL Lightning");
  } finally {
    globalThis.fetch = original;
  }
});

test("generateImages: retries without response_format when the provider rejects it", async () => {
  const bodies: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    if ("response_format" in body) {
      return new Response(JSON.stringify({ error: { message: "Unknown parameter: response_format" } }), { status: 400 });
    }
    // Cloudflare-style envelope with a bare data URI.
    return new Response(JSON.stringify({ result: { image: `data:image/jpeg;base64,${PNG}` } }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    const images = await generateImages({ apiBaseUrl: "https://x/v1", token: "t", model: "flux", prompt: "hi" });
    assert.equal(bodies.length, 2);
    assert.equal("response_format" in (bodies[1] ?? {}), false);
    assert.equal(images[0]?.mediaType, "image/jpeg");
    assert.equal(images[0]?.base64, PNG);
  } finally {
    globalThis.fetch = original;
  }
});

test("generateImages: surfaces the provider error message", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "model not enabled on your plan" } }), { status: 403 })) as unknown as typeof fetch;
  try {
    await assert.rejects(
      generateImages({ apiBaseUrl: "https://x/v1", token: "t", model: "sdxl", prompt: "hi" }),
      /model not enabled on your plan \(HTTP 403\)/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("ImageStore: round-trips an image and rejects path traversal", () => {
  const store = new ImageStore(mkdtempSync(join(tmpdir(), "deyin-images-")));
  const saved = store.save("thread-1", { base64: PNG, mediaType: "image/png" });
  assert.ok(saved.file.endsWith(".png"));
  const read = store.read("thread-1", saved.file);
  assert.equal(read.base64, PNG);
  assert.equal(imageDataUrl(read), `data:image/png;base64,${PNG}`);
  assert.deepEqual(store.list("thread-1"), [saved.file]);
  assert.throws(() => store.read("thread-1", "../escape.png"), /Invalid image file name/);
  assert.throws(() => store.read("../..", "x.png"), /Invalid thread id/);
  assert.throws(() => store.read("thread-1", "missing.png"), /Image not found/);
});

test("classifyModelKinds: backfills kind on catalogs cached before classification", () => {
  const classified = classifyModelKinds([
    { id: "SDXL Lightning", name: "SDXL Lightning" },
    { id: "GLM-5.2", name: "GLM-5.2" },
    { id: "house-image-model", name: "house", kind: "image" as const },
    { id: "gemini-2.5-flash-image", name: "flash image" },
  ]);
  assert.deepEqual(classified.map((m) => m.kind), ["image", "chat", "image", "chat"]);
  assert.deepEqual(classified.map((m) => m.imageOutput), [false, false, false, true]);
});
