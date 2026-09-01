import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPrune, planPrune, STALE_TOOL_RESULT_CAP, TAIL_TOKENS } from "../../compaction.js";
import type { AgentMessage } from "../../types.js";
import {
  buildPromptCacheKey,
  canonicalizeToolSchemas,
  comparePrefixShapes,
  computePrefixShape,
  hashSystemPrompt,
  hashToolSchemas,
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

test("only a surface-changing compaction bumps the log rewrite version", () => {
  let version = 0;
  const bump = (reclaimed: number) => {
    if (reclaimed > 0) version += 1;
  };

  // Under pressure the plan is empty, so nothing about the prefix moves and the
  // provider's cached prefix stays valid.
  const small: AgentMessage[] = [
    { role: "system", content: "You are Deyin." },
    { role: "user", content: "hi" },
  ];
  bump(planPrune(small).reclaimedTokens);
  assert.equal(version, 0);

  // A transcript with stale oversized tool results, padded past the verbatim
  // tail so the early ones are actually prunable.
  const big: AgentMessage[] = [
    { role: "system", content: "You are Deyin." },
    { role: "user", content: "build" },
  ];
  for (let i = 0; i < 12; i++) {
    big.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id: `c${i}`, name: "read", arguments: "{}" }],
    });
    big.push({ role: "tool", toolCallId: `c${i}`, toolName: "read", content: "x ".repeat(STALE_TOOL_RESULT_CAP * 3) });
  }
  const plan = planPrune(big, { tailBudget: Math.floor(TAIL_TOKENS / 8) });
  assert.ok(plan.reclaimedTokens > 0);
  applyPrune(big, plan);
  bump(plan.reclaimedTokens);
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
