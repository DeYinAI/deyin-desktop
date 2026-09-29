import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamIdleTimeoutError } from "@deyin/host-core";
import { streamChatEvents } from "../src/stream.js";
import {
  ProviderHttpError,
  ProviderStreamError,
  classifyTransientFailure,
  retryAfterMsOf,
  sleepUnlessAborted,
  streamErrorFromFrame,
  streamRetryDelayMs,
  DEFAULT_STREAM_RETRY_POLICY,
} from "../src/stream-errors.js";
import {
  streamAnthropicEvents,
  streamResponsesEvents,
  type DoneEvent,
  type StreamEvent,
  type TransportOptions,
} from "../src/transports.js";

/**
 * How the model connection fails, and what the transports tell the loop about it.
 * The loop's keep-going behavior (keep-going.test.ts) is only as good as these
 * signals: an `incomplete` flag that never fires, or a permanent error mislabelled
 * transient, would turn recovery into either silent truncation or a retry storm.
 */

const sse = (...frames: unknown[]): string =>
  frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("");
const eventStream = (body: string): Response =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

const base: TransportOptions = {
  apiBaseUrl: "https://x.example",
  token: "t",
  model: "m",
  messages: [{ role: "user", content: "hi" }],
};

async function withFetch<T>(respond: () => Response | Promise<Response>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => respond()) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

function doneOf(events: StreamEvent[]): DoneEvent {
  const last = events.at(-1);
  assert.equal(last?.type, "done", "the stream must end with a done event");
  return last as DoneEvent;
}

async function errorOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  assert.fail("expected the stream to throw");
}

/* Was the response cut off? -------------------------------------------------- */

const chatDelta = { choices: [{ delta: { content: "partial" } }] };

test("chat: a stream with neither finish_reason nor [DONE] is flagged incomplete", async () => {
  const events = await withFetch(() => eventStream(sse(chatDelta)), () => collect(streamChatEvents(base)));
  const done = doneOf(events);
  assert.equal(done.incomplete, true);
  assert.equal(done.content, "partial", "what arrived is still handed over");
});

test("chat: a finish_reason without [DONE], or [DONE] without a finish_reason, is complete", async () => {
  const withFinish = sse(chatDelta, { choices: [{ delta: {}, finish_reason: "stop" }] });
  const withSentinel = sse(chatDelta, "[DONE]");
  for (const body of [withFinish, withSentinel]) {
    const events = await withFetch(() => eventStream(body), () => collect(streamChatEvents(base)));
    assert.equal(doneOf(events).incomplete, undefined);
  }
});

test("anthropic: incomplete unless message_stop or a stop_reason arrived", async () => {
  const text = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } };
  const stopReason = { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } };
  const run = (body: string) => withFetch(() => eventStream(body), () => collect(streamAnthropicEvents(base)));

  assert.equal(doneOf(await run(sse(text))).incomplete, true, "cut off mid-answer");
  assert.equal(doneOf(await run(sse(text, stopReason))).incomplete, undefined, "the model said why it stopped");
  assert.equal(doneOf(await run(sse(text, stopReason, { type: "message_stop" }))).incomplete, undefined);
  assert.equal(doneOf(await run(sse(text, { type: "message_stop" }))).incomplete, undefined);
});

test("responses: incomplete unless the response reached a terminal event", async () => {
  const text = { type: "response.output_text.delta", delta: "partial" };
  const run = (body: string) => withFetch(() => eventStream(body), () => collect(streamResponsesEvents(base)));

  assert.equal(doneOf(await run(sse(text))).incomplete, true, "cut off mid-answer");
  assert.equal(doneOf(await run(sse(text, { type: "response.completed", response: {} }))).incomplete, undefined);
  assert.equal(
    doneOf(await run(sse(text, { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } })))
      .finishReason,
    "length",
  );
});

/* Errors carried inside a 200 stream ---------------------------------------- */

test("chat: an error frame is thrown, typed by whether replaying could help", async () => {
  const frame = (error: unknown) => sse(chatDelta, { error }, "[DONE]");
  const run = (error: unknown) => () => withFetch(() => eventStream(frame(error)), () => collect(streamChatEvents(base)));

  const transient = await errorOf(run({ type: "server_error", message: "upstream exploded" }));
  assert.ok(transient instanceof ProviderStreamError);
  assert.equal(transient.transient, true);
  assert.equal(transient.message, "upstream exploded");
  assert.ok(classifyTransientFailure(transient), "the loop replays it");

  const permanent = await errorOf(run({ type: "invalid_request_error", message: "bad parameter" }));
  assert.ok(permanent instanceof ProviderStreamError);
  assert.equal(permanent.transient, false);
  assert.equal(classifyTransientFailure(permanent), null, "the loop surfaces it");
});

test("chat: harmless empty error fields do not fail a healthy stream", async () => {
  for (const error of [null, {}, ""]) {
    const body = sse(chatDelta, { error }, { choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]");
    const events = await withFetch(() => eventStream(body), () => collect(streamChatEvents(base)));
    assert.equal(doneOf(events).content, "partial");
  }
});

test("anthropic: overloaded_error is transient, invalid_request_error is not, and an empty message still counts", async () => {
  const run = (error: unknown) => () =>
    withFetch(() => eventStream(sse({ type: "error", error }, { type: "message_stop" })), () => collect(streamAnthropicEvents(base)));

  const overloaded = await errorOf(run({ type: "overloaded_error", message: "Overloaded" }));
  assert.ok(overloaded instanceof ProviderStreamError && overloaded.transient);

  const invalid = await errorOf(run({ type: "invalid_request_error", message: "bad request" }));
  assert.ok(invalid instanceof ProviderStreamError && !invalid.transient);
  assert.equal(invalid.message, "bad request");

  const bare = await errorOf(run({ type: "api_error", message: "" }));
  assert.ok(bare instanceof ProviderStreamError);
  assert.equal(bare.message, "api_error", "an empty message falls back to the error type instead of being swallowed");
  assert.equal(bare.transient, true);
});

test("responses: a standalone error event and response.failed both surface, with the real message", async () => {
  const run = (...frames: unknown[]) => () =>
    withFetch(() => eventStream(sse(...frames)), () => collect(streamResponsesEvents(base)));

  // OpenAI puts a standalone error event's payload at the top level.
  const standalone = await errorOf(run({ type: "error", code: "server_error", message: "boom" }, { type: "response.completed", response: {} }));
  assert.ok(standalone instanceof ProviderStreamError && standalone.transient);
  assert.equal(standalone.message, "boom");

  // response.failed nests it under response.error.
  const failed = await errorOf(
    run({ type: "response.failed", response: { error: { code: "rate_limit_exceeded", message: "slow down" } } }),
  );
  assert.ok(failed instanceof ProviderStreamError && failed.transient);
  assert.equal(failed.message, "slow down");

  const tooLong = await errorOf(
    run({ type: "response.failed", response: { error: { code: "context_length_exceeded", message: "too long" } } }),
  );
  assert.ok(tooLong instanceof ProviderStreamError && !tooLong.transient);
});

/* HTTP failures ------------------------------------------------------------- */

test("an HTTP failure carries its status, the server's own message and Retry-After", async () => {
  const res = () =>
    new Response(JSON.stringify({ error: { message: "The server is overloaded" } }), {
      status: 529,
      headers: { "retry-after": "3" },
    });
  const err = await errorOf(() => withFetch(res, () => collect(streamChatEvents(base))));
  assert.ok(err instanceof ProviderHttpError);
  assert.equal(err.status, 529);
  assert.equal(err.retryAfterMs, 3000);
  assert.match(err.message, /^Chat request failed \(529\)\./);
  assert.match(err.message, /The server is overloaded/, "the provider's explanation must not be replaced by a generic one");
  assert.deepEqual(classifyTransientFailure(err), { reason: "The provider returned HTTP 529", retryAfterMs: 3000 });
});

test("the server's message is kept for auth failures too, not replaced by 'temporary network problem'", async () => {
  const res = () => new Response(JSON.stringify({ error: { message: "Invalid API key provided" } }), { status: 401 });
  const err = await errorOf(() => withFetch(res, () => collect(streamChatEvents(base))));
  assert.ok(err instanceof ProviderHttpError);
  assert.match(err.message, /Invalid API key provided/);
  assert.doesNotMatch(err.message, /temporary network problem/);
  assert.equal(classifyTransientFailure(err), null);
});

test("anthropic and responses HTTP failures are typed the same way", async () => {
  // 529 rather than 502: the HTTP layer retries 502 itself, with multi-second backoff.
  const res = () => new Response("gateway down", { status: 529, headers: { "retry-after": "1" } });
  for (const [label, stream] of [
    ["Anthropic", streamAnthropicEvents],
    ["Responses", streamResponsesEvents],
  ] as const) {
    const err = await errorOf(() => withFetch(res, () => collect(stream(base))));
    assert.ok(err instanceof ProviderHttpError, label);
    assert.equal(err.status, 529);
    assert.equal(err.retryAfterMs, 1000);
    assert.match(err.message, new RegExp(`^${label} request failed \\(529\\)\\. gateway down`));
  }
});

test("Retry-After accepts seconds or a date, and is capped", () => {
  const header = (value: string | null) => ({ headers: { get: () => value } });
  assert.equal(retryAfterMsOf(header("2")), 2000);
  assert.equal(retryAfterMsOf(header("3600")), 30_000, "a long wait is the user's call, not ours");
  assert.equal(retryAfterMsOf(header(null)), undefined);
  assert.equal(retryAfterMsOf(header("soon")), undefined);
  assert.equal(retryAfterMsOf(header("0")), undefined);
  const inFiveSeconds = new Date(Date.now() + 5_000).toUTCString();
  const parsed = retryAfterMsOf(header(inFiveSeconds));
  assert.ok(parsed !== undefined && parsed >= 3_000 && parsed <= 5_000, `date form parsed to ${parsed}`);
});

/* Silent connections -------------------------------------------------------- */

function withIdleLimit<T>(ms: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env.DEYIN_STREAM_IDLE_TIMEOUT_MS;
  process.env.DEYIN_STREAM_IDLE_TIMEOUT_MS = String(ms);
  return run().finally(() => {
    if (previous === undefined) delete process.env.DEYIN_STREAM_IDLE_TIMEOUT_MS;
    else process.env.DEYIN_STREAM_IDLE_TIMEOUT_MS = previous;
  });
}

test("a connection that goes silent mid-stream times out instead of hanging forever", async () => {
  const frame = new TextEncoder().encode(sse(chatDelta));
  const silent = () =>
    new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(frame) }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  const startedAt = Date.now();
  const err = await withIdleLimit(100, () => errorOf(() => withFetch(silent, () => collect(streamChatEvents(base)))));
  assert.ok(err instanceof StreamIdleTimeoutError, String(err));
  assert.ok(Date.now() - startedAt < 3_000);
  assert.ok(classifyTransientFailure(err), "an idle stream is worth a replay");
  assert.notEqual((err as Error).name, "AbortError", "must not be mistaken for a user abort");
  assert.notEqual((err as Error).name, "TimeoutError", "must not be mistaken for a user abort");
});

test("a slow but steady stream is not mistaken for a silent one", async () => {
  const encoder = new TextEncoder();
  const slow = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const text of ["one ", "two ", "three"]) {
            await new Promise((resolve) => setTimeout(resolve, 60));
            controller.enqueue(encoder.encode(sse({ choices: [{ delta: { content: text } }] })));
          }
          controller.enqueue(encoder.encode(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]")));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const events = await withIdleLimit(150, () => withFetch(slow, () => collect(streamChatEvents(base))));
  assert.equal(doneOf(events).content, "one two three");
});

/* Classification and pacing -------------------------------------------------- */

test("classifyTransientFailure: network blips are retried, dead endpoints and bugs are not", () => {
  const withCode = (message: string, code: string, name = "Error"): Error =>
    Object.assign(new Error(message), { code, name });
  const undici = (message: string, causeCode?: string): TypeError =>
    Object.assign(new TypeError(message), causeCode ? { cause: { code: causeCode } } : {});

  const transient: unknown[] = [
    withCode("read ECONNRESET", "ECONNRESET"),
    withCode("connect ETIMEDOUT", "ETIMEDOUT"),
    undici("terminated", "UND_ERR_SOCKET"),
    undici("fetch failed", "ECONNRESET"),
    undici("terminated"),
    // No underlying error to inspect (Chromium's fetch, a polyfill): the wording is all there is.
    new TypeError("fetch failed"),
    new TypeError("Failed to fetch"),
    new Error("net::ERR_CONNECTION_RESET"),
    new Error("Client network socket disconnected: socket hang up"),
    new StreamIdleTimeoutError(1000),
  ];
  for (const err of transient) assert.ok(classifyTransientFailure(err), `should retry: ${String(err)}`);

  const permanent: unknown[] = [
    undici("fetch failed", "ECONNREFUSED"), // a stopped local server will not fix itself
    undici("fetch failed", "ENOTFOUND"), // a typo in the base URL will not either
    // fetch refused the request before it reached the network ("bad port" is what a
    // blocked port such as :9 produces): there is no code, but replaying cannot help.
    Object.assign(new TypeError("fetch failed"), { cause: new Error("bad port") }),
    Object.assign(new TypeError("fetch failed"), { cause: new Error("something undici invented") }),
    new Error("Anthropic API error"),
    new Error("boom"),
    Object.assign(new Error("aborted"), { name: "AbortError" }),
    "just a string",
    undefined,
    null,
  ];
  for (const err of permanent) assert.equal(classifyTransientFailure(err), null, `must not retry: ${String(err)}`);
});

test("classifyTransientFailure: HTTP statuses", () => {
  const http = (status: number, message = `failed (${status})`) => classifyTransientFailure(new ProviderHttpError(message, status));
  for (const status of [408, 425, 429, 500, 502, 503, 504, 520, 524, 529]) assert.ok(http(status), `HTTP ${status} is transient`);
  for (const status of [400, 401, 402, 403, 404, 413, 422]) assert.equal(http(status), null, `HTTP ${status} is permanent`);
  // Rate-limit statuses that really mean "out of money" do not clear up by waiting.
  assert.equal(http(429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'), null);
  assert.equal(http(429, "You exceeded your current quota, please check your plan and billing details."), null);
  assert.equal(http(503, "Account suspended"), null);
});

test("streamErrorFromFrame ignores empty frames and reads type, code and message", () => {
  for (const empty of [null, undefined, {}, "", "  ", 0]) {
    assert.equal(streamErrorFromFrame(empty), null, `should be ignored: ${JSON.stringify(empty)}`);
  }
  assert.equal(streamErrorFromFrame("Overloaded, try again")?.transient, true);
  assert.equal(streamErrorFromFrame({ code: 503, message: "x" })?.transient, true);
  assert.equal(streamErrorFromFrame({ code: "400", message: "x" })?.transient, false);
  assert.equal(streamErrorFromFrame({ type: "rate_limit_error", message: "slow" })?.transient, true);
  assert.equal(streamErrorFromFrame({ type: "rate_limit_error", message: "insufficient_quota" })?.transient, false);
});

test("retry delays back off exponentially, stay bounded, honour Retry-After, and jitter", () => {
  const policy = DEFAULT_STREAM_RETRY_POLICY;
  const middle = () => 0.5; // jitter factor exactly 1
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((attempt) => streamRetryDelayMs(attempt, policy, undefined, middle)),
    [1500, 3000, 6000, 12000, 20000, 20000],
  );
  // ±25% jitter around the backoff so parallel agents do not retry in lockstep.
  assert.equal(streamRetryDelayMs(2, policy, undefined, () => 0), 2250);
  assert.equal(streamRetryDelayMs(2, policy, undefined, () => 1), 3750);
  // Retry-After is a floor, but never beyond the policy ceiling.
  assert.equal(streamRetryDelayMs(1, policy, 10_000, middle), 10_000);
  assert.equal(streamRetryDelayMs(1, policy, 60_000, middle), policy.maxDelayMs);
});

test("sleepUnlessAborted waits, wakes early on abort, and never throws", async () => {
  const started = Date.now();
  await sleepUnlessAborted(40);
  assert.ok(Date.now() - started >= 30);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const abortedAt = Date.now();
  await sleepUnlessAborted(10_000, controller.signal);
  assert.ok(Date.now() - abortedAt < 2_000, "woke on abort");

  await sleepUnlessAborted(10_000, controller.signal); // already aborted: returns at once
});
