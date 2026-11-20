import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration, runTimeline } from "../src/automation-run-view.js";
import type { AgentUiEvent } from "../src/types.js";

const start = (id: string, name: string, summary = ""): AgentUiEvent => ({ type: "tool-start", callId: id, name, summary });
const end = (id: string, name: string, ok: boolean, result = "", denied = false): AgentUiEvent => ({
  type: "tool-end",
  callId: id,
  name,
  summary: "",
  result,
  ok,
  ...(denied ? { denied: true } : {}),
});

test("a timeline pairs each call with its result, in order", () => {
  const rows = runTimeline([
    start("1", "chrome_open", "https://x.com"),
    end("1", "chrome_open", true, "opened"),
    start("2", "chrome_click", "click e12"),
    end("2", "chrome_click", false, "Element e12 is not on the page\nre-snapshot"),
    start("3", "bash"),
    end("3", "bash", false, "denied by policy", true),
    start("4", "chrome_snapshot"),
  ]);
  assert.deepEqual(rows.map((r) => [r.tool, r.state]), [
    ["chrome_open", "ok"],
    ["chrome_click", "error"],
    ["bash", "denied"],
    ["chrome_snapshot", "pending"],
  ]);
  assert.equal(rows[1]?.detail, "Element e12 is not on the page re-snapshot", "newlines flatten");
  assert.equal(rows[0]?.detail, "", "a call that worked carries no detail");
});

test("a result whose start was trimmed away still gets a row", () => {
  const rows = runTimeline([end("9", "chrome_click", false, "stale ref")]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.tool, "chrome_click");
  assert.equal(rows[0]?.state, "error");
});

test("long summaries and failures are shortened", () => {
  const rows = runTimeline([start("1", "t", "s".repeat(500)), end("1", "t", false, "e".repeat(500))]);
  assert.ok((rows[0]?.summary.length ?? 0) <= 91);
  assert.ok((rows[0]?.detail.length ?? 0) <= 201);
});

test("durations read as seconds, minutes or hours", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45_400), "45s");
  assert.equal(formatDuration(200_000), "3m 20s");
  assert.equal(formatDuration(3_900_000), "1h 5m");
  assert.equal(formatDuration(-5), "0s");
});
