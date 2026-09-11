import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createContext } from "../src/context.js";
import { EXIT_AUTH, EXIT_OK, runHeadless } from "../src/headless.js";
import { CheckpointStore } from "@deyin/host-core";
import { startMockOpenAI, textResponse, toolCallResponse } from "./helpers/mock-openai.js";

function capture(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let buffer = "";
  stream.on("data", (c: Buffer) => (buffer += c.toString("utf8")));
  return { stream, text: () => buffer };
}

function makeCtx(apiBaseUrl: string): { ctx: ReturnType<typeof createContext>; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), "deyin-data-"));
  const cwd = mkdtempSync(join(tmpdir(), "deyin-ws-"));
  const previous = process.env.DEYIN_DATA_DIR;
  process.env.DEYIN_DATA_DIR = dataDir;
  const ctx = createContext({ cwd, overrides: { apiBaseUrl, model: "test-model" } });
  if (previous === undefined) delete process.env.DEYIN_DATA_DIR;
  else process.env.DEYIN_DATA_DIR = previous;
  return {
    ctx,
    cleanup: () => {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

test("plain run streams text to stdout, persists the session and exits 0", async () => {
  const server = await startMockOpenAI(() => textResponse("All done here."));
  const { ctx, cleanup } = makeCtx(server.url);
  const out = capture();
  const err = capture();
  try {
    const code = await runHeadless({
      ctx,
      prompt: "say hi",
      stdout: out.stream,
      stderr: err.stream,
      getToken: async () => "test-token",
    });
    assert.equal(code, EXIT_OK);
    assert.ok(out.text().includes("All done here."));

    // Session persisted: one .jsonl with system + user + assistant records.
    const sessionsDir = join(ctx.dataDir, "sessions");
    assert.ok(existsSync(sessionsDir));
    assert.equal(readdirSync(sessionsDir).length, 1);
    const sessions = ctx.sessions.list();
    assert.equal(sessions[0]?.messageCount, 3);
    assert.equal(sessions[0]?.title, "say hi");

    // The request carried the system prompt and declared the built-in tools.
    const wire = server.requests[0]!;
    const messages = wire.messages as { role: string; content?: string }[];
    assert.equal(messages[0]?.role, "system");
    assert.ok(messages[0]?.content?.includes("Deyin"));
    const tools = wire.tools as { function: { name: string } }[];
    assert.ok(tools.some((t) => t.function.name === "bash"));
    assert.ok(tools.some((t) => t.function.name === "generate_image"));

    // Usage recorded locally.
    assert.equal(ctx.usage.stats().totalTokens, 15);
  } finally {
    await server.close();
    cleanup();
  }
});

test("--json emits NDJSON events ending with a result record", async () => {
  const server = await startMockOpenAI(() => textResponse("json mode"));
  const { ctx, cleanup } = makeCtx(server.url);
  const out = capture();
  try {
    const code = await runHeadless({
      ctx,
      prompt: "hello",
      json: true,
      stdout: out.stream,
      stderr: capture().stream,
      getToken: async () => "test-token",
    });
    assert.equal(code, EXIT_OK);
    const events = out
      .text()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; [k: string]: unknown });
    assert.ok(events.some((e) => e.type === "text-delta"));
    const result = events.at(-1)!;
    assert.equal(result.type, "result");
    assert.equal(result.reason, "completed");
    assert.equal(result.finalText, "json mode");
  } finally {
    await server.close();
    cleanup();
  }
});

test("write tools are auto-denied without --yes and executed with it", async () => {
  const script = (i: number): unknown[] =>
    i === 0 ? toolCallResponse("call_w", "write", { path: "out.txt", content: "data" }) : textResponse("done");

  // Without --yes: denied.
  const server1 = await startMockOpenAI(script);
  const one = makeCtx(server1.url);
  const out1 = capture();
  try {
    const code = await runHeadless({
      ctx: one.ctx,
      prompt: "write the file",
      json: true,
      stdout: out1.stream,
      stderr: capture().stream,
      getToken: async () => "t",
    });
    assert.equal(code, EXIT_OK);
    const events = out1.text().trim().split("\n").map((l) => JSON.parse(l) as { type: string; denied?: boolean });
    assert.ok(events.some((e) => e.type === "tool-end" && e.denied === true));
    assert.ok(!existsSync(join(one.ctx.cwd, "out.txt")));
  } finally {
    await server1.close();
    one.cleanup();
  }

  // With --yes: executed.
  const server2 = await startMockOpenAI(script);
  const two = makeCtx(server2.url);
  const err2 = capture();
  try {
    const code = await runHeadless({
      ctx: two.ctx,
      prompt: "write the file",
      yes: true,
      stdout: capture().stream,
      stderr: err2.stream,
      getToken: async () => "t",
    });
    assert.equal(code, EXIT_OK);
    assert.ok(existsSync(join(two.ctx.cwd, "out.txt")));
    const session = two.ctx.sessions.list()[0];
    assert.ok(session);
    const entries = new CheckpointStore(two.ctx.storage).list(session.id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.path, join(two.ctx.cwd, "out.txt"));
    assert.match(err2.text(), /\[checkpoint\]/);
  } finally {
    await server2.close();
    two.cleanup();
  }
});

test("exits 2 when not signed in", async () => {
  const server = await startMockOpenAI(() => textResponse("never reached"));
  const { ctx, cleanup } = makeCtx(server.url);
  const err = capture();
  try {
    const code = await runHeadless({
      ctx,
      prompt: "hi",
      stdout: capture().stream,
      stderr: err.stream,
      getToken: async () => null,
    });
    assert.equal(code, EXIT_AUTH);
    assert.ok(err.text().includes("not signed in"));
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
    cleanup();
  }
});

test("routes a provider::model reference through the shared provider registry", async () => {
  const server = await startMockOpenAI(() => textResponse("custom provider"));
  const { ctx, cleanup } = makeCtx("http://127.0.0.1:9/unused");
  ctx.agents.addProvider({ name: "Test Provider", baseUrl: server.url });
  ctx.agents.setKey("test-provider", "provider-secret");
  ctx.config.model = "test-provider::test-model";
  try {
    const code = await runHeadless({
      ctx,
      prompt: "use the custom provider",
      stdout: capture().stream,
      stderr: capture().stream,
      getToken: async () => null,
    });
    assert.equal(code, EXIT_OK);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]?.model, "test-model");
  } finally {
    await server.close();
    cleanup();
  }
});

test("attaches workspace text files to a headless prompt", async () => {
  const server = await startMockOpenAI(() => textResponse("attachment read"));
  const { ctx, cleanup } = makeCtx(server.url);
  writeFileSync(join(ctx.cwd, "notes.txt"), "attachment payload");
  try {
    const code = await runHeadless({
      ctx,
      prompt: "summarize the attachment",
      files: ["notes.txt"],
      stdout: capture().stream,
      stderr: capture().stream,
      getToken: async () => "t",
    });
    assert.equal(code, EXIT_OK);
    const messages = server.requests[0]?.messages as Array<{ role: string; content?: unknown }>;
    const user = messages.find((message) => message.role === "user");
    assert.equal(typeof user?.content, "string");
    assert.match(user?.content as string, /attachment payload/);
  } finally {
    await server.close();
    cleanup();
  }
});

test("--continue reuses the previous session transcript", async () => {
  const server = await startMockOpenAI(() => textResponse("first"));
  const { ctx, cleanup } = makeCtx(server.url);
  try {
    await runHeadless({ ctx, prompt: "one", stdout: capture().stream, stderr: capture().stream, getToken: async () => "t" });

    const server2 = await startMockOpenAI(() => textResponse("second"));
    const ctx2 = createContext({ cwd: ctx.cwd, overrides: { apiBaseUrl: server2.url, model: "test-model" } });
    // Point the second context at the same data dir contents via the same sessions path.
    const code = await runHeadless({
      ctx: { ...ctx2, sessions: ctx.sessions, usage: ctx.usage, dataDir: ctx.dataDir, storage: ctx.storage },
      prompt: "two",
      continueLast: true,
      stdout: capture().stream,
      stderr: capture().stream,
      getToken: async () => "t",
    });
    assert.equal(code, EXIT_OK);
    const wire = server2.requests[0]!;
    const roles = (wire.messages as { role: string; content?: string }[]).map((m) => m.role);
    // system + user(one) + assistant(first) + user(two)
    assert.deepEqual(roles, ["system", "user", "assistant", "user"]);
    await server2.close();
  } finally {
    await server.close();
    cleanup();
  }
});

test("trusted workspace hooks add session context and can veto tools", async () => {
  const server = await startMockOpenAI((i) =>
    i === 0
      ? toolCallResponse("hook_write", "write", { path: "blocked.txt", content: "nope" })
      : textResponse("finished"),
  );
  const { ctx, cleanup } = makeCtx(server.url);
  mkdirSync(join(ctx.cwd, ".deyin"), { recursive: true });
  writeFileSync(
    join(ctx.cwd, ".deyin", "hooks.json"),
    JSON.stringify({
      hooks: {
        sessionStart: [{ command: "node -e \"console.log(JSON.stringify({additional_context:'hook-context'}))\"" }],
        preToolUse: [{ command: "node -e \"process.exit(2)\"", matcher: "^write$" }],
      },
    }),
  );
  const out = capture();
  try {
    const code = await runHeadless({
      ctx,
      prompt: "write the file",
      yes: true,
      json: true,
      trustWorkspace: true,
      stdout: out.stream,
      stderr: capture().stream,
      getToken: async () => "t",
    });
    assert.equal(code, EXIT_OK);
    const events = out.text().trim().split("\n").map((line) => JSON.parse(line) as { type: string; denied?: boolean });
    assert.ok(events.some((event) => event.type === "tool-end" && event.denied === true));
    assert.ok(!existsSync(join(ctx.cwd, "blocked.txt")));
    const messages = server.requests[0]!.messages as { role: string; content?: string }[];
    assert.ok(messages[0]?.content?.includes("hook-context"));
  } finally {
    await server.close();
    cleanup();
  }
});
