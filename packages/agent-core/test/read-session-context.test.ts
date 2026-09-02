import assert from "node:assert/strict";
import { test } from "node:test";
import { RawResultStore } from "../src/raw-results.js";
import { readSessionContextTool } from "../src/tools/read-session-context.js";
import type { AgentMessage, ToolContext } from "../src/types.js";

function fakeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: "/tmp",
    todos: [],
    ...overrides,
  };
}

test("with no arguments, returns the session digest", async () => {
  const out = await readSessionContextTool.execute(
    {},
    fakeCtx({ sessionMeta: { mode: "agent", model: "test-model" } }),
  );
  assert.match(out, /mode: agent/);
  assert.match(out, /model: test-model/);
});

test("pages a snipped result back from the raw store", async () => {
  const rawResults = new RawResultStore();
  const body = "A".repeat(20_000) + "NEEDLE-IN-THE-MIDDLE" + "B".repeat(20_000);
  rawResults.record("call_9", "bash", body);
  const out = await readSessionContextTool.execute(
    { tool_call_id: "call_9", offset_chars: 19_000, max_chars: 4_000 },
    fakeCtx({ rawResults }),
  );
  assert.match(out, /bash raw result call_9: characters 19000-23000 of 40020/);
  assert.match(out, /NEEDLE-IN-THE-MIDDLE/);
  assert.match(out, /offset_chars=23000/, "the page must name the next offset");
});

test("the last page has no continuation hint", async () => {
  const rawResults = new RawResultStore();
  rawResults.record("c1", "read", "0123456789");
  const out = await readSessionContextTool.execute({ tool_call_id: "c1", max_chars: 5_000 }, fakeCtx({ rawResults }));
  assert.ok(!out.includes("more characters"), "no continuation hint on the final page");
});

test("an offset past the end says so instead of an empty page", async () => {
  const rawResults = new RawResultStore();
  rawResults.record("c1", "read", "0123456789");
  const out = await readSessionContextTool.execute({ tool_call_id: "c1", offset_chars: 500 }, fakeCtx({ rawResults }));
  assert.match(out, /past the end/);
});

test("falls back to the surface copy when the raw bytes were evicted", async () => {
  const messages: AgentMessage[] = [
    { role: "tool", toolCallId: "call_9", toolName: "bash", content: "head … [snipped] … tail" },
  ];
  const out = await readSessionContextTool.execute(
    { tool_call_id: "call_9" },
    fakeCtx({ messages, rawResults: new RawResultStore() }),
  );
  assert.match(out, /no longer retained/);
  assert.match(out, /head … \[snipped\] … tail/);
});

test("an unknown tool_call_id is reported honestly", async () => {
  const out = await readSessionContextTool.execute({ tool_call_id: "nope" }, fakeCtx());
  assert.match(out, /No result found for tool_call_id=nope/);
});
