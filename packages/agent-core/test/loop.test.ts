import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgent } from "../src/loop.js";
import { PermissionEngine } from "../src/permissions.js";
import { createBuiltinRegistry } from "../src/tools/index.js";
import type { AgentMessage } from "../src/types.js";
import { startMockOpenAI, textResponse, toolCallResponse } from "./helpers/mock-openai.js";

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
