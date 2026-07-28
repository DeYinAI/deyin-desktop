import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamAccumulator, type StreamEvent } from "../src/stream.js";

function feed(lines: string[]): StreamEvent[] {
  const acc = new StreamAccumulator();
  const events: StreamEvent[] = [];
  for (const line of lines) {
    const ev = acc.push(line);
    if (ev) events.push(ev);
  }
  return events;
}

const data = (obj: unknown): string => `data: ${JSON.stringify(obj)}`;

test("accumulates text deltas and finish_reason", () => {
  const events = feed([
    data({ choices: [{ delta: { content: "Hel" } }] }),
    data({ choices: [{ delta: { content: "lo" } }] }),
    data({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]",
  ]);
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type !== "done") return;
  assert.equal(done.content, "Hello");
  assert.equal(done.finishReason, "stop");
  assert.deepEqual(done.toolCalls, []);
  assert.deepEqual(
    events.slice(0, -1).map((e) => (e.type === "text" ? e.delta : "?")),
    ["Hel", "lo"],
  );
});

test("reassembles tool_calls fragmented across chunks", () => {
  const events = feed([
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "re" } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "ad" } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] }),
    data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]",
  ]);
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type !== "done") return;
  assert.deepEqual(done.toolCalls, [{ id: "call_a", name: "read", arguments: '{"path":"a.txt"}' }]);
  assert.equal(done.finishReason, "tool_calls");
});

test("keeps parallel tool calls separated by index", () => {
  const events = feed([
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c0", function: { name: "ls", arguments: "{}" } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 1, id: "c1", function: { name: "glob", arguments: '{"pattern":"*"}' } }] } }] }),
    "data: [DONE]",
  ]);
  const done = events.at(-1);
  if (done?.type !== "done") throw new Error("expected done");
  assert.deepEqual(
    done.toolCalls.map((c) => `${c.id}:${c.name}`),
    ["c0:ls", "c1:glob"],
  );
});

test("captures reasoning deltas separately from content", () => {
  const events = feed([
    data({ choices: [{ delta: { reasoning_content: "hmm " } }] }),
    data({ choices: [{ delta: { reasoning: "ok" } }] }),
    data({ choices: [{ delta: { content: "answer" } }] }),
    "data: [DONE]",
  ]);
  const done = events.at(-1);
  if (done?.type !== "done") throw new Error("expected done");
  assert.equal(done.reasoning, "hmm ok");
  assert.equal(done.content, "answer");
  assert.equal(events.filter((e) => e.type === "reasoning").length, 2);
});

test("parses usage from the final chunk and ignores keep-alives", () => {
  const events = feed([
    ": keep-alive",
    "",
    data({ choices: [{ delta: { content: "x" } }] }),
    data({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }),
    "data: [DONE]",
  ]);
  const done = events.at(-1);
  if (done?.type !== "done") throw new Error("expected done");
  assert.deepEqual(done.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
});

test("synthesizes ids for providers that omit them and drops nameless calls", () => {
  const events = feed([
    data({ choices: [{ delta: { tool_calls: [{ index: 2, function: { name: "bash", arguments: "{}" } }] } }] }),
    "data: [DONE]",
  ]);
  const done = events.at(-1);
  if (done?.type !== "done") throw new Error("expected done");
  assert.equal(done.toolCalls[0]?.id, "call_2");
});
