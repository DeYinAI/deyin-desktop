import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS as sharedLimit } from "../src/shared.js";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, StreamIdleTimeoutError, readWithIdleTimeout } from "../src/sse-core.js";

/**
 * Reasoning models on long conversations (~90k tokens) can think for well over
 * a minute before the first visible token. The chat UI reuses this limit for
 * its own "no output" watchdog, so it has to be reachable from the browser-safe
 * `shared` surface and must stay far above the 45s that used to abort healthy
 * requests.
 */

/** A stream that delivers one chunk after `delayMs` of silence. */
function silentThenChunk(delayMs: number): ReadableStreamDefaultReader<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        controller.enqueue(new TextEncoder().encode("data: {}\n"));
        controller.close();
      }, delayMs);
    },
    // The idle guard cancels the reader on a stall; drop the pending chunk with it.
    cancel() {
      clearTimeout(timer);
    },
  });
  return stream.getReader();
}

test("the UI-facing idle limit is the transport limit and tolerates multi-minute reasoning", () => {
  assert.equal(sharedLimit, DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  assert.ok(sharedLimit >= 180_000, `idle limit ${sharedLimit}ms is shorter than 3 minutes`);
});

test("a silent gap shorter than the idle limit is waited out", async () => {
  const reader = silentThenChunk(60);
  const { done, value } = await readWithIdleTimeout(reader, 500);
  assert.equal(done, false);
  assert.ok(value && value.length > 0);
});

test("a silent gap longer than the idle limit raises a StreamIdleTimeoutError", async () => {
  const reader = silentThenChunk(500);
  await assert.rejects(
    () => readWithIdleTimeout(reader, 40),
    (err: unknown) => err instanceof StreamIdleTimeoutError && err.idleMs === 40,
  );
});
