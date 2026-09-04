import assert from "node:assert/strict";
import { test } from "node:test";
import { isVideoModel, modelIsVideo } from "../src/videos.js";
import { detectVideoGenerationIntent, pickVideoModelForGeneration } from "../src/video-intent.js";
import {
  normalizeVideoMode,
  resolveVideoGenerationMode,
  videoParamsToExtra,
} from "../src/video-model-params.js";

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

test("pickVideoModelForGeneration: id heuristic when cache lacks kind video", () => {
  const picked = pickVideoModelForGeneration([
    { id: "GLM-5.2", name: "GLM", kind: "chat" },
    { id: "Agnes-Video-2.5-Flash", name: "Agnes Video", kind: "chat" },
  ]);
  assert.equal(picked, "Agnes-Video-2.5-Flash");
});

test("modelIsVideo: kind or id heuristic", () => {
  assert.equal(modelIsVideo("Agnes-Video-2.5-Flash"), true);
  assert.equal(modelIsVideo("GLM-5.2", "chat"), false);
  assert.equal(modelIsVideo("custom-video-model", "video"), true);
});

test("videoParamsToExtra: always sends required mode=text by default", () => {
  const extra = videoParamsToExtra({ seconds: 5 }, { modelId: "Agnes-Video-2.5-Flash" });
  assert.equal(extra.mode, "text");
  assert.equal(extra.seconds, "5");
  assert.equal(extra.aspect_ratio, "16:9");
  assert.equal(extra.size, "720P");
});

test("videoParamsToExtra: reference mode when input images attached", () => {
  const extra = videoParamsToExtra({}, { inputImageCount: 1 });
  assert.equal(extra.mode, "reference");
});

test("normalizeVideoMode: maps legacy UI values", () => {
  assert.equal(normalizeVideoMode("ti2vid"), "reference");
  assert.equal(normalizeVideoMode("keyframes"), "keyframe");
  assert.equal(resolveVideoGenerationMode({ mode: "keyframe" }), "keyframe");
});
