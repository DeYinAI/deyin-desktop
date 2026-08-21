import assert from "node:assert/strict";
import test from "node:test";
import { generateImageTool, inlineImageDirective } from "../src/tools/generate-image.js";
import type { ToolContext } from "../src/types.js";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), todos: [], ...overrides };
}

test("generate_image: returns embed directives for every generated file", async () => {
  const seen: unknown[] = [];
  const result = await generateImageTool.execute(
    { prompt: "a red fox in fog", size: "1024x1024", n: 2, alt: "Fox" },
    ctx({
      imageGen: {
        generate: async (request) => {
          seen.push(request);
          return [
            { file: "img-a.png", model: "SDXL Lightning", mediaType: "image/png" },
            { file: "img-b.png", model: "SDXL Lightning", mediaType: "image/png" },
          ];
        },
      },
    }),
  );
  assert.deepEqual(seen, [{ prompt: "a red fox in fog", model: undefined, size: "1024x1024", negativePrompt: undefined, n: 2 }]);
  assert.match(result, /Generated 2 images with SDXL Lightning/);
  assert.ok(result.includes('::deyin-inline-image{file="img-a.png" alt="Fox"}'));
  assert.ok(result.includes('::deyin-inline-image{file="img-b.png" alt="Fox"}'));
});

test("generate_image: clamps n and defaults alt to the prompt", async () => {
  let requested = 0;
  const result = await generateImageTool.execute(
    { prompt: "an icon", n: 99 },
    ctx({
      imageGen: {
        generate: async (request) => {
          requested = request.n ?? 0;
          return [{ file: "img.png", model: "flux", mediaType: "image/png" }];
        },
      },
    }),
  );
  assert.equal(requested, 4);
  assert.ok(result.includes('alt="an icon"'));
});

test("generate_image: forwards edit inputs and workspace saves", async () => {
  const seen: unknown[] = [];
  const result = await generateImageTool.execute(
    { prompt: "same scene at night", input_images: ["img-a.png"], save_to: "assets/night.png" },
    ctx({
      imageGen: {
        generate: async (request) => {
          seen.push(request);
          return [{ file: "img-c.png", model: "gpt-image-1", mediaType: "image/png", savedTo: "/w/assets/night.png" }];
        },
      },
    }),
  );
  assert.deepEqual(seen, [
    {
      prompt: "same scene at night",
      model: undefined,
      size: undefined,
      negativePrompt: undefined,
      n: 1,
      inputImages: ["img-a.png"],
      saveTo: "assets/night.png",
    },
  ]);
  assert.match(result, /Edited 1 image with gpt-image-1/);
  assert.match(result, /Written to the workspace: \/w\/assets\/night\.png/);
  assert.equal(generateImageTool.summarize?.({ prompt: "x", input_images: ["a.png"] }), "edit image: x");
});

test("generate_image: accepts a single input image passed as a bare string", async () => {
  let seen: string[] | undefined;
  await generateImageTool.execute(
    { prompt: "brighter", input_images: "img-a.png" },
    ctx({
      imageGen: {
        generate: async (request) => {
          seen = request.inputImages;
          return [{ file: "img-d.png", mediaType: "image/png" }];
        },
      },
    }),
  );
  assert.deepEqual(seen, ["img-a.png"]);
});

test("generate_image: explains itself when the host has no image bridge", async () => {
  const result = await generateImageTool.execute({ prompt: "x" }, ctx());
  assert.match(result, /not available in this host/);
});

test("generate_image: reports provider failures instead of throwing", async () => {
  const result = await generateImageTool.execute(
    { prompt: "x" },
    ctx({
      imageGen: {
        generate: async () => {
          throw new Error("model not enabled on your plan");
        },
      },
    }),
  );
  assert.match(result, /ERROR generating image: model not enabled on your plan/);
});

test("inlineImageDirective: neutralizes quotes and newlines in alt text", () => {
  assert.equal(
    inlineImageDirective('a "quoted"\nprompt.png', 'say "hi"'),
    `::deyin-inline-image{file="a 'quoted' prompt.png" alt="say 'hi'"}`,
  );
});
