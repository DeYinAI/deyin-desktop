import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchWithTransientRetry, MAX_TRANSIENT_RETRIES } from "../src/openference.js";

/**
 * `fetchWithTransientRetry` is shared by callers with no retry of their own (title
 * generation, the goal reviewer) and by the agent loop, which replays failed steps
 * itself. The first need the default; the second must be able to turn the hidden
 * layer off, or a provider outage is multiplied by it.
 */

/** Serve `statuses` in order (repeating the last), counting every request. */
async function withStatuses<T>(statuses: number[], run: (hits: () => number) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = (async () => {
    const status = statuses[Math.min(hits, statuses.length - 1)]!;
    hits += 1;
    // A tiny Retry-After keeps the backoff out of the test clock without changing the logic under test.
    return new Response("body", { status, headers: { "retry-after": "0.001" } });
  }) as typeof fetch;
  try {
    return await run(() => hits);
  } finally {
    globalThis.fetch = original;
  }
}

test("by default a transient status is retried up to MAX_TRANSIENT_RETRIES times", async () => {
  await withStatuses([503], async (hits) => {
    const res = await fetchWithTransientRetry("https://x.example", { method: "POST" });
    assert.equal(res.status, 503, "the last failure is returned, not thrown");
    assert.equal(hits(), 1 + MAX_TRANSIENT_RETRIES);
  });
});

test("retries: 0 makes it a single attempt", async () => {
  await withStatuses([503], async (hits) => {
    const res = await fetchWithTransientRetry("https://x.example", { method: "POST" }, { retries: 0 });
    assert.equal(res.status, 503);
    assert.equal(hits(), 1);
  });
});

test("onAttempt fires before every request, retries included", async () => {
  await withStatuses([503, 429, 200], async (hits) => {
    let attempts = 0;
    const res = await fetchWithTransientRetry("https://x.example", { method: "POST" }, { onAttempt: () => (attempts += 1) });
    assert.equal(res.status, 200);
    assert.equal(attempts, 3);
    assert.equal(attempts, hits(), "the callback count is the wire count");
  });
});

test("a non-transient failure is returned at once, whatever the retry budget", async () => {
  await withStatuses([401], async (hits) => {
    let attempts = 0;
    const res = await fetchWithTransientRetry("https://x.example", { method: "POST" }, { onAttempt: () => (attempts += 1) });
    assert.equal(res.status, 401);
    assert.equal(hits(), 1);
    assert.equal(attempts, 1);
  });
});

test("a negative retry budget is treated as zero", async () => {
  await withStatuses([500], async (hits) => {
    await fetchWithTransientRetry("https://x.example", { method: "POST" }, { retries: -3 });
    assert.equal(hits(), 1);
  });
});
