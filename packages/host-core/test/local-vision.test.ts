import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OLLAMA_BASE_URL,
  formatUserMessageWithLocalVision,
  resolveLocalOllamaBaseUrl,
  validateLocalVisionImages,
} from "../src/local-vision.js";

test("formatUserMessageWithLocalVision appends on-device descriptions", () => {
  const out = formatUserMessageWithLocalVision("What is this?", [{ index: 1, text: "A red button." }]);
  assert.match(out, /^What is this\?/);
  assert.match(out, /Local vision \(on-device\)/);
  assert.match(out, /A red button\./);
});

test("formatUserMessageWithLocalVision is a no-op for empty descriptions", () => {
  assert.equal(formatUserMessageWithLocalVision("hello", []), "hello");
});

test("resolveLocalOllamaBaseUrl accepts loopback hosts", () => {
  assert.equal(resolveLocalOllamaBaseUrl("http://127.0.0.1:11434/"), "http://127.0.0.1:11434");
  assert.equal(resolveLocalOllamaBaseUrl("http://localhost:11434"), "http://localhost:11434");
});

test("resolveLocalOllamaBaseUrl rejects remote hosts", () => {
  assert.throws(() => resolveLocalOllamaBaseUrl("http://192.168.1.5:11434"), /localhost/);
  assert.throws(() => resolveLocalOllamaBaseUrl("ftp://127.0.0.1:11434"), /http/);
});

test("validateLocalVisionImages enforces composer limits", () => {
  assert.equal(validateLocalVisionImages([]), "No images to describe.");
  assert.equal(validateLocalVisionImages([{ mediaType: "image/png", base64: "abc" }]), null);
  const huge = "A".repeat(8 * 1024 * 1024);
  assert.match(validateLocalVisionImages([{ mediaType: "image/png", base64: huge }]) ?? "", /5 MB/);
  const four = Array.from({ length: 5 }, () => ({ mediaType: "image/png", base64: "abc" }));
  assert.match(validateLocalVisionImages(four) ?? "", /At most 4/);
});

test("DEFAULT_OLLAMA_BASE_URL resolves as loopback", () => {
  assert.equal(resolveLocalOllamaBaseUrl(DEFAULT_OLLAMA_BASE_URL), DEFAULT_OLLAMA_BASE_URL);
});
