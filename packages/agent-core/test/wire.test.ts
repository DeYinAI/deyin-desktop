import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWireMessages, toWireMessages, toAnthropicMessages, toResponsesInput } from "../src/wire.js";
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

/* Vision: user images serialize into all three wire formats ------------------ */

const IMG = { mediaType: "image/png" as const, base64: "aW1n" };

test("chat-completions: user images become image_url content parts", () => {
  const wire = toWireMessages([
    { role: "system", content: "sys" },
    { role: "user", content: "what is this?", images: [IMG] },
  ]);
  assert.deepEqual(wire[1], {
    role: "user",
    content: [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
    ],
  });
});

test("chat-completions: user messages without images stay plain strings", () => {
  const wire = toWireMessages([{ role: "user", content: "hi" }]);
  assert.deepEqual(wire[0], { role: "user", content: "hi" });
});

test("anthropic: user images become base64 image blocks in the merged turn", () => {
  const { messages } = toAnthropicMessages([{ role: "user", content: "look", images: [IMG] }], {
    enablePromptCaching: false,
  });
  assert.deepEqual(messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } },
      ],
    },
  ]);
});

test("responses: user images become input_image items with data URLs", () => {
  const { input } = toResponsesInput([{ role: "user", content: "look", images: [IMG] }]);
  assert.deepEqual(input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: "data:image/png;base64,aW1n" },
      ],
    },
  ]);
});

// ---------------------------------------------------------------------------
// Rolling cache breakpoints
// ---------------------------------------------------------------------------

/** Does any block or the message itself carry a cache_control marker? */
function isMarked(message: Record<string, unknown> | undefined): boolean {
  if (!message) return false;
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return (content as Record<string, unknown>[]).some((b) => b.cache_control !== undefined);
}

const anthropicWire = { enablePromptCaching: true, provider: "anthropic" as const };

test("a run ending on a tool-call-only turn still gets a rolling breakpoint", () => {
  // Agent steps almost always end on a tool-call turn, whose content is null and
  // so cannot carry a marker. Before the walk-back both rolling breakpoints were
  // silently dropped in exactly this, the common, case.
  const messages: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "do the thing" },
    { role: "tool", toolCallId: "c0", toolName: "read", content: "file contents" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: "{}" }] },
  ];
  const { messages: wire } = buildWireMessages(messages, anthropicWire);

  const tailTurn = wire[wire.length - 1]!;
  assert.equal(tailTurn.content, null, "fixture should end on a tool-call-only turn");
  assert.equal(isMarked(tailTurn), false, "a null-content turn must not be marked");
  // The marker landed on the nearest message that can carry one.
  assert.ok(
    wire.slice(1).some((m) => isMarked(m as Record<string, unknown>)),
    "no rolling breakpoint was placed anywhere in the conversation",
  );
});

test("cache_control is never attached to a tool_calls entry", () => {
  // Hanging it there would invent a wire shape gateways are entitled to reject.
  const messages: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: "{}" }] },
  ];
  const { messages: wire } = buildWireMessages(messages, anthropicWire);
  for (const m of wire) {
    const calls = (m as Record<string, unknown>).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls as Record<string, unknown>[]) {
      assert.equal(call.cache_control, undefined, "cache_control leaked onto a tool_calls entry");
      assert.deepEqual(Object.keys(call).sort(), ["function", "id", "type"]);
    }
  }
});

test("the static system breakpoint is still placed on the leading system run", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    { role: "assistant", content: "done" },
  ];
  const { messages: wire } = buildWireMessages(messages, anthropicWire);
  assert.ok(isMarked(wire[0] as Record<string, unknown>), "the system prompt lost its static breakpoint");
});
