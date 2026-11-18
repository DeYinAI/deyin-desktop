import assert from "node:assert/strict";
import test from "node:test";
import { describeRunWork, formatRunDuration, type ActivityItem } from "../src/components/RunActivity.js";

const tool = (name: string): ActivityItem => ({ kind: "tool", name, summary: name, ok: true });
const file = (): ActivityItem => ({ kind: "file", name: "a.ts", subtitle: "", adds: 1, dels: 0 });
const thought = (): ActivityItem => ({ kind: "reasoning", text: "hmm", seconds: 2 });

test("describeRunWork: lists the kinds of work in order", () => {
  assert.equal(
    describeRunWork([tool("bash"), tool("write"), tool("web_fetch")]),
    "Ran commands, wrote files, visited web pages",
  );
});

test("describeRunWork: dedupes and caps at three phrases", () => {
  assert.equal(
    describeRunWork([tool("bash"), tool("bash"), file(), tool("web_fetch"), tool("read")]),
    "Ran commands, wrote files, visited web pages, etc.",
  );
});

test("describeRunWork: reasoning only", () => {
  assert.equal(describeRunWork([thought()]), "Thought it through");
});

test("describeRunWork: unknown tools are generic", () => {
  assert.equal(describeRunWork([tool("my_mcp_tool")]), "Used tools");
});

test("formatRunDuration", () => {
  assert.equal(formatRunDuration(400), "1s");
  assert.equal(formatRunDuration(45_000), "45s");
  assert.equal(formatRunDuration(29 * 60_000 + 27_000), "29m 27s");
  assert.equal(formatRunDuration(3_720_000), "1h 2m");
});
