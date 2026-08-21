import assert from "node:assert/strict";
import test from "node:test";
import { addImage, imageKey, imagesFromMessage, parseImagePart, type StreamImage } from "../src/image-parts.js";

/** 1x1 transparent PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("parseImagePart: data URIs, nested wrappers and raw base64", () => {
  assert.deepEqual(parseImagePart(`data:image/png;base64,${PNG}`), {
    base64: PNG,
    mediaType: "image/png",
    source: "message",
  });
  // OpenRouter / OpenAI chat shape.
  assert.deepEqual(parseImagePart({ type: "image_url", image_url: { url: `data:image/webp;base64,${PNG}` } }), {
    base64: PNG,
    mediaType: "image/webp",
    source: "message",
  });
  // Anthropic content block.
  assert.deepEqual(
    parseImagePart({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: PNG } }),
    { base64: PNG, mediaType: "image/jpeg", source: "message" },
  );
  // Gemini inline data.
  assert.deepEqual(parseImagePart({ inline_data: { mime_type: "image/png", data: PNG } }), {
    base64: PNG,
    mediaType: "image/png",
    source: "message",
  });
  // Responses API image tool.
  assert.deepEqual(parseImagePart({ type: "image_generation_call", result: PNG }, "message"), {
    base64: PNG,
    mediaType: "image/png",
    source: "tool",
  });
});

test("parseImagePart: hosted URLs come back as links, not bytes", () => {
  assert.deepEqual(parseImagePart({ type: "image_url", image_url: { url: "https://cdn.test/a.png" } }), {
    url: "https://cdn.test/a.png",
    mediaType: "image/png",
    source: "message",
  });
});

test("parseImagePart: text parts and short strings are not images", () => {
  assert.equal(parseImagePart({ type: "text", text: "hello" }), null);
  assert.equal(parseImagePart({ type: "tool_use", id: "call_1", name: "read" }), null);
  assert.equal(parseImagePart("resp_68a1c2"), null);
  assert.equal(parseImagePart({ id: "img_1" }), null);
});

test("imagesFromMessage: collects delta.images and array content", () => {
  const fromImages = imagesFromMessage({
    images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }],
  });
  assert.equal(fromImages.length, 1);
  const fromContent = imagesFromMessage({
    content: [
      { type: "text", text: "here you go" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
    ],
  });
  assert.equal(fromContent.length, 1);
  // A plain string content carries no images.
  assert.deepEqual(imagesFromMessage({ content: "just text" }), []);
});

test("addImage: repeated frames of the same picture are stored once", () => {
  const into: StreamImage[] = [];
  const seen = new Set<string>();
  const image: StreamImage = { base64: PNG, mediaType: "image/png", source: "message" };
  assert.equal(addImage(into, seen, image), true);
  assert.equal(addImage(into, seen, { ...image }), false);
  assert.equal(into.length, 1);
  assert.notEqual(imageKey(image), imageKey({ url: "https://cdn.test/a.png", mediaType: "image/png", source: "message" }));
});
