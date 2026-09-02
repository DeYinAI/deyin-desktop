import assert from "node:assert/strict";
import { test } from "node:test";
import { HARD_TOOL_RESULT_CAP, ResultDeduper, snipHintFor, snipToolResult } from "../src/tool-result.js";

test("a result under the cap is passed through untouched", () => {
  const body = "x".repeat(1_000);
  assert.equal(snipToolResult(body, "read", "c1"), body);
});

test("snipping keeps BOTH ends and stays under the hard cap", () => {
  // The old implementation sliced off the tail, which for a build or test run is
  // exactly where the failure is.
  const head = "HEAD-MARKER";
  const tail = "TAIL-MARKER";
  const body = head + "x".repeat(HARD_TOOL_RESULT_CAP * 2) + tail;
  const out = snipToolResult(body, "bash", "call_7");
  assert.ok(out.length <= HARD_TOOL_RESULT_CAP, `snipped result was ${out.length} chars`);
  assert.ok(out.startsWith(head), "head was lost");
  assert.ok(out.endsWith(tail), "tail was lost");
  // The marker has to name the call so the full result can be paged back.
  assert.match(out, /call_7/);
});

test("failure output keeps more of its tail", () => {
  const tail = "TAIL-MARKER";
  const plain = "x".repeat(HARD_TOOL_RESULT_CAP * 2) + tail;
  const failing = "error: something broke\n" + "x".repeat(HARD_TOOL_RESULT_CAP * 2) + tail;
  const plainOut = snipToolResult(plain, "grep", "c1");
  const failOut = snipToolResult(failing, "grep", "c1");
  const tailOf = (s: string): number => s.length - s.lastIndexOf("] …\n\n");
  assert.ok(tailOf(failOut) > tailOf(plainOut), "a failure should retain more tail than plain output");
  assert.ok(failOut.endsWith(tail));
});

test("per-tool hints differ, and an explicit override wins", () => {
  assert.notDeepEqual(snipHintFor("read"), snipHintFor("bash"));
  assert.deepEqual(snipHintFor("read", { headChars: 1, tailChars: 2 }), { headChars: 1, tailChars: 2 });
  // Unknown tools (including MCP) fall back rather than throwing.
  assert.ok(snipHintFor("mcp__server__thing").headChars > 0);
});

test("an identical result from a later call is replaced with a pointer", () => {
  const deduper = new ResultDeduper();
  const body = "the same file contents ".repeat(100);
  assert.equal(deduper.check(body, "call_1"), null, "the first sighting is not a duplicate");
  const second = deduper.check(body, "call_2");
  assert.ok(second, "the second sighting should be elided");
  assert.match(second!, /call_1/, "the pointer must name the call that already has it");
  assert.ok(second!.length < body.length / 10, "the pointer should be far smaller than the body");
  assert.equal(deduper.elidedCount, 1);
});

test("re-checking the same call id is not a duplicate of itself", () => {
  const deduper = new ResultDeduper();
  const body = "y".repeat(2_000);
  assert.equal(deduper.check(body, "call_1"), null);
  assert.equal(deduper.check(body, "call_1"), null);
  assert.equal(deduper.elidedCount, 0);
});

test("short results are never elided — the pointer would cost as much", () => {
  const deduper = new ResultDeduper();
  const body = "ok";
  assert.equal(deduper.check(body, "call_1"), null);
  assert.equal(deduper.check(body, "call_2"), null);
  assert.equal(deduper.elidedCount, 0);
});

test("different results are all kept", () => {
  const deduper = new ResultDeduper();
  for (let i = 0; i < 5; i++) {
    assert.equal(deduper.check("contents ".repeat(100) + i, `call_${i}`), null);
  }
  assert.equal(deduper.elidedCount, 0);
});
