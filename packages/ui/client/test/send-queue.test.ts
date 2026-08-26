import assert from "node:assert/strict";
import test from "node:test";

/** Mirrors app.tsx per-thread queue helpers. */
function setQueuedForThread(
  map: Record<string, string>,
  threadId: string,
  text: string | null,
): Record<string, string> {
  const next = { ...map };
  if (text === null || !text.trim()) delete next[threadId];
  else next[threadId] = text;
  return next;
}

test("queued prompts are scoped per thread", () => {
  let q: Record<string, string> = {};
  q = setQueuedForThread(q, "a", "follow up A");
  q = setQueuedForThread(q, "b", "follow up B");
  assert.equal(q.a, "follow up A");
  assert.equal(q.b, "follow up B");
  q = setQueuedForThread(q, "a", null);
  assert.equal(q.a, undefined);
  assert.equal(q.b, "follow up B");
});

test("empty queue text clears the slot", () => {
  let q = setQueuedForThread({}, "t1", "  ");
  assert.deepEqual(q, {});
});
