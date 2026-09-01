import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeMaxSteps, runAgent } from "../src/loop.js";
import { PermissionEngine } from "../src/permissions.js";
import { createBuiltinRegistry } from "../src/tools/index.js";
import type { AgentMessage } from "../src/types.js";
import { startMockOpenAI, textResponse, toolCallResponse, multiToolCallResponse } from "./helpers/mock-openai.js";

function baseMessages(): AgentMessage[] {
  return [
    { role: "system", content: "You are a test agent." },
    { role: "user", content: "what does hello.txt say?" },
  ];
}

test("executes tool calls and feeds results back until the model stops", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-loop-"));
  writeFileSync(join(cwd, "hello.txt"), "hi from the file");
  const server = await startMockOpenAI((i) =>
    i === 0 ? toolCallResponse("call_1", "read", { path: "hello.txt" }) : textResponse("The file says hi."),
  );

  try {
    const messages = baseMessages();
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "test-token",
      model: "test-model",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "deny",
      cwd,
    });

    assert.equal(result.reason, "completed");
    assert.equal(result.finalText, "The file says hi.");
    assert.equal(result.steps, 2);
    assert.equal(result.usage.totalTokens, 15); // only the final text response reports usage

    // Transcript: system, user, assistant(toolCalls), tool result, assistant(text).
    assert.deepEqual(
      messages.map((m) => m.role),
      ["system", "user", "assistant", "tool", "assistant"],
    );
    const toolMsg = messages[3]!;
    assert.equal(toolMsg.role, "tool");
    if (toolMsg.role === "tool") {
      assert.equal(toolMsg.toolCallId, "call_1");
      assert.ok(toolMsg.content.includes("hi from the file"));
    }

    // The second request must carry the tool result in wire format.
    const second = server.requests[1]!;
    const wire = second.messages as { role: string; tool_call_id?: string; content?: string | null }[];
    const wireTool = wire.find((m) => m.role === "tool");
    assert.equal(wireTool?.tool_call_id, "call_1");
    assert.ok(wireTool?.content?.includes("hi from the file"));
    const wireAssistant = wire.find((m) => m.role === "assistant") as { tool_calls?: unknown[]; content: string | null };
    assert.equal(wireAssistant.content, null);
    assert.equal(wireAssistant.tool_calls?.length, 1);
    assert.ok(Array.isArray(second.tools), "tools must be declared on every request");
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("denied tools report back to the model without executing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-deny-"));
  const server = await startMockOpenAI((i) =>
    i === 0 ? toolCallResponse("call_9", "bash", { command: "rm -rf /" }) : textResponse("Understood."),
  );

  try {
    const messages = baseMessages();
    const asked: string[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "test-token",
      model: "test-model",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(), // bash tier=execute -> ask
      resolvePermission: async (req) => {
        asked.push(`${req.toolName}:${req.summary}`);
        return "deny";
      },
      cwd,
    });

    assert.equal(result.reason, "completed");
    assert.deepEqual(asked, ["bash:rm -rf /"]);
    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg && toolMsg.role === "tool" && toolMsg.content.startsWith("Denied:"));
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stops at the step cap when the model keeps calling tools", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-cap-"));
  const server = await startMockOpenAI((i) => toolCallResponse(`call_${i}`, "ls", {}));

  try {
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "test-token",
      model: "test-model",
      messages: baseMessages(),
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "allow",
      cwd,
      maxSteps: 3,
    });
    assert.equal(result.reason, "max-steps");
    assert.equal(result.steps, 3);
    assert.equal(server.requests.length, 3);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("null maxSteps runs unlimited until the model stops", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-unlimited-"));
  // 5 tool-call rounds, then a final text answer: beyond the old default cap.
  const server = await startMockOpenAI((i) =>
    i < 5 ? toolCallResponse(`call_${i}`, "ls", {}) : textResponse("all done"),
  );

  try {
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "test-token",
      model: "test-model",
      messages: baseMessages(),
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "allow",
      cwd,
      maxSteps: null,
    });

    assert.equal(result.reason, "completed");
    assert.equal(result.steps, 6);
    assert.equal(server.requests.length, 6);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("normalizeMaxSteps maps cap overrides", () => {
  assert.equal(normalizeMaxSteps(undefined), 40); // built-in default
  assert.equal(normalizeMaxSteps(null), Number.POSITIVE_INFINITY); // unlimited
  assert.equal(normalizeMaxSteps(0), Number.POSITIVE_INFINITY);
  assert.equal(normalizeMaxSteps(-5), Number.POSITIVE_INFINITY);
  assert.equal(normalizeMaxSteps(Number.NaN), Number.POSITIVE_INFINITY);
  assert.equal(normalizeMaxSteps(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
  assert.equal(normalizeMaxSteps(12.9), 12); // fractional caps floor to a whole step
  assert.equal(normalizeMaxSteps(75), 75);
});

test("unknown tools produce an error result instead of crashing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-unknown-"));
  const server = await startMockOpenAI((i) =>
    i === 0 ? toolCallResponse("call_x", "not_a_tool", {}) : textResponse("ok"),
  );
  try {
    const messages = baseMessages();
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "t",
      model: "m",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "allow",
      cwd,
    });
    assert.equal(result.reason, "completed");
    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg && toolMsg.role === "tool" && toolMsg.content.startsWith("ERROR: unknown tool"));
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("executes multiple tool calls from one step concurrently and preserves result order", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-parallel-"));
  writeFileSync(join(cwd, "a.txt"), "alpha");
  writeFileSync(join(cwd, "b.txt"), "beta");
  const server = await startMockOpenAI((i) =>
    i === 0
      ? multiToolCallResponse([
          { id: "c0", name: "read", args: { path: "a.txt" } },
          { id: "c1", name: "read", args: { path: "b.txt" } },
        ])
      : textResponse("both files read"),
  );

  try {
    const messages = baseMessages();
    const starts: string[] = [];
    const ends: string[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "test-token",
      model: "test-model",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "allow",
      cwd,
      onEvent: (event) => {
        if (event.type === "tool-start") starts.push(event.call.id);
        if (event.type === "tool-end") ends.push(event.call.id);
      },
    });

    assert.equal(result.reason, "completed");
    assert.equal(result.steps, 2);
    assert.equal(server.requests.length, 2);

    const toolMsgs = messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 2);
    const first = toolMsgs[0];
    const second = toolMsgs[1];
    assert.ok(first && first.role === "tool");
    assert.ok(second && second.role === "tool");
    assert.equal(first.toolCallId, "c0");
    assert.equal(second.toolCallId, "c1");
    assert.ok(first.content.includes("alpha"));
    assert.ok(second.content.includes("beta"));
    assert.deepEqual(starts, ["c0", "c1"]);
    assert.ok(ends.includes("c0") && ends.includes("c1"));
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("lookupToolCache short-circuits tool execution and emits fromCache", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-loop-cache-"));
  writeFileSync(join(cwd, "hello.txt"), "should not be read");
  const server = await startMockOpenAI((i) =>
    i === 0 ? toolCallResponse("call_cache", "read", { path: "hello.txt" }) : textResponse("From cache."),
  );
  const lookupCalls: string[] = [];
  const storeCalls: string[] = [];
  const toolEnds: { fromCache?: boolean; result: string }[] = [];

  try {
    const messages = baseMessages();
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "test-token",
      model: "test-model",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "allow",
      cwd,
      lookupToolCache: async (call) => {
        lookupCalls.push(call.name);
        return "cached file body";
      },
      storeToolCache: async (call) => {
        storeCalls.push(call.name);
      },
      onEvent: (event) => {
        if (event.type === "tool-end") toolEnds.push({ fromCache: event.fromCache, result: event.result });
      },
    });

    assert.equal(result.reason, "completed");
    assert.deepEqual(lookupCalls, ["read"]);
    assert.deepEqual(storeCalls, [], "store must not run on cache hit");
    assert.equal(toolEnds.length, 1);
    assert.equal(toolEnds[0]?.fromCache, true);
    assert.equal(toolEnds[0]?.result, "cached file body");
    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg && toolMsg.role === "tool");
    assert.equal(toolMsg.content, "cached file body");
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("same-step edits to one file run exclusively instead of racing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-serial-edit-"));
  writeFileSync(join(cwd, "a.txt"), "one two");
  const server = await startMockOpenAI((i) =>
    i === 0
      ? multiToolCallResponse([
          { id: "e0", name: "edit", args: { path: "a.txt", old_string: "one", new_string: "1" } },
          { id: "e1", name: "edit", args: { path: "a.txt", old_string: "two", new_string: "2" } },
        ])
      : textResponse("edited"),
  );

  try {
    const messages = baseMessages();
    const active: string[] = [];
    let maxOverlap = 0;
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "test-token",
      model: "test-model",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "allow",
      cwd,
      onEvent: (event) => {
        if (event.type === "tool-start") {
          active.push(event.call.id);
          maxOverlap = Math.max(maxOverlap, active.length);
        }
        if (event.type === "tool-end") active.splice(active.indexOf(event.call.id), 1);
      },
    });

    assert.equal(result.reason, "completed");
    // Never two mutations in flight at once — the second edit reads the file as
    // the first one left it.
    assert.equal(maxOverlap, 1);
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "1 2");
    const toolMsgs = messages.filter((m) => m.role === "tool");
    assert.deepEqual(
      toolMsgs.map((m) => (m.role === "tool" ? m.toolCallId : "")),
      ["e0", "e1"],
    );
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the request prefix grows append-only when context stays under pressure", async () => {
  // The property both Anthropic and DeepSeek actually cache on: every request's
  // message array is a strict prefix-extension of the previous one. The old
  // loop compacted on every step, rewriting the middle of the transcript and
  // invalidating the provider's cached prefix each time round.
  const cwd = mkdtempSync(join(tmpdir(), "deyin-prefix-"));
  writeFileSync(join(cwd, "hello.txt"), "hi from the file");
  const server = await startMockOpenAI((i) =>
    i < 5 ? toolCallResponse(`call_${i}`, "read", { path: "hello.txt" }) : textResponse("done"),
  );

  try {
    const messages = baseMessages();
    const compactions: string[] = [];
    await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "test-token",
      model: "test-model",
      contextLength: 200_000,
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "deny",
      cwd,
      onEvent: (event) => {
        if (event.type === "compaction") compactions.push(event.kind);
      },
    });

    assert.equal(compactions.length, 0, "a small session must not compact at all");
    assert.equal(server.requests.length, 6);
    for (let i = 1; i < server.requests.length; i++) {
      const before = server.requests[i - 1]!.messages as Record<string, unknown>[];
      const after = server.requests[i]!.messages as Record<string, unknown>[];
      assert.ok(after.length > before.length, `request ${i} should have grown`);
      assert.deepEqual(
        after.slice(0, before.length),
        before,
        `request ${i} rewrote earlier messages instead of appending`,
      );
    }
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("folds once under real pressure, then keeps the new prefix stable", async () => {
  // A tiny context window plus oversized tool results forces the full ladder:
  // prune, then fold. The point is that it happens ONCE — the old loop
  // compacted on every step and pushed a notice each time, which is the wall of
  // "Context compacted" rows this replaces.
  const cwd = mkdtempSync(join(tmpdir(), "deyin-fold-"));
  writeFileSync(join(cwd, "big.txt"), "lorem ipsum dolor sit amet ".repeat(4000));
  const server = await startMockOpenAI((i) =>
    i < 6 ? toolCallResponse(`call_${i}`, "read", { path: "big.txt" }) : textResponse("done"),
  );
  // Small enough that the builtin tool schemas plus a few file reads blow past
  // FORCE_RATIO, which is what makes this exercise the fold rather than a prune.

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "You are a test agent." },
      { role: "user", content: "read big.txt repeatedly" },
    ];
    const events: { kind: string; reclaimed: number }[] = [];
    await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "test-token",
      model: "test-model",
      contextLength: 4_000,
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "deny",
      cwd,
      onEvent: (event) => {
        if (event.type === "compaction") {
          events.push({ kind: event.kind, reclaimed: event.reclaimedTokens });
        }
      },
    });

    const mutations = events.filter((e) => e.kind === "prune" || e.kind === "fold");
    assert.ok(mutations.length > 0, "pressure this high must compact at least once");
    assert.ok(mutations.length <= 3, `compacted ${mutations.length} times; expected a handful, not one per step`);
    for (const m of mutations) {
      assert.ok(m.reclaimed > 0, `${m.kind} reported no reclaimed tokens`);
    }
    // The system prompt is never part of a compacted region.
    assert.equal(messages[0]?.role, "system");
    assert.equal(messages[0]?.content, "You are a test agent.");
    // The opening user turn is pinned, so the model keeps the task definition.
    assert.equal(messages[1]?.content, "read big.txt repeatedly");
    // The fold left a structured briefing behind in its place.
    assert.ok(
      messages.some((m) => m.role === "user" && m.content.includes("<compaction-summary>")),
      "a fold should leave a compaction-summary node on the surface",
    );
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
