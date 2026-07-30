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
  assert.deepEqual(result, { truncatedToolResults: 0, truncatedToolArgs: 0, droppedMessages: 0 });
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

test("truncates old tool-call arguments (large writes), keeping recent ones intact", () => {
  // One long user turn full of write calls: group-dropping cannot shrink it, so
  // argument truncation must bring the payload back under budget.
  const messages: AgentMessage[] = [
    { role: "system", content: "You are Deyin." },
    { role: "user", content: "build the site" },
  ];
  for (let i = 0; i < 8; i++) {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: `w${i}`, name: "write", arguments: JSON.stringify({ path: `f${i}.txt`, content: "y".repeat(5000) }) },
      ],
    });
    messages.push({ role: "tool", toolCallId: `w${i}`, toolName: "write", content: `Wrote f${i}.txt` });
  }
  const total = estimateTokens(messages);
  const result = compactMessages(messages, Math.floor(total * 0.5));
  assert.ok(result.truncatedToolArgs > 0);
  assert.ok(estimateTokens(messages) < total);

  const assistants = messages.filter((m) => m.role === "assistant");
  const firstArgs = assistants[0]!.toolCalls![0]!.arguments;
  // Truncated arguments keep the same object shape (same keys, same primitive types)
  // so strict providers that validate historical tool_calls.arguments against the
  // tool's schema still accept the replayed message.
  const parsed = JSON.parse(firstArgs) as { path: string; content: string };
  assert.equal(parsed.path, "f0.txt");
  assert.ok(parsed.content.length < 5000);
  assert.ok(parsed.content.includes("[arguments truncated during compaction"));
  // The trailing KEEP_RECENT_MESSAGES window is untouched.
  const lastArgs = assistants.at(-1)!.toolCalls![0]!.arguments;
  assert.ok(!lastArgs.includes("truncated"));
  assert.equal(JSON.parse(lastArgs).content.length, 5000);
});

test("compaction truncation does not alias external toolCall references", () => {
  const messages: AgentMessage[] = [{ role: "system", content: "You are Deyin." }];
  const big = "y".repeat(5000);
  const calls = [
    { id: "w0", name: "write", arguments: JSON.stringify({ path: "f0.txt", content: big }) },
    { id: "w1", name: "write", arguments: JSON.stringify({ path: "f1.txt", content: big }) },
  ];
  messages.push({ role: "assistant", content: "", toolCalls: calls });
  messages.push({ role: "tool", toolCallId: "w0", toolName: "write", content: "Wrote f0.txt" });
  messages.push({ role: "tool", toolCallId: "w1", toolName: "write", content: "Wrote f1.txt" });
  // Pad so the assistant turn falls outside KEEP_RECENT_MESSAGES.
  for (let i = 0; i < 10; i++) messages.push({ role: "user", content: `filler ${i}` });

  const externalRef = calls[0];
  compactMessages(messages, 1_000);
  // The external reference captured before compaction must still hold the original
  // (untruncated) arguments — the store replaced the array, not the element.
  assert.ok(externalRef);
  assert.equal(JSON.parse(externalRef.arguments).content.length, 5000);
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
