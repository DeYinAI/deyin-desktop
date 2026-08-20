import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TerminalManager } from "@deyin/host-core";
import type { AgentEventEnvelope } from "@deyin/host-core/shared";
import { WebAgentHost } from "../src/server/agent-host.js";

/* Minimal OpenAI-compatible SSE mock (same wire format as agent-core's helper). */
type ResponseScript = (requestIndex: number) => unknown[];

async function startMockOpenAI(script: ResponseScript) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const index = requests.length;
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of script(index)) {
        res.write(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const textResponse = (text: string): unknown[] => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
];

const toolCallResponse = (id: string, name: string, args: object): unknown[] => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];

function makeHost(root: string, envelopes: AgentEventEnvelope[]): WebAgentHost {
  return new WebAgentHost(
    root,
    new TerminalManager({ onData: () => undefined, onExit: () => undefined }),
    (envelope) => envelopes.push(envelope),
    () => undefined,
  );
}

async function waitForDone(envelopes: AgentEventEnvelope[], timeoutMs = 15_000): Promise<AgentEventEnvelope> {
  const start = Date.now();
  for (;;) {
    const done = envelopes.find((e) => e.event.type === "done");
    if (done) return done;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for done");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function baseOptions(overrides: Partial<Parameters<WebAgentHost["start"]>[0]> = {}) {
  return {
    threadId: "thread-1",
    prompt: "hi",
    model: "mock-model",
    thinking: false,
    approvalMode: "full-access" as const,
    mode: "agent" as const,
    history: [],
    provider: { baseUrl: "", token: "test-token", apiFormat: "chat-completions" as const },
    ...overrides,
  };
}

test("web agent: streams text and always emits done", async () => {
  const server = await startMockOpenAI(() => textResponse("Hello from the sandbox"));
  const root = mkdtempSync(join(tmpdir(), "deyin-web-agent-"));
  const envelopes: AgentEventEnvelope[] = [];
  const host = makeHost(root, envelopes);
  try {
    host.start(baseOptions({ provider: { baseUrl: server.url, token: "t", apiFormat: "chat-completions" } }));
    const done = await waitForDone(envelopes);

    assert.equal(done.event.type, "done");
    if (done.event.type === "done") assert.equal(done.event.reason, "completed");
    const text = envelopes
      .filter((e) => e.event.type === "text-delta")
      .map((e) => (e.event.type === "text-delta" ? e.event.delta : ""))
      .join("");
    assert.equal(text, "Hello from the sandbox");
    // Exactly one done — the run-finally path must not double-emit.
    assert.equal(envelopes.filter((e) => e.event.type === "done").length, 1);
  } finally {
    host.dispose();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("web agent: tools execute inside the sandbox root", async () => {
  let request = 0;
  const server = await startMockOpenAI(() => {
    request += 1;
    if (request === 1) return toolCallResponse("call-1", "write", { path: "notes.txt", content: "sandboxed" });
    return textResponse("wrote it");
  });
  const root = mkdtempSync(join(tmpdir(), "deyin-web-agent-"));
  const envelopes: AgentEventEnvelope[] = [];
  const host = makeHost(root, envelopes);
  try {
    host.start(baseOptions({ provider: { baseUrl: server.url, token: "t", apiFormat: "chat-completions" } }));
    await waitForDone(envelopes);

    assert.ok(existsSync(join(root, "notes.txt")), "file written inside sandbox");
    assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "sandboxed");
    const toolStart = envelopes.find((e) => e.event.type === "tool-start");
    assert.ok(toolStart, "tool-start forwarded");
    const toolEnd = envelopes.find((e) => e.event.type === "tool-end");
    assert.ok(toolEnd && toolEnd.event.type === "tool-end" && toolEnd.event.ok, "tool-end ok");
  } finally {
    host.dispose();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("web agent: provider failure surfaces an error and unlocks with done", async () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-web-agent-"));
  const envelopes: AgentEventEnvelope[] = [];
  const host = makeHost(root, envelopes);
  try {
    // Point at a closed port: the run must reject, emit error + done(aborted).
    host.start(baseOptions({ provider: { baseUrl: "http://127.0.0.1:9/v1", token: "t", apiFormat: "chat-completions" } }));
    const done = await waitForDone(envelopes);
    assert.equal(done.event.type, "done");
    if (done.event.type === "done") assert.equal(done.event.reason, "aborted");
    assert.ok(envelopes.some((e) => e.event.type === "error"), "error event emitted");
  } finally {
    host.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("web agent: enter_plan_mode emits mode-changed and create_plan reaches the UI inside the sandbox", async () => {
  let request = 0;
  const server = await startMockOpenAI(() => {
    request += 1;
    if (request === 1) return toolCallResponse("call-1", "enter_plan_mode", {});
    if (request === 2)
      return toolCallResponse("call-2", "create_plan", {
        name: "Fix login flow",
        overview: "Patch the session cookie path.",
        plan: "# Fix login flow\n\n1. Edit auth.ts\n2. Test",
        todos: [{ id: "step-1", content: "Edit auth.ts" }],
      });
    return textResponse("planned");
  });
  const root = mkdtempSync(join(tmpdir(), "deyin-web-agent-"));
  const envelopes: AgentEventEnvelope[] = [];
  const host = makeHost(root, envelopes);
  try {
    host.start(baseOptions({ provider: { baseUrl: server.url, token: "t", apiFormat: "chat-completions" } }));
    await waitForDone(envelopes);

    const modeChanged = envelopes.find((e) => e.event.type === "mode-changed");
    assert.ok(modeChanged, "mode-changed emitted");
    if (modeChanged?.event.type === "mode-changed") {
      assert.equal(modeChanged.event.mode, "plan");
      assert.equal(modeChanged.event.previousMode, "agent");
    }

    const planCreated = envelopes.find((e) => e.event.type === "plan-created");
    assert.ok(planCreated, "plan-created emitted");
    if (planCreated?.event.type === "plan-created") {
      assert.equal(planCreated.event.name, "Fix login flow");
      assert.equal(planCreated.event.plan, "# Fix login flow\n\n1. Edit auth.ts\n2. Test");
      assert.ok(
        planCreated.event.filePath?.startsWith(join(root, ".deyin", "plans")),
        "plan file lands inside the sandbox, not the server home",
      );
      assert.ok(existsSync(planCreated.event.filePath ?? ""), "plan file exists on disk");
    }
  } finally {
    host.dispose();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("web agent: exit_plan_mode switches back to the previous mode", async () => {
  let request = 0;
  const server = await startMockOpenAI(() => {
    request += 1;
    if (request === 1) return toolCallResponse("call-1", "enter_plan_mode", {});
    if (request === 2) return toolCallResponse("call-2", "exit_plan_mode", { userApproved: true });
    return textResponse("implementing");
  });
  const root = mkdtempSync(join(tmpdir(), "deyin-web-agent-"));
  const envelopes: AgentEventEnvelope[] = [];
  const host = makeHost(root, envelopes);
  try {
    host.start(baseOptions({ provider: { baseUrl: server.url, token: "t", apiFormat: "chat-completions" } }));
    await waitForDone(envelopes);

    const modes = envelopes
      .filter((e) => e.event.type === "mode-changed")
      .map((e) => (e.event.type === "mode-changed" ? e.event.mode : ""));
    assert.deepEqual(modes, ["plan", "agent"], "mode switches plan → agent");
  } finally {
    host.dispose();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
