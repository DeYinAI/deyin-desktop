import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgent } from "../src/loop.js";
import { PermissionEngine } from "../src/permissions.js";
import { StreamAccumulator } from "../src/stream.js";
import { AnthropicAccumulator, ResponsesAccumulator, type StreamEvent } from "../src/transports.js";
import { createBuiltinRegistry } from "../src/tools/index.js";
import type { AgentMessage, GeneratedImageRef } from "../src/types.js";
import { startMockOpenAI } from "./helpers/mock-openai.js";

/** 1x1 transparent PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DATA_URI = `data:image/png;base64,${PNG}`;

const data = (obj: unknown): string => `data: ${JSON.stringify(obj)}`;

function feed(lines: string[]): StreamEvent[] {
  const acc = new StreamAccumulator();
  const events: StreamEvent[] = [];
  for (const line of lines) {
    const ev = acc.push(line);
    if (ev) events.push(ev);
  }
  return events;
}

test("chat-completions: images attached to the message reach the done event", () => {
  const events = feed([
    data({ choices: [{ delta: { content: "Here it is." } }] }),
    data({ choices: [{ delta: { images: [{ type: "image_url", image_url: { url: DATA_URI } }] } }] }),
    // Gateways often repeat the finished message; the picture must not double.
    data({ choices: [{ message: { images: [{ type: "image_url", image_url: { url: DATA_URI } }] }, delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]",
  ]);
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type !== "done") return;
  assert.equal(done.content, "Here it is.");
  assert.equal(done.images?.length, 1);
  assert.equal(done.images?.[0]?.base64, PNG);
});

test("chat-completions: array content yields text deltas and images", () => {
  const events = feed([
    data({
      choices: [
        {
          delta: {
            content: [
              { type: "text", text: "drawing" },
              { type: "image_url", image_url: { url: DATA_URI } },
            ],
          },
        },
      ],
    }),
    data({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]",
  ]);
  assert.deepEqual(
    events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.delta : "")),
    ["drawing"],
  );
  const done = events.at(-1);
  assert.equal(done?.type === "done" ? done.images?.length : 0, 1);
});

test("responses API: the built-in image tool's result is captured", () => {
  const acc = new ResponsesAccumulator();
  acc.push({ type: "response.output_item.done", item: { type: "image_generation_call", id: "ig_1", result: PNG } });
  const done = acc.push({ type: "response.completed", response: {} });
  assert.equal(done?.type, "done");
  if (done?.type !== "done") return;
  assert.equal(done.images?.length, 1);
  assert.equal(done.images?.[0]?.source, "tool");
});

test("anthropic: an image content block is captured", () => {
  const acc = new AnthropicAccumulator();
  acc.push({
    type: "content_block_start",
    index: 0,
    content_block: { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
  });
  const done = acc.push({ type: "message_stop" });
  assert.equal(done?.type === "done" ? done.images?.length : 0, 1);
});

test("loop: a picture the model drew is stored and embedded in the reply", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-image-loop-"));
  const server = await startMockOpenAI(() => [
    { choices: [{ delta: { content: "Here is the fox." } }] },
    { choices: [{ delta: { images: [{ type: "image_url", image_url: { url: DATA_URI } }] } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
  const saved: { base64?: string }[] = [];
  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "draw" },
      { role: "user", content: "draw a fox" },
    ];
    const deltas: string[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "test-token",
      model: "gemini-2.5-flash-image",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "deny",
      cwd,
      imageOutput: true,
      onEvent: (event) => {
        if (event.type === "text-delta") deltas.push(event.delta);
      },
      toolContext: {
        imageGen: {
          generate: async (): Promise<GeneratedImageRef[]> => [],
          save: async (image): Promise<GeneratedImageRef> => {
            saved.push(image);
            return { file: "img-fox.png", mediaType: "image/png" };
          },
        },
      },
    });

    // The request asked for pictures, the picture was stored, and the reply
    // carries the directive that renders it.
    assert.deepEqual((server.requests[0] as { modalities?: string[] }).modalities, ["text", "image"]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.base64, PNG);
    assert.match(result.finalText, /::deyin-inline-image\{file="img-fox\.png"\}/);
    assert.ok(deltas.join("").includes("::deyin-inline-image"));
  } finally {
    await server.close();
  }
});

test("loop: without a host image store the reply keeps the text only", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-image-loop-"));
  const server = await startMockOpenAI(() => [
    { choices: [{ delta: { content: "Here is the fox." } }] },
    { choices: [{ delta: { images: [{ type: "image_url", image_url: { url: DATA_URI } }] } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
  try {
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "test-token",
      model: "gemini-2.5-flash-image",
      messages: [
        { role: "system", content: "draw" },
        { role: "user", content: "draw a fox" },
      ],
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "deny",
      cwd,
      imageOutput: true,
    });
    assert.equal(result.finalText, "Here is the fox.");
  } finally {
    await server.close();
  }
});
