import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateContextFromThreadEvents } from "../src/contextEstimate.js";

test("estimateContextFromThreadEvents builds a snapshot from chat events", () => {
  const snap = estimateContextFromThreadEvents(
    [
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "hi there" },
    ],
    128_000,
  );
  assert.ok(snap.usedTokens > 0);
  assert.equal(snap.contextLength, 128_000);
  assert.ok(snap.categories.some((c) => c.id === "conversation" && c.tokens > 0));
});
