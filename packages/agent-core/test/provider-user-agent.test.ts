import assert from "node:assert/strict";
import { test } from "node:test";
import { initUserAgent } from "@deyin/host-core";
import { streamChatEvents } from "../src/stream.js";
import { streamAnthropicEvents, streamResponsesEvents, type StreamEvent, type TransportOptions } from "../src/transports.js";

/**
 * Regression: the agent's provider transports build their own request headers and
 * once forgot the User-Agent, so Node's fetch announced every LLM call as bare
 * `node`. Each wire format must identify as Deyin.
 */

const base: TransportOptions = {
  apiBaseUrl: "https://provider.example",
  token: "tok",
  model: "m",
  messages: [{ role: "user", content: "hi" }],
};

/** Run one transport against a fetch stub that records the request headers, then 400s (non-transient, so no retry delay). */
async function userAgentSent(run: () => AsyncGenerator<StreamEvent>): Promise<string | null> {
  const original = globalThis.fetch;
  let seen: string | null = null;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen = new Headers(init?.headers).get("user-agent");
    return new Response("rejected", { status: 400 });
  }) as typeof fetch;
  try {
    for await (const _ of run()) void _;
  } catch {
    // The 400 surfaces as a ProviderHttpError; only the request matters here.
  } finally {
    globalThis.fetch = original;
  }
  return seen;
}

test("every provider wire format sends the Deyin User-Agent", async () => {
  initUserAgent("desktop", "9.9.9");
  const expected = /^Deyin\/9\.9\.9 \(desktop; (Windows|macOS|Linux); node\/\d+\.\d+\)$/;

  assert.match((await userAgentSent(() => streamChatEvents(base))) ?? "", expected, "chat-completions");
  assert.match((await userAgentSent(() => streamAnthropicEvents(base))) ?? "", expected, "anthropic");
  assert.match((await userAgentSent(() => streamResponsesEvents(base))) ?? "", expected, "responses");
});
