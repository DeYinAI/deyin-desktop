import assert from "node:assert/strict";
import { test } from "node:test";
import {
  estimateContextUsage,
  estimateToolSchemaTokens,
  splitToolSchemaTokens,
} from "../src/context-usage.js";
import { TASK_SUBAGENT_CATALOG_MARKER } from "../src/tools/task.js";
import type { AgentMessage, WireTool } from "../src/types.js";

function tool(name: string, description = "desc"): WireTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    },
  };
}

test("splitToolSchemaTokens buckets mcp and task catalog", () => {
  const task = tool(
    "task",
    `Delegate work.\n${TASK_SUBAGENT_CATALOG_MARKER}- explorer: finds files\n- reviewer: reviews code`,
  );
  const split = splitToolSchemaTokens([tool("read"), tool("mcp__fs__list"), task]);
  assert.ok(split.tools > 0);
  assert.ok(split.mcp > 0);
  assert.ok(split.subagents > 0);
  // MCP tools must not land in the builtin bucket.
  const mcpOnly = splitToolSchemaTokens([tool("mcp__fs__list")]);
  assert.equal(mcpOnly.tools, 0);
  assert.ok(mcpOnly.mcp > 0);
});

test("task catalog split conserves full schema tokens", () => {
  const task = tool(
    "task",
    `Delegate work.\n${TASK_SUBAGENT_CATALOG_MARKER}- explorer: finds files\n- reviewer: reviews code with a longer description`,
  );
  const split = splitToolSchemaTokens([task]);
  assert.equal(split.tools + split.subagents, estimateToolSchemaTokens(task));
  assert.ok(split.subagents > 0);
});

test("estimateContextUsage aggregates non-overlapping categories", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "ignored when sections provided" },
    { role: "user", content: "hello world" },
    { role: "assistant", content: "hi there" },
  ];
  const snap = estimateContextUsage({
    contextLength: 100_000,
    messages,
    systemSections: {
      system: "You are Deyin. Mode agent. Environment and tool rules here.",
      skills: "# Skills\n- create-skill: make a skill",
      rules: "# Project instructions from AGENTS.md\nAlways use TypeScript.",
    },
    tools: [tool("read"), tool("mcp__git__status")],
  });

  assert.ok(snap.usedTokens > 0);
  assert.ok(snap.percent >= 0 && snap.percent <= 100);
  assert.equal(snap.contextLength, 100_000);

  const byId = Object.fromEntries(snap.categories.map((c) => [c.id, c.tokens]));
  assert.ok(byId.system! > 0);
  assert.ok(byId.skills! > 0);
  assert.ok(byId.rules! > 0);
  assert.ok(byId.tools! > 0);
  assert.ok(byId.mcp! > 0);
  assert.ok(byId.conversation! > 0);

  const sum = snap.categories.reduce((s, c) => s + c.tokens, 0);
  assert.equal(sum, snap.usedTokens);
});

test("percent is 0 and contextLength stays 0 when unknown", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "u" },
  ];
  const missing = estimateContextUsage({ messages });
  assert.equal(missing.percent, 0);
  assert.equal(missing.contextLength, 0);
  const zero = estimateContextUsage({ messages, contextLength: 0 });
  assert.equal(zero.percent, 0);
  assert.equal(zero.contextLength, 0);
});

test("percent caps at 100 when over budget", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "x".repeat(4000) },
  ];
  const snap = estimateContextUsage({ messages, contextLength: 10 });
  assert.equal(snap.percent, 100);
  assert.ok(snap.usedTokens > 10);
});

test("tool schemas are included in usedTokens", () => {
  const messages: AgentMessage[] = [{ role: "user", content: "hi" }];
  const without = estimateContextUsage({ messages, contextLength: 10_000 });
  const bigTool = tool("read", "x".repeat(2000));
  const withTools = estimateContextUsage({
    messages,
    contextLength: 10_000,
    tools: [bigTool],
  });
  assert.ok(withTools.usedTokens > without.usedTokens);
  assert.ok(withTools.categories.find((c) => c.id === "tools")!.tokens >= estimateToolSchemaTokens(bigTool));
});

test("falls back to full system message when sections omitted", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "Full system prompt body" },
    { role: "user", content: "q" },
  ];
  const snap = estimateContextUsage({ messages, contextLength: 50_000 });
  const system = snap.categories.find((c) => c.id === "system")!;
  assert.ok(system.tokens > 0);
  assert.equal(snap.categories.find((c) => c.id === "skills")!.tokens, 0);
});

test("wire compression stats use tokenizer-compatible units", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "You are Deyin." },
    { role: "user", content: "read this\n\n\n\nfile with   lots of   whitespace\n\n" },
    {
      role: "tool",
      toolCallId: "c1",
      toolName: "read",
      content: "line1\nline1\nline1\nline2\n" + "x".repeat(500),
    },
  ];
  const snap = estimateContextUsage({
    messages,
    contextLength: 50_000,
    wire: { enableCompression: true, compressionMode: "balanced" },
  });
  assert.ok(snap.wire);
  assert.equal(typeof snap.wire!.originalTokens, "number");
  assert.equal(typeof snap.wire!.compressedTokens, "number");
  assert.ok(snap.wire!.originalTokens > 0);
  // Without compression enabled, wire stats are omitted.
  const raw = estimateContextUsage({ messages, contextLength: 50_000 });
  assert.equal(raw.wire, undefined);
});
