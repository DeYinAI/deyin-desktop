import assert from "node:assert/strict";
import { test } from "node:test";
import { compactMessages } from "../../compaction.js";
import type { AgentMessage } from "../../types.js";
import {
  buildPromptCacheKey,
  canonicalizeToolSchemas,
  comparePrefixShapes,
  computePrefixShape,
  hashSystemPrompt,
  hashToolSchemas,
  shouldBumpLogRewriteVersion,
} from "../prefix-tracker.js";

const tool = (name: string, description = "desc") => ({
  type: "function" as const,
  function: { name, description, parameters: { type: "object", properties: {} } },
});

test("system prompt rebuilds produce identical hash bytes", () => {
  const build = () =>
    [
      "You are Deyin.",
      "Mode: build",
      "Skills: read, write",
      "Memory index v3",
    ].join("\n");

  const first = build();
  const second = build();
  assert.equal(first, second);
  assert.equal(hashSystemPrompt(first), hashSystemPrompt(second));
});

test("system prompt hash changes when content differs", () => {
  const a = hashSystemPrompt("You are Deyin.");
  const b = hashSystemPrompt("You are Deyin!\n");
  assert.notEqual(a, b);
});

test("tool registry changes are detected via toolsHash", () => {
  const base = [tool("glob"), tool("read")];
  const reordered = [tool("read"), tool("glob")];
  const added = [tool("glob"), tool("read"), tool("write")];

  assert.equal(hashToolSchemas(base), hashToolSchemas(reordered));
  assert.notEqual(hashToolSchemas(base), hashToolSchemas(added));
});

test("tool schema canonicalization is stable across key order", () => {
  const a = [
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    },
  ];
  const b = [
    {
      function: {
        parameters: { required: ["path"], properties: { path: { type: "string" } }, type: "object" },
        description: "Read a file",
        name: "read",
      },
      type: "function",
    },
  ];

  assert.equal(canonicalizeToolSchemas(a), canonicalizeToolSchemas(b));
  assert.equal(hashToolSchemas(a), hashToolSchemas(b));
});

test("comparePrefixShapes attributes system, tools, and log_rewrite churn", () => {
  const base = computePrefixShape({ role: "system", content: "sys" }, [tool("read")], 0, 100);
  const systemChanged = computePrefixShape({ role: "system", content: "sys!" }, [tool("read")], 0, 100);
  const toolsChanged = computePrefixShape({ role: "system", content: "sys" }, [tool("read"), tool("write")], 0, 120);
  const rewriteChanged = computePrefixShape({ role: "system", content: "sys" }, [tool("read")], 1, 100);

  const sysDiag = comparePrefixShapes(base, systemChanged, 0, 100);
  assert.ok(sysDiag.prefixChanged);
  assert.deepEqual(sysDiag.changeReasons, ["system"]);

  const toolsDiag = comparePrefixShapes(base, toolsChanged, 50, 50);
  assert.ok(toolsDiag.prefixChanged);
  assert.deepEqual(toolsDiag.changeReasons, ["tools"]);

  const rewriteDiag = comparePrefixShapes(base, rewriteChanged, 80, 20);
  assert.ok(rewriteDiag.prefixChanged);
  assert.deepEqual(rewriteDiag.changeReasons, ["log_rewrite"]);
});

test("compaction bumps log rewrite version only on hard mutations", () => {
  let version = 0;
  const bump = (compaction: ReturnType<typeof compactMessages>) => {
    if (shouldBumpLogRewriteVersion(compaction)) version += 1;
  };

  const small: AgentMessage[] = [
    { role: "system", content: "You are Deyin." },
    { role: "user", content: "hi" },
  ];
  const softOnly = compactMessages([...small], 10); // under budget -> no op
  bump(softOnly);
  assert.equal(version, 0);

  // Soft warning path: 50-60% usage, no mutation
  const softWarning = { truncatedToolResults: 0, truncatedToolArgs: 0, droppedMessages: 0, softWarning: true };
  assert.equal(shouldBumpLogRewriteVersion(softWarning), false);
  bump(softWarning);
  assert.equal(version, 0);

  const big = compactMessages(
    [
      { role: "system", content: "You are Deyin." },
      { role: "user", content: "build" },
      ...Array.from({ length: 8 }, (_, i) => ({
        role: "assistant" as const,
        content: "",
        toolCalls: [{ id: `c${i}`, name: "write", arguments: JSON.stringify({ path: `f${i}.txt`, content: "x".repeat(5000) }) }],
      })).flatMap((m, i) => [
        m,
        { role: "tool" as const, toolCallId: `c${i}`, toolName: "write", content: "ok" },
      ]),
    ],
    800,
  );
  assert.ok(shouldBumpLogRewriteVersion(big));
  bump(big);
  assert.equal(version, 1);

  const shapeBefore = computePrefixShape({ role: "system", content: "You are Deyin." }, [tool("read")], version - 1, 50);
  const shapeAfter = computePrefixShape({ role: "system", content: "You are Deyin." }, [tool("read")], version, 50);
  const diag = comparePrefixShapes(shapeBefore, shapeAfter, 0, 0);
  assert.deepEqual(diag.changeReasons, ["log_rewrite"]);
});

test("buildPromptCacheKey is stable for identical prefix components", () => {
  const sys = hashSystemPrompt("sys");
  const tools = hashToolSchemas([tool("read")]);
  const a = buildPromptCacheKey("deepseek-chat", "agent", sys, tools);
  const b = buildPromptCacheKey("deepseek-chat", "agent", sys, tools);
  assert.equal(a, b);
  assert.notEqual(a, buildPromptCacheKey("deepseek-chat", "plan", sys, tools));
});
