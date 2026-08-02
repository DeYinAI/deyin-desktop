import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { foldTokenUsage, streamChatEvents } from "../../stream.js";

test("foldTokenUsage sums prompt, completion, and cached tokens", () => {
  const a = { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 80 };
  const b = { promptTokens: 50, completionTokens: 30, totalTokens: 80, cachedPromptTokens: 40 };
  assert.deepEqual(foldTokenUsage(a, b), {
    promptTokens: 150,
    completionTokens: 50,
    totalTokens: 200,
    cachedPromptTokens: 120,
  });
});

test("streamChatEvents continues truncated DeepSeek responses via beta endpoint", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = mock.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (calls.length === 1) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello " } }] })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ delta: {}, finish_reason: "length" }],
                usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 90 },
              })}\n\n`,
            ),
          );
        } else {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "world" } }] })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, prompt_cache_hit_tokens: 18 },
              })}\n\n`,
            ),
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  try {
    const events = [];
    for await (const ev of streamChatEvents({
      apiBaseUrl: "https://api.deepseek.com",
      token: "test",
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hi" }],
      maxContinuations: 2,
    })) {
      events.push(ev);
    }

    assert.equal(calls.length, 2);
    assert.match(calls[0]!.url, /\/chat\/completions$/);
    assert.match(calls[1]!.url, /\/beta\/chat\/completions$/);

    const prefixMessages = calls[1]!.body.messages as Record<string, unknown>[];
    const last = prefixMessages.at(-1)!;
    assert.equal(last.role, "assistant");
    assert.equal(last.content, "Hello ");
    assert.equal(last.prefix, true);

    const done = events.at(-1);
    assert.equal(done?.type, "done");
    if (done?.type !== "done") return;
    assert.equal(done.content, "Hello world");
    assert.equal(done.finishReason, "stop");
    assert.equal(done.continuations, 1);
    assert.deepEqual(done.usage, {
      promptTokens: 120,
      completionTokens: 8,
      totalTokens: 128,
      cachedPromptTokens: 108,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-DeepSeek providers do not call beta continuation", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = mock.fn(async (input: string | URL) => {
    calls.push(String(input));
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: "partial" }, finish_reason: "length" }],
              usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
            })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  try {
    const events = [];
    for await (const ev of streamChatEvents({
      apiBaseUrl: "https://openrouter.ai/api/v1",
      token: "test",
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(ev);
    }
    assert.equal(calls.length, 1);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected done");
    assert.equal(done.finishReason, "length");
    assert.equal(done.continuations, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
