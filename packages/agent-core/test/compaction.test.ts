import assert from "node:assert/strict";
import { test } from "node:test";
import { compactMessages, estimateTokens } from "../src/compaction.js";
import type { AgentMessage } from "../src/types.js";

function transcript(turns: number, toolResultSize: number): AgentMessage[] {
  const messages: AgentMessage[] = [{ role: "system", content: "You are Deyin." }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `request ${i}` });
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id: `c${i}`, name: "read", arguments: "{}" }],
    });
    messages.push({ role: "tool", toolCallId: `c${i}`, toolName: "read", content: "x".repeat(toolResultSize) });
    messages.push({ role: "assistant", content: `answer ${i}` });
  }
  return messages;
}

test("no-op when under budget", () => {
  const messages = transcript(2, 100);
  const before = messages.length;
  const result = compactMessages(messages, 1_000_000);
  assert.deepEqual(result, { truncatedToolResults: 0, droppedMessages: 0 });
  assert.equal(messages.length, before);
});

test("truncates old tool results first, keeping recent ones intact", () => {
  const messages = transcript(6, 4000);
  const total = estimateTokens(messages);
  const result = compactMessages(messages, Math.floor(total * 0.8));
  assert.ok(result.truncatedToolResults > 0);
  const toolMessages = messages.filter((m) => m.role === "tool");
  assert.ok(toolMessages[0]!.content.includes("[tool result truncated"));
  assert.ok(!toolMessages.at(-1)!.content.includes("[tool result truncated"));
});

test("drops whole old turns and inserts a marker when still over budget", () => {
  const messages = transcript(8, 3000);
  const result = compactMessages(messages, 1200);
  assert.ok(result.droppedMessages > 0);
  assert.equal(messages[0]?.role, "system");
  assert.ok(messages[1]?.content.startsWith("[Context note:"));
  // The most recent turn must survive.
  assert.equal(messages.at(-1)?.content, "answer 7");
  assert.ok(estimateTokens(messages) < estimateTokens(transcript(8, 3000)));
});
