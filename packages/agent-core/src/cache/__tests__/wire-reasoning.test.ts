import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "../../types.js";
import { buildWireMessages, toWireMessages } from "../../wire.js";

test("tool-call history replays include reasoning_content", () => {
  const messages: AgentMessage[] = [
    {
      role: "assistant",
      content: "",
      reasoning: "I should read the file first.",
      toolCalls: [{ id: "c1", name: "read", arguments: '{"path":"a.ts"}' }],
    },
    { role: "tool", toolCallId: "c1", toolName: "read", content: "export const x = 1;" },
  ];

  const wire = toWireMessages(messages, { provider: "deepseek" });
  assert.deepEqual(wire[0], {
    role: "assistant",
    content: null,
    reasoning_content: "I should read the file first.",
    tool_calls: [
      { id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } },
    ],
  });
});

test("missing reasoning sends empty string on tool-call turns (graceful degradation)", () => {
  const messages: AgentMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "read", arguments: "{}" }],
    },
  ];

  const wire = buildWireMessages(messages, { provider: "openference", model: "deepseek-chat" }).messages;
  assert.equal((wire[0] as { reasoning_content?: string }).reasoning_content, "");
});

test("non-tool assistant turns do not add reasoning_content", () => {
  const wire = toWireMessages(
    [{ role: "assistant", content: "done", reasoning: "thought" }],
    { provider: "openai" },
  );
  assert.equal("reasoning_content" in (wire[0] as object), false);
});

test("anthropic provider skips DeepSeek reasoning_content field", () => {
  const wire = toWireMessages(
    [
      {
        role: "assistant",
        content: "",
        reasoning: "hidden",
        toolCalls: [{ id: "c1", name: "read", arguments: "{}" }],
      },
    ],
    { provider: "anthropic" },
  );
  assert.equal("reasoning_content" in (wire[0] as object), false);
});
