import assert from "node:assert/strict";
import test from "node:test";
import { summarizeToolActivity } from "../src/toolActivity.js";

const tool = (name: string, running = false, ok = true) =>
  ({ kind: "tool" as const, name, summary: name, ok: running ? undefined : ok });

test("summarizeToolActivity: completed mixed stack", () => {
  const s = summarizeToolActivity([tool("write"), tool("write"), tool("bash"), tool("bash")]);
  assert.equal(s.label, "Edited files, Ran commands");
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

test("summarizeToolActivity: explore-only", () => {
  const s = summarizeToolActivity([tool("read"), tool("grep")]);
  assert.equal(s.label, "Explored files");
  assert.equal(s.icon, "search");
});
