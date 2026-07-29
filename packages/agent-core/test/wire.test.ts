import assert from "node:assert/strict";
import { test } from "node:test";
import { toWireMessages } from "../src/wire.js";
import type { AgentMessage } from "../src/types.js";

test("passes system and user messages through", () => {
  const wire = toWireMessages([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
  assert.deepEqual(wire, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
});

test("assistant tool-call turns send null content plus tool_calls", () => {
  const messages: AgentMessage[] = [
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: '{"path":"a"}' }] },
    { role: "tool", toolCallId: "c1", toolName: "read", content: "data" },
  ];
  const wire = toWireMessages(messages);
  assert.deepEqual(wire[0], {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
  });
  assert.deepEqual(wire[1], { role: "tool", tool_call_id: "c1", content: "data" });
});

test("empty assistant turns without tool calls send empty-string content, not null", () => {
  // {role:"assistant", content:null} with no tool_calls is rejected by many
  // providers and would 400 every request after the empty completion.
  const wire = toWireMessages([{ role: "assistant", content: "" }]);
  assert.deepEqual(wire, [{ role: "assistant", content: "" }]);
});

test("wire format contract: tool-call turns use null content, non-tool turns use string content", () => {
  // Strict providers (Anthropic, some OpenAI modes) reject assistant turns with
  // `content: null` and no tool_calls, and reject empty-string content on tool-call
  // turns. Lock both branches so a future refactor can't silently flip them.
  const wire = toWireMessages([
    { role: "assistant", content: "" }, // empty, no tool calls -> ""
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "read", arguments: "{}" }],
    }, // tool calls -> null
    { role: "tool", toolCallId: "c1", toolName: "read", content: "x" },
    { role: "assistant", content: "done" }, // non-empty -> "done"
  ]);
  assert.equal(wire[0]!.content, "");
  assert.equal(wire[1]!.content, null);
  assert.ok(Array.isArray((wire[1] as { tool_calls?: unknown }).tool_calls));
  assert.equal(wire[3]!.content, "done");
});
