import assert from "node:assert/strict";
import { test } from "node:test";
import { isVideoModel } from "../src/videos.js";
import { detectVideoGenerationIntent, pickVideoModelForGeneration } from "../src/video-intent.js";

test("isVideoModel: detects Agnes Video model ids", () => {
  assert.equal(isVideoModel("Agnes-Video-2.5-Flash"), true);
  assert.equal(isVideoModel("agnes-video-v2.0"), true);
  assert.equal(isVideoModel("GLM-5.2"), false);
});

test("detectVideoGenerationIntent: routes video requests", () => {
  assert.ok(detectVideoGenerationIntent("Generate a video of a cat on the beach"));
  assert.equal(detectVideoGenerationIntent("How does video generation work?"), null);
});

test("pickVideoModelForGeneration: prefers dedicated video models", () => {
  const picked = pickVideoModelForGeneration([
    { id: "GLM-5.2", name: "GLM" },
    { id: "Agnes-Video-2.5-Flash", name: "Agnes Video", kind: "video" },
  ]);
  assert.equal(picked, "Agnes-Video-2.5-Flash");
});
