import assert from "node:assert/strict";
import test from "node:test";
import { summarizeActivityBlock, summarizeToolActivity } from "../src/toolActivity.js";

const tool = (name: string, running = false, ok = true) =>
  ({ kind: "tool" as const, name, summary: name, ok: running ? undefined : ok });

const file = (adds: number, dels: number) =>
  ({ kind: "file" as const, name: "a.ts", subtitle: "", adds, dels });

test("summarizeToolActivity: completed mixed stack", () => {
  const s = summarizeToolActivity([tool("write"), tool("write"), tool("bash"), tool("bash")]);
  assert.equal(s.label, "Edited 2 files, Ran commands");
  assert.equal(s.icon, "terminal");
  assert.equal(s.overflow, 0);
});

test("summarizeToolActivity: running with hidden shell calls", () => {
  const events = [tool("write", true), tool("write", true), tool("read", true)];
  for (let i = 0; i < 32; i++) events.push(tool("bash", true));
  const s = summarizeToolActivity(events);
  assert.match(s.label, /Editing 2 files, Explored 1 file/);
  assert.equal(s.overflow, 32);
  assert.equal(s.running, true);
});

test("summarizeToolActivity: explore and search counts", () => {
  const s = summarizeToolActivity([tool("read"), tool("read"), tool("grep"), tool("grep"), tool("grep")]);
  assert.equal(s.label, "Explored 2 files, 3 searches");
  assert.equal(s.icon, "search");
});

test("summarizeToolActivity: includes diff suffix from file cards", () => {
  const s = summarizeToolActivity([tool("write"), tool("read")], [file(31, 13), file(0, 0)]);
  assert.equal(s.label, "Edited 1 file, Explored 1 file +31 -13");
});

test("summarizeActivityBlock: thought-only collapses to one line", () => {
  const s = summarizeActivityBlock([], [], [{ kind: "reasoning", text: "hmm", seconds: 12 }]);
  assert.equal(s.label, "Thought · 12s");
  assert.equal(s.icon, "brain");
});
