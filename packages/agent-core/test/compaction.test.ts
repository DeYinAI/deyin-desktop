import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  applyPrune,
  foldRegion,
  SUMMARY_OUTPUT_MAX_TOKENS,
  decideCompaction,
  estimateTokens,
  pinnedPrefixLen,
  planPrune,
  selectRegion,
  tailStart,
  COMPACT_RATIO,
  MAX_CONSECUTIVE_COMPACTS,
  MIN_RECLAIM_RATIO,
  STALE_TOOL_RESULT_CAP,
} from "../src/compaction.js";
import type { AgentMessage } from "../src/types.js";
import { buildWireMessages } from "../src/wire.js";

/** A short tail budget keeps fixtures small while exercising the real code path. */
const TAIL = 200;

function transcript(turns: number, toolResultChars: number): AgentMessage[] {
  const messages: AgentMessage[] = [{ role: "system", content: "You are Deyin." }];
  messages.push({ role: "user", content: "the original task" });
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id: `c${i}`, name: "read", arguments: "{}" }],
    });
    messages.push({ role: "tool", toolCallId: `c${i}`, toolName: "read", content: "x ".repeat(toolResultChars) });
    messages.push({ role: "assistant", content: `answer ${i}` });
  }
  return messages;
}

test("no-op when nothing exceeds the stale-result cap", () => {
  const messages = transcript(3, 100);
  const before = JSON.stringify(messages);
  const plan = planPrune(messages, { tailBudget: TAIL });
  assert.equal(plan.reclaimedTokens, 0);
  assert.equal(plan.edits.length, 0);
  assert.equal(JSON.stringify(messages), before);
});

test("pruning is idempotent — a second pass finds nothing to do", () => {
  // The regression test for the bug that started this: the old pass shrank tool
  // results only until the transcript fit, so the very next appended message
  // put it back over and it re-fired on every single loop step.
  const messages = transcript(8, STALE_TOOL_RESULT_CAP * 3);
  const first = planPrune(messages, { tailBudget: TAIL });
  assert.ok(first.reclaimedTokens > 0, "first pass should reclaim something");
  applyPrune(messages, first);

  const second = planPrune(messages, { tailBudget: TAIL });
  assert.equal(second.reclaimedTokens, 0);
  assert.equal(second.edits.length, 0);

  // And it stays a no-op as the conversation keeps growing.
  messages.push({ role: "user", content: "keep going" });
  messages.push({ role: "assistant", content: "done" });
  assert.equal(planPrune(messages, { tailBudget: TAIL }).reclaimedTokens, 0);
});

test("prunes stale tool results but leaves the verbatim tail alone", () => {
  const messages = transcript(8, STALE_TOOL_RESULT_CAP * 3);
  // A tail budget wide enough to hold the last turn, so there is something to
  // protect: the point is that recency wins, not that everything outside a tiny
  // window gets cut.
  applyPrune(messages, planPrune(messages, { tailBudget: STALE_TOOL_RESULT_CAP * 4 }));
  const tools = messages.filter((m) => m.role === "tool");
  assert.ok(tools[0]!.content.includes("[tool result pruned"), "oldest result should be pruned");
  assert.ok(!tools.at(-1)!.content.includes("[tool result pruned"), "newest result should survive");
});

test("applyPrune replaces message objects rather than editing them", () => {
  const messages = transcript(8, STALE_TOOL_RESULT_CAP * 3);
  const originalToolMessage = messages.find((m) => m.role === "tool")!;
  const originalLength = originalToolMessage.content.length;
  applyPrune(messages, planPrune(messages, { tailBudget: TAIL }));
  // The session log and the UI hold references to the originals; they must keep
  // seeing full fidelity even though the model-visible surface shrank.
  assert.equal(originalToolMessage.content.length, originalLength);
  assert.notEqual(messages.find((m) => m.role === "tool"), originalToolMessage);
});

test("prunes oversized tool-call arguments while keeping the JSON shape", () => {
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
  const plan = planPrune(messages, { tailBudget: TAIL });
  assert.ok(plan.edits.some((e) => e.kind === "tool-args"));
  applyPrune(messages, plan);

  const assistants = messages.filter((m) => m.role === "assistant");
  // Truncated arguments keep the same object shape (same keys, same primitive
  // types) so strict providers that validate historical tool_calls.arguments
  // against the tool's schema still accept the replayed message.
  const parsed = JSON.parse(assistants[0]!.toolCalls![0]!.arguments) as { path: string; content: string };
  assert.equal(parsed.path, "f0.txt");
  assert.ok(parsed.content.length < 5000);
  assert.ok(parsed.content.includes("[arguments pruned"));
  // The verbatim tail is untouched.
  assert.equal(JSON.parse(assistants.at(-1)!.toolCalls![0]!.arguments).content.length, 5000);
});

test("prune truncation does not alias external toolCall references", () => {
  const messages: AgentMessage[] = [{ role: "system", content: "You are Deyin." }];
  const big = "y".repeat(5000);
  const calls = [
    { id: "w0", name: "write", arguments: JSON.stringify({ path: "f0.txt", content: big }) },
    { id: "w1", name: "write", arguments: JSON.stringify({ path: "f1.txt", content: big }) },
  ];
  messages.push({ role: "assistant", content: "", toolCalls: calls });
  messages.push({ role: "tool", toolCallId: "w0", toolName: "write", content: "Wrote f0.txt" });
  messages.push({ role: "tool", toolCallId: "w1", toolName: "write", content: "Wrote f1.txt" });
  for (let i = 0; i < 10; i++) messages.push({ role: "user", content: `filler ${i}` });

  const externalRef = calls[0];
  applyPrune(messages, planPrune(messages, { tailBudget: TAIL }));
  assert.ok(externalRef);
  assert.equal(JSON.parse(externalRef.arguments).content.length, 5000);
});

test("pins the system prompt and the opening user turn", () => {
  const messages = transcript(4, 100);
  assert.equal(pinnedPrefixLen(messages), 2);
  assert.equal(selectRegion(messages, TAIL).start, 2);

  // An enormous opening turn is not worth pinning verbatim.
  const huge: AgentMessage[] = [
    { role: "system", content: "You are Deyin." },
    { role: "user", content: "x ".repeat(20_000) },
    { role: "assistant", content: "ok" },
  ];
  assert.equal(pinnedPrefixLen(huge), 1);
});

test("a region boundary never orphans a tool result", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "You are Deyin." },
    { role: "user", content: "go" },
  ];
  for (let i = 0; i < 6; i++) {
    messages.push({ role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name: "read", arguments: "{}" }] });
    // Large results so the tail budget lands mid-pair rather than on a turn edge.
    messages.push({ role: "tool", toolCallId: `c${i}`, toolName: "read", content: "x ".repeat(400) });
  }
  for (let budget = 1; budget < 4000; budget += 137) {
    const start = tailStart(messages, 2, budget);
    assert.notEqual(
      messages[start]?.role,
      "tool",
      `tail starting at ${start} (budget ${budget}) orphans a tool result`,
    );
  }
});

test("does nothing at all below the compaction line", () => {
  // The property the whole design rests on: under pressure the transcript is
  // left byte-identical, so the provider's cached prefix keeps hitting.
  const messages = transcript(40, 40);
  const contextLength = Math.ceil(estimateTokens(messages) / (COMPACT_RATIO - 0.1));
  const before = JSON.stringify(messages);

  const decision = decideCompaction({ messages, contextLength, trigger: "pressure" });
  assert.equal(decision.action, "none");
  assert.equal(JSON.stringify(messages), before);
});

test("stands down when a pass would reclaim too little to be worth the cache break", () => {
  // Over the line, but the pressure is the tool schemas, not the transcript.
  // Compacting here would cost a full prefix-cache re-read to save almost
  // nothing — and would re-fire on the next step, since the schemas never
  // shrink. Standing down is the only stable answer.
  const messages = transcript(4, 40);
  const contextLength = 20_000;
  const schemaTokens = 18_000;
  const before = JSON.stringify(messages);

  const decision = decideCompaction({ messages, contextLength, schemaTokens, trigger: "pressure" });
  assert.equal(decision.action, "none");
  assert.equal(JSON.stringify(messages), before);

  const plan = planPrune(messages);
  assert.ok(plan.reclaimedTokens < contextLength * MIN_RECLAIM_RATIO);
});

test("prunes rather than folds when pruning alone is enough", () => {
  const messages = transcript(30, STALE_TOOL_RESULT_CAP * 3);
  const contextLength = Math.ceil(estimateTokens(messages) / 0.85);
  const decision = decideCompaction({ messages, contextLength, trigger: "pressure" });
  assert.equal(decision.action, "prune");
});

test("gives up after MAX_CONSECUTIVE_COMPACTS instead of looping forever", () => {
  // One tool result larger than the whole window: no amount of compaction can
  // repair this, so auto-compaction must stand down rather than re-fire.
  const messages: AgentMessage[] = [
    { role: "system", content: "You are Deyin." },
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "read", arguments: "{}" }] },
    { role: "tool", toolCallId: "c0", toolName: "read", content: "x ".repeat(200_000) },
    { role: "assistant", content: "done" },
  ];
  const contextLength = 8_000;

  assert.notEqual(
    decideCompaction({ messages, contextLength, trigger: "pressure", consecutiveCompacts: 0 }).action,
    "exhausted",
  );
  assert.equal(
    decideCompaction({
      messages,
      contextLength,
      trigger: "pressure",
      consecutiveCompacts: MAX_CONSECUTIVE_COMPACTS,
    }).action,
    "exhausted",
  );
});

// ---------------------------------------------------------------------------
// Fold request shape — the cache-alignment contract
// ---------------------------------------------------------------------------

/** Capture the request body a fold sends, without a network round trip. */
async function captureFoldRequest(
  messages: AgentMessage[],
  region: { start: number; end: number; tokens: number },
  reply: string,
  extra: Record<string, unknown> = {},
): Promise<{ body: Record<string, unknown>; result: Awaited<ReturnType<typeof foldRegion>> }> {
  let body: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      body = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: null }] })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const result = await foldRegion({
      apiBaseUrl: `http://127.0.0.1:${port}`,
      token: "t",
      model: "test-model",
      messages,
      region,
      ...extra,
    });
    return { body, result };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("the fold replays the run's real prefix so the provider can serve it from cache", async () => {
  const messages = transcript(6, 400);
  const region = selectRegion(messages, TAIL);
  const tools = [
    { type: "function" as const, function: { name: "read", description: "read a file", parameters: { type: "object" } } },
  ];
  // foldRegion splices the summary into `messages`, so capture what the ordinary
  // request would have sent BEFORE the fold runs.
  const expected = buildWireMessages(messages.slice(0, region.end), {}).messages;
  const { body } = await captureFoldRequest(messages, region, "## Goal\nbriefing", { tools });

  const sent = body.messages as { role: string; content: unknown }[];
  // Everything before the appended instruction must be the ordinary request's
  // own prefix, byte for byte — that identity IS the cache hit.
  assert.equal(sent.length, region.end + 1, "the fold sent something other than prefix + one instruction");
  assert.deepEqual(sent.slice(0, region.end), expected);
  // The last message is the only new content.
  assert.equal(sent[sent.length - 1]!.role, "user");
  assert.match(String(sent[sent.length - 1]!.content), /## Goal/);
  // The same tool schemas ride along, because they sit in the cached prefix too.
  assert.deepEqual(body.tools, tools);
  // And the output is capped, so a fold cannot bill for a full-length completion.
  assert.equal(body.max_tokens, SUMMARY_OUTPUT_MAX_TOKENS);
});

test("a fold whose summary is not smaller than the region it replaces is rejected", async () => {
  const messages = transcript(6, 400);
  const region = selectRegion(messages, TAIL);
  const before = messages.length;
  // A "summary" far larger than the region: taking it would cost a model call
  // AND a cache reset to make the pressure problem worse.
  const { result } = await captureFoldRequest(messages, region, "bloat ".repeat(20_000));
  assert.equal(result.droppedMessages, 0);
  assert.equal(result.reclaimedTokens, 0);
  assert.equal(messages.length, before, "the transcript must be left untouched");
});

test("a successful fold replaces the region and reports what it reclaimed", async () => {
  const messages = transcript(6, 400);
  const region = selectRegion(messages, TAIL);
  const before = messages.length;
  const { result } = await captureFoldRequest(messages, region, "## Goal\nshort briefing");
  assert.ok(result.droppedMessages > 0);
  assert.ok(result.reclaimedTokens > 0);
  assert.equal(messages.length, before - result.droppedMessages + 1);
  assert.equal(messages[0]!.role, "system", "the system prompt is never folded");
});
