import assert from "node:assert/strict";
import { test } from "node:test";
import { streamChatEvents } from "../src/stream.js";
import {
  AnthropicAccumulator,
  ResponsesAccumulator,
  mapAnthropicStopReason,
  ssePayloads,
  streamAnthropicEvents,
  streamResponsesEvents,
  type StreamEvent,
} from "../src/transports.js";
import { toAnthropicMessages, toResponsesInput } from "../src/wire.js";
import type { AgentMessage } from "../src/types.js";

const data = (obj: unknown): string => `data: ${JSON.stringify(obj)}`;

function feedAcc<T extends { push(payload: unknown): StreamEvent | null; getError(): string | null }>(
  acc: T,
  payloads: unknown[],
): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const p of payloads) {
    const ev = acc.push(p);
    if (ev) events.push(ev);
  }
  return events;
}

/* Anthropic Messages API ----------------------------------------------------- */

test("anthropic: accumulates text, thinking and a tool_use block", () => {
  const events = feedAcc(new AnthropicAccumulator(), [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "hmm " } },
    { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "ok" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path"' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ':"a.txt"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 7 } },
    { type: "message_stop" },
  ]);
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type !== "done") return;
  assert.equal(done.content, "Hello");
  assert.equal(done.reasoning, "hmm ok");
  assert.equal(done.finishReason, "tool_calls");
  assert.deepEqual(done.toolCalls, [{ id: "toolu_1", name: "read", arguments: '{"path":"a.txt"}' }]);
  assert.deepEqual(
    events.slice(0, -1).map((e) => (e.type === "text" || e.type === "reasoning" ? e.type : "?")),
    ["text", "text", "reasoning", "reasoning"],
  );
});

test("anthropic: usage counters use the max of cumulative frames", () => {
  const acc = new AnthropicAccumulator();
  const events = feedAcc(acc, [
    { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 2, cache_read_input_tokens: 40 } } },
    { type: "message_delta", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 } },
    { type: "message_stop" },
  ]);
  const done = events.at(-1);
  if (done?.type !== "done") throw new Error("expected done");
  // Billed prompt = input + cache_creation + cache_read; cached = cache_read.
  assert.deepEqual(done.usage, {
    promptTokens: 140,
    completionTokens: 20,
    totalTokens: 160,
    cachedPromptTokens: 40,
  });
});

test("anthropic: error event surfaces via getError", () => {
  const acc = new AnthropicAccumulator();
  feedAcc(acc, [{ type: "error", error: { type: "invalid_request_error", message: "bad" } }]);
  assert.equal(acc.getError(), "bad");
});

test("anthropic: stop-reason mapping", () => {
  assert.equal(mapAnthropicStopReason("end_turn"), "stop");
  assert.equal(mapAnthropicStopReason("stop_sequence"), "stop");
  assert.equal(mapAnthropicStopReason("tool_use"), "tool_calls");
  assert.equal(mapAnthropicStopReason("max_tokens"), "length");
  assert.equal(mapAnthropicStopReason("weird"), "weird");
});

test("anthropic: end-to-end request shape (URL, headers, body)", async () => {
  let captured!: { url: string; headers: Record<string, string>; body: Record<string, unknown> };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return new Response(
      [
        data({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
        data({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
        data({ type: "content_block_stop", index: 0 }),
        data({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
        data({ type: "message_stop" }),
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  try {
    const events: StreamEvent[] = [];
    for await (const ev of streamAnthropicEvents({
      apiBaseUrl: "https://api.anthropic.com/v1",
      token: "sk-ant",
      model: "claude-opus-4-8",
      messages: [{ role: "user" as const, content: "hi" }],
      thinking: true,
      effort: "high",
      maxTokens: 8192,
    })) {
      events.push(ev);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "done");
    if (done?.type !== "done") return;
    assert.equal(done.content, "hi");
    assert.equal(done.finishReason, "stop");
    // Trailing /v1 must not double up.
    assert.equal(captured.url, "https://api.anthropic.com/v1/messages");
    assert.equal(captured.headers["x-api-key"], "sk-ant");
    assert.equal(captured.headers["anthropic-version"], "2023-06-01");
    assert.equal(captured.body.max_tokens, 8192);
    assert.deepEqual(captured.body.thinking, { type: "enabled", budget_tokens: 4096 });
    assert.deepEqual(captured.body.output_config, { effort: "high" });
    assert.deepEqual(captured.body.system, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("anthropic: auth_header switches to Bearer and /v1 is not doubled", async () => {
  let capturedUrl = "";
  let capturedAuth = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedAuth = (init?.headers as Record<string, string>).authorization ?? "";
    return new Response(`data: {"type":"message_stop"}\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    const events: StreamEvent[] = [];
    for await (const ev of streamAnthropicEvents({
      apiBaseUrl: "https://gateway.example.com",
      token: "tok",
      model: "claude",
      messages: [{ role: "user" as const, content: "hi" }],
      authHeader: true,
    })) {
      events.push(ev);
    }
    assert.equal(capturedUrl, "https://gateway.example.com/v1/messages");
    assert.equal(capturedAuth, "Bearer tok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* OpenAI Responses API ------------------------------------------------------- */

test("responses: accumulates text, reasoning and function calls", () => {
  const events = feedAcc(new ResponsesAccumulator(), [
    { type: "response.output_text.delta", delta: "Answer" },
    { type: "response.reasoning_text.delta", delta: "think" },
    { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "fc_1", name: "ls" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"pa' },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: 'th":"."}' },
    { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "fc_1", name: "ls", arguments: '{"path":"."}' } },
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 30,
          output_tokens: 9,
          total_tokens: 39,
          input_tokens_details: { cached_tokens: 12 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      },
    },
  ]);
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type !== "done") return;
  assert.equal(done.content, "Answer");
  assert.equal(done.reasoning, "think");
  assert.equal(done.finishReason, "stop");
  assert.deepEqual(done.toolCalls, [{ id: "fc_1", name: "ls", arguments: '{"path":"."}' }]);
  assert.deepEqual(done.usage, { promptTokens: 30, completionTokens: 9, totalTokens: 39, cachedPromptTokens: 12 });
});

test("responses: incomplete with max_output_tokens maps to length", () => {
  const acc = new ResponsesAccumulator();
  const done = acc.push({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } });
  assert.equal(done?.type, "done");
  if (done?.type !== "done") throw new Error("expected done");
  assert.equal(done.finishReason, "length");
});

test("responses: failed surfaces an error", () => {
  const acc = new ResponsesAccumulator();
  acc.push({ type: "response.failed", error: { code: "rate_limit_exceeded", message: "slow down" } });
  assert.equal(acc.getError(), "slow down");
});

test("responses: end-to-end request shape", async () => {
  let captured!: { url: string; body: Record<string, unknown> };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    captured = { url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    return new Response(
      [
        data({ type: "response.output_text.delta", delta: "ok" }),
        data({
          type: "response.completed",
          response: { usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } },
        }),
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  try {
    const events: StreamEvent[] = [];
    for await (const ev of streamResponsesEvents({
      apiBaseUrl: "https://api.openai.com/v1/",
      token: "sk-",
      model: "gpt-5",
      messages: [
        { role: "system" as const, content: "You are a helper." },
        { role: "user" as const, content: "hi" },
      ],
      effort: "medium",
    })) {
      events.push(ev);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "done");
    if (done?.type !== "done") return;
    assert.equal(done.content, "ok");
    assert.equal(captured.url, "https://api.openai.com/v1/responses");
    assert.equal(captured.body.instructions, "You are a helper.");
    assert.deepEqual(captured.body.input, [{ role: "user", content: "hi" }]);
    assert.deepEqual(captured.body.reasoning, { effort: "medium" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* Wire converters ------------------------------------------------------------ */

test("toAnthropicMessages: system top-level, coalescing, tool blocks, cache breakpoints", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "Rules" },
    { role: "system", content: "More rules" },
    { role: "user", content: "list files" },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "ls", arguments: "{}" }] },
    { role: "tool", toolCallId: "t1", toolName: "ls", content: "a.txt" },
    { role: "user", content: "thanks" },
  ];
  const wire = toAnthropicMessages(messages, { enablePromptCaching: true });
  assert.equal(wire.system.length, 2);
  // cache breakpoint on the last system block.
  assert.deepEqual(wire.system[1], { type: "text", text: "More rules", cache_control: { type: "ephemeral" } });
  assert.equal(wire.messages.length, 3); // user, assistant(tool_use), user(tool_result + text coalesced)
  const [first, second, third] = wire.messages as Array<{ role: string; content: Record<string, unknown>[] }>;
  assert.ok(first && second && third, "three merged messages expected");
  assert.equal(first.role, "user");
  assert.equal(first.content[0]?.type, "text");
  assert.equal(second.role, "assistant");
  assert.deepEqual(second.content[0], { type: "tool_use", id: "t1", name: "ls", input: {} });
  assert.equal(third.role, "user");
  assert.deepEqual(third.content[0], { type: "tool_result", tool_use_id: "t1", content: "a.txt" });
  assert.equal(third.content[1]?.type, "text");
  // last block of final message carries the second cache breakpoint.
  assert.deepEqual(third.content[1], { type: "text", text: "thanks", cache_control: { type: "ephemeral" } });
});

test("toResponsesInput: instructions, reasoning, function_call and output items", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "You are a helper." },
    { role: "user", content: "list" },
    { role: "assistant", content: "", reasoning: "thinking out loud", toolCalls: [{ id: "fc_1", name: "ls", arguments: "{}" }] },
    { role: "tool", toolCallId: "fc_1", toolName: "ls", content: "x.txt" },
  ];
  const wire = toResponsesInput(messages);
  assert.equal(wire.instructions, "You are a helper.");
  assert.deepEqual(wire.input, [
    { role: "user", content: "list" },
    { type: "reasoning", content: [{ type: "reasoning_text", text: "thinking out loud" }] },
    { type: "function_call", call_id: "fc_1", name: "ls", arguments: "{}" },
    { type: "function_call_output", call_id: "fc_1", output: "x.txt" },
  ]);
});

/* Dispatch ------------------------------------------------------------------- */

test("streamChatEvents routes by apiFormat", async () => {
  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    urls.push(String(url));
    return new Response('data: {"type":"message_stop"}\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    const base = { token: "t", model: "m", messages: [{ role: "user" as const, content: "hi" }] };
    for await (const _ of streamChatEvents({ ...base, apiBaseUrl: "https://x.example", apiFormat: "anthropic" })) void _;
    for await (const _ of streamChatEvents({ ...base, apiBaseUrl: "https://x.example", apiFormat: "responses" })) void _;
    for await (const _ of streamChatEvents({ ...base, apiBaseUrl: "https://x.example" })) void _;
    assert.deepEqual(urls, [
      "https://x.example/v1/messages",
      "https://x.example/responses",
      "https://x.example/chat/completions",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("responses.failed surfaces as an error, not a successful run", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      [
        data({ type: "response.output_text.delta", delta: "partial" }),
        data({ type: "response.failed", error: { code: "rate_limit_exceeded", message: "slow down" } }),
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    let threw = "";
    try {
      const events: StreamEvent[] = [];
      for await (const ev of streamResponsesEvents({
        apiBaseUrl: "https://x.example",
        token: "t",
        model: "m",
        messages: [{ role: "user" as const, content: "hi" }],
      })) {
        events.push(ev);
      }
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assert.equal(threw, "slow down");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ssePayloads keeps the final line when the stream has no trailing newline", async () => {
  // Regression: `lines.pop()` buffering used to drop the last `data:` line when
  // the body did not end with "\n" — which silently ate the final SSE event.
  const noTrailing = new Response('data: {"a":1}\ndata: {"b":2}', {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const withTrailing = new Response('data: {"a":1}\ndata: {"b":2}\n', {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const count = async (res: Response): Promise<unknown[]> => {
    const out: unknown[] = [];
    for await (const p of ssePayloads(res)) out.push(p);
    return out;
  };
  assert.deepEqual(await count(withTrailing), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(await count(noTrailing), [{ a: 1 }, { b: 2 }]);
});

test("anthropic error frame followed by message_stop surfaces as an error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      [
        data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
        data({ type: "error", error: { type: "invalid_request_error", message: "bad request" } }),
        data({ type: "message_stop" }),
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    let threw = "";
    try {
      for await (const _ of streamAnthropicEvents({
        apiBaseUrl: "https://x.example",
        token: "t",
        model: "m",
        messages: [{ role: "user" as const, content: "hi" }],
      })) void _;
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assert.equal(threw, "bad request");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("responses: a tool call round-trips on call_id, not the output-item id", () => {
  const acc = new ResponsesAccumulator();
  feedAcc(acc, [
    { type: "response.output_item.added", item: { type: "function_call", id: "fc_abc", call_id: "call_123", name: "ls" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_abc", delta: '{"path":"."}' },
    { type: "response.output_item.done", item: { type: "function_call", id: "fc_abc", call_id: "call_123", name: "ls", arguments: '{"path":"."}' } },
  ]);
  const done = acc.push({ type: "response.completed", response: {} });
  assert.equal(done?.type, "done");
  if (done?.type !== "done") return;
  // The API matches function_call_output on call_id; sending fc_… back is rejected.
  assert.deepEqual(done.toolCalls, [{ id: "call_123", name: "ls", arguments: '{"path":"."}' }]);

  const wire = toResponsesInput([
    { role: "user", content: "list" },
    { role: "assistant", content: "", toolCalls: done.toolCalls },
    { role: "tool", toolCallId: done.toolCalls[0]!.id, toolName: "ls", content: "x.txt" },
  ] satisfies AgentMessage[]).input as Record<string, unknown>[];
  assert.equal(wire.at(-2)?.call_id, "call_123");
  assert.equal(wire.at(-1)?.call_id, "call_123");
});

test("responses: a function_call seen only on output_item.done is still collected", () => {
  const acc = new ResponsesAccumulator();
  acc.push({
    type: "response.output_item.done",
    item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "read", arguments: '{"path":"a"}' },
  });
  const done = acc.push({ type: "response.completed", response: {} });
  assert.equal(done?.type, "done");
  if (done?.type !== "done") return;
  assert.deepEqual(done.toolCalls, [{ id: "call_9", name: "read", arguments: '{"path":"a"}' }]);
});

test("anthropic: thinking disabled sends the bare disabled config", async () => {
  let captured!: Record<string, unknown>;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response([data({ type: "message_stop" })].join("\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    for await (const _ of streamAnthropicEvents({
      apiBaseUrl: "https://api.anthropic.com",
      token: "sk-ant",
      model: "claude-opus-4-8",
      messages: [{ role: "user" as const, content: "hi" }],
      thinking: false,
    })) {
      // drain
    }
    // budget_tokens alongside "disabled" is rejected by the Messages API.
    assert.deepEqual(captured.thinking, { type: "disabled" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("anthropic: the thinking budget stays under max_tokens", async () => {
  let captured!: Record<string, unknown>;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response([data({ type: "message_stop" })].join("\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    for await (const _ of streamAnthropicEvents({
      apiBaseUrl: "https://api.anthropic.com",
      token: "sk-ant",
      model: "claude-opus-4-8",
      messages: [{ role: "user" as const, content: "hi" }],
      thinking: true,
      maxTokens: 2000,
    })) {
      // drain
    }
    assert.deepEqual(captured.thinking, { type: "enabled", budget_tokens: 1999 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
