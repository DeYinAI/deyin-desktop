import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createImageBridge, pickImageModel, storeAttachedImages } from "../src/host/image-bridge.js";
import { ImageStore } from "../src/host/image-store.js";

/** 1x1 transparent PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function sandbox(): { store: ImageStore; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-bridge-"));
  return { store: new ImageStore(join(cwd, ".images")), cwd };
}

/** Swap global fetch for the duration of one call, recording every request. */
async function withFetch<T>(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  run: (calls: { url: string; init: RequestInit }[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return await handler(String(url), init);
  }) as unknown as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("pickImageModel: routes by capability and honours an explicit id", () => {
  const models = [
    { id: "flux-schnell", route: "endpoint" as const },
    { id: "gemini-2.5-flash-image", route: "chat" as const },
  ];
  assert.equal(pickImageModel(models, {})?.id, "flux-schnell");
  // Editing prefers a chat model that draws: those keep the source picture.
  assert.equal(pickImageModel(models, { editing: true })?.id, "gemini-2.5-flash-image");
  assert.equal(pickImageModel(models, { requested: "gemini-2.5-flash-image" })?.route, "chat");
  // An id the catalog never listed is still classified rather than refused.
  assert.deepEqual(pickImageModel(models, { requested: "dall-e-3" }), { id: "dall-e-3", route: "endpoint" });
  assert.equal(pickImageModel([], {}), undefined);
});

test("generate: endpoint models post to /images/generations and store the result", async () => {
  const { store, cwd } = sandbox();
  const bridge = createImageBridge({
    store,
    threadId: "t1",
    apiBaseUrl: "https://api.test/v1",
    getToken: async () => "tok",
    models: () => [{ id: "flux-schnell", route: "endpoint" }],
    cwd,
  });
  await withFetch(
    () => jsonResponse({ data: [{ b64_json: PNG }] }),
    async (calls) => {
      const [image] = await bridge.generate({ prompt: "a fox", saveTo: "assets/fox.png" });
      assert.ok(calls[0]?.url.endsWith("/images/generations"));
      assert.equal(image?.model, "flux-schnell");
      assert.equal(store.read("t1", image!.file).base64, PNG);
      // save_to also drops the picture into the workspace for the repo to keep.
      assert.equal(readFileSync(join(cwd, "assets/fox.png")).toString("base64"), PNG);
    },
  );
});

test("generate: chat models that draw go through /chat/completions", async () => {
  const { store, cwd } = sandbox();
  const bridge = createImageBridge({
    store,
    threadId: "t1",
    apiBaseUrl: "https://api.test/v1",
    getToken: async () => "tok",
    models: () => [{ id: "gemini-2.5-flash-image", route: "chat" }],
    cwd,
  });
  await withFetch(
    () =>
      jsonResponse({
        choices: [{ message: { content: "here", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }] } }],
      }),
    async (calls) => {
      const [image] = await bridge.generate({ prompt: "a fox" });
      assert.ok(calls[0]?.url.endsWith("/chat/completions"));
      const body = JSON.parse(String(calls[0]?.init.body)) as { modalities?: string[] };
      assert.deepEqual(body.modalities, ["text", "image"]);
      assert.equal(store.read("t1", image!.file).base64, PNG);
    },
  );
});

test("generate: input images route to the edit endpoint as multipart", async () => {
  const { store, cwd } = sandbox();
  const source = store.save("t1", { base64: PNG, mediaType: "image/png" });
  const bridge = createImageBridge({
    store,
    threadId: "t1",
    apiBaseUrl: "https://api.test/v1",
    getToken: async () => "tok",
    models: () => [{ id: "gpt-image-1", route: "endpoint" }],
    cwd,
  });
  await withFetch(
    () => jsonResponse({ data: [{ b64_json: PNG }] }),
    async (calls) => {
      await bridge.generate({ prompt: "at night", inputImages: [source.file] });
      assert.ok(calls[0]?.url.endsWith("/images/edits"));
      const form = calls[0]?.init.body as FormData;
      assert.equal(form.get("prompt"), "at night");
      assert.ok(form.get("image") instanceof Blob);
    },
  );
});

test("generate: a missing image model explains what to do", async () => {
  const { store, cwd } = sandbox();
  const bridge = createImageBridge({
    store,
    threadId: "t1",
    apiBaseUrl: "https://api.test/v1",
    getToken: async () => "tok",
    models: () => [],
    cwd,
  });
  await assert.rejects(() => bridge.generate({ prompt: "a fox" }), /No image model is available/);
});

test("generate: workspace paths outside the sandbox are refused", async () => {
  const { store, cwd } = sandbox();
  const bridge = createImageBridge({
    store,
    threadId: "t1",
    apiBaseUrl: "https://api.test/v1",
    getToken: async () => "tok",
    models: () => [{ id: "flux-schnell", route: "endpoint" }],
    cwd,
  });
  await assert.rejects(
    () => bridge.generate({ prompt: "x", inputImages: ["../secret.png"] }),
    /outside the workspace/,
  );
  await withFetch(
    () => jsonResponse({ data: [{ b64_json: PNG }] }),
    async () => {
      await assert.rejects(
        () => bridge.generate({ prompt: "x", saveTo: "../escape.png" }),
        /outside the workspace/,
      );
    },
  );
});

test("save: stores an image a chat model produced, downloading URLs first", async () => {
  const { store, cwd } = sandbox();
  const bridge = createImageBridge({
    store,
    threadId: "t1",
    apiBaseUrl: "https://api.test/v1",
    getToken: async () => "tok",
    models: () => [],
    cwd,
  });
  const inline = await bridge.save({ base64: PNG, mediaType: "image/png" });
  assert.equal(store.read("t1", inline.file).base64, PNG);

  await withFetch(
    () => new Response(Buffer.from(PNG, "base64"), { headers: { "content-type": "image/png" } }),
    async () => {
      const hosted = await bridge.save({ url: "https://cdn.test/a.png" });
      assert.equal(store.read("t1", hosted.file).base64, PNG);
    },
  );
});

test("storeAttachedImages: keeps the user's pictures reachable by file name", () => {
  const { store } = sandbox();
  const { files, note } = storeAttachedImages(store, "t1", [{ base64: PNG, mediaType: "image/png" }]);
  assert.equal(files.length, 1);
  assert.match(note, /input_images/);
  assert.equal(store.read("t1", files[0]!).base64, PNG);
  assert.equal(storeAttachedImages(store, "t1", []).note, "");
});
