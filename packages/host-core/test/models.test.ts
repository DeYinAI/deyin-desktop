import assert from "node:assert/strict";
import test from "node:test";
import { listModels } from "../src/models.js";

test("listModels: text->image models are kind=image (images endpoint, not chat)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, _init) =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: "SDXL Lightning",
            context_length: 8192,
            architecture: { modality: "text->image", output_modalities: ["image"], input_modalities: ["text"] },
          },
          { id: "GLM-5.2", context_length: 128000, architecture: { output_modalities: ["text"], input_modalities: ["text"] } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const models = await listModels({ apiBaseUrl: "https://api.example.com/v1" }, async () => "tok");
    const sdxl = models.find((m) => m.id === "SDXL Lightning");
    const glm = models.find((m) => m.id === "GLM-5.2");
    assert.equal(sdxl?.kind, "image");
    assert.equal(sdxl?.imageOutput, undefined);
    assert.equal(glm?.kind, "chat");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
