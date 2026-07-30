import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgent, type AgentEvent } from "../src/loop.js";
import { PermissionEngine } from "../src/permissions.js";
import { createBuiltinRegistry } from "../src/tools/index.js";
import type { AgentMessage, ToolShell } from "../src/types.js";
import { startMockOpenAI, textResponse, toolCallResponse } from "./helpers/mock-openai.js";

test("bash with ToolShell emits tool-delta then tool-end in order", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-delta-"));
  const server = await startMockOpenAI((i) =>
    i === 0
      ? toolCallResponse("call_shell", "bash", { command: "echo streamed" })
      : textResponse("done"),
  );

  const fakeShell: ToolShell = {
    async run(_command, opts) {
      opts.onData?.("stream-");
      opts.onData?.("chunk");
      return { output: "stream-chunk\n", exitCode: 0 };
    },
  };

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "run it" },
    ];
    const events: AgentEvent[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "tok",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      shell: fakeShell,
      onEvent: (e) => events.push(e),
    });

    assert.equal(result.reason, "completed");

    const start = events.findIndex((e) => e.type === "tool-start" && e.call.id === "call_shell");
    const deltas = events.filter((e) => e.type === "tool-delta" && e.call.id === "call_shell");
    const end = events.findIndex((e) => e.type === "tool-end" && e.call.id === "call_shell");

    assert.ok(start >= 0, "expected tool-start");
    assert.equal(deltas.length, 2);
    assert.deepEqual(
      deltas.map((e) => (e.type === "tool-delta" ? e.delta : "")),
      ["stream-", "chunk"],
    );
    assert.ok(end > start, "tool-end after tool-start");
    assert.ok(
      deltas.every((_, i) => {
        const idx = events.indexOf(deltas[i]!);
        return idx > start && idx < end;
      }),
      "deltas must sit between start and end",
    );

    const endEvent = events[end]!;
    assert.equal(endEvent.type, "tool-end");
    if (endEvent.type === "tool-end") {
      assert.ok(endEvent.result.includes("stream-chunk"));
      assert.equal(endEvent.ok, true);
    }
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bash falls back to spawn only on ShellUnavailableError", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-fallback-"));
  const server = await startMockOpenAI((i) =>
    i === 0
      ? toolCallResponse("call_fb", "bash", { command: "echo fallback-ok" })
      : textResponse("ok"),
  );

  const unavailableShell: ToolShell = {
    async run() {
      const err = new Error("no node-pty");
      err.name = "ShellUnavailableError";
      throw err;
    },
  };

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "run" },
    ];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "tok",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      shell: unavailableShell,
    });

    assert.equal(result.reason, "completed");
    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg && toolMsg.role === "tool");
    if (toolMsg && toolMsg.role === "tool") {
      assert.ok(toolMsg.content.includes("fallback-ok"), `got: ${toolMsg.content}`);
    }
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bash does not re-exec when ToolShell throws a generic mid-run error", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-noexec-"));
  let spawnInvocations = 0;
  // Intercept the spawn-based runCommand by wrapping the registry is awkward;
  // instead assert: a generic Error from the shell surfaces as ERROR: ... and
  // the shell's run was attempted exactly once (no retry via spawn).
  const server = await startMockOpenAI((i) =>
    i === 0
      ? toolCallResponse("call_mid", "bash", { command: "touch /tmp/should-not-run-twice-deyin" })
      : textResponse("ok"),
  );

  let shellRuns = 0;
  const midRunShell: ToolShell = {
    async run(_command, opts) {
      shellRuns += 1;
      opts.onData?.("partial-");
      opts.onData?.("output");
      throw new Error("shell died mid-run");
    },
  };

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "run" },
    ];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "tok",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      shell: midRunShell,
    });

    assert.equal(result.reason, "completed");
    assert.equal(shellRuns, 1, "shell.run must be called exactly once");
    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg && toolMsg.role === "tool");
    if (toolMsg && toolMsg.role === "tool") {
      assert.match(toolMsg.content, /ERROR: shell command failed: shell died mid-run/);
      // Must NOT contain the spawn fallback output ("should-not-run-twice" path
      // would have produced a tool result with empty stdout, but the key guard
      // is that the content reflects the error, not a silent re-exec).
      assert.doesNotMatch(toolMsg.content, /should-not-run-twice/);
    }
    // Track spawn indirectly: clean up if the file was created either way.
    spawnInvocations;
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
