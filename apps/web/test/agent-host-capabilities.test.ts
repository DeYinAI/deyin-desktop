import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CapabilitySnapshot } from "@deyin/agent-core";
import { createTaskTool, TASK_SUBAGENT_CATALOG_MARKER } from "@deyin/agent-core";
import { TerminalManager } from "@deyin/host-core";
import type { AgentEventEnvelope } from "@deyin/host-core/shared";
import { enabledForRun, WebAgentHost } from "../src/server/agent-host.js";

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
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const textResponse = (text: string): unknown[] => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
];

function emptySnap(overrides: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot {
  return {
    skills: [],
    commands: [],
    subagents: [],
    hooks: [],
    mcpServers: [],
    plugins: [],
    scannedAt: Date.now(),
    ...overrides,
  };
}

test("enabledForRun preserves subagent discovery order when filtering disabled caps", () => {
  const snap = emptySnap({
    subagents: [
      { name: "alpha", description: "A", prompt: "a", readonly: true, isBackground: false, source: "built-in" },
      { name: "beta", description: "B", prompt: "b", readonly: true, isBackground: false, source: "workspace" },
      { name: "gamma", description: "G", prompt: "g", readonly: false, isBackground: false, source: "workspace" },
    ],
  });
  const enabled = enabledForRun(snap, new Set(["subagent:beta"]));
  assert.deepEqual(
    enabled.subagents.map((s) => s.name),
    ["alpha", "gamma"],
    "filtering must not reorder remaining subagents",
  );
});

test("createTaskTool catalog lists subagents in the same order as enabledForRun", () => {
  const subagents = enabledForRun(
    emptySnap({
      subagents: [
        { name: "explorer", description: "Explore", prompt: "x", readonly: true, isBackground: false, source: "built-in" },
        { name: "reviewer", description: "Review", prompt: "y", readonly: true, isBackground: false, source: "built-in" },
      ],
    }),
    new Set(),
  ).subagents;

  const tool = createTaskTool({
    subagents,
    runSubagent: async () => ({ ok: true, report: "done" }),
  });

  const catalogStart = tool.description.indexOf(TASK_SUBAGENT_CATALOG_MARKER);
  assert.ok(catalogStart >= 0);
  const catalog = tool.description.slice(catalogStart + TASK_SUBAGENT_CATALOG_MARKER.length);
  const explorerIdx = catalog.indexOf("- explorer:");
  const reviewerIdx = catalog.indexOf("- reviewer:");
  assert.ok(explorerIdx >= 0 && reviewerIdx >= 0);
  assert.ok(explorerIdx < reviewerIdx, "task tool catalog must follow subagent array order");
});

test("web agent: workspace skills appear in the system prompt", async () => {
  const server = await startMockOpenAI(() => textResponse("ok"));
  const root = mkdtempSync(join(tmpdir(), "deyin-web-caps-"));
  const skillDir = join(root, ".deyin", "skills", "deploy-runbook");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: deploy-runbook\ndescription: Production deploy checklist\n---\n\n# Deploy\n",
  );

  const envelopes: AgentEventEnvelope[] = [];
  const host = new WebAgentHost(
    root,
    new TerminalManager({ onData: () => undefined, onExit: () => undefined }),
    (envelope) => envelopes.push(envelope),
    () => undefined,
  );

  try {
    host.start({
      threadId: "caps-thread",
      prompt: "hello",
      model: "mock-model",
      thinking: false,
      approvalMode: "full-access",
      mode: "agent",
      history: [],
      provider: { baseUrl: server.url, token: "t", apiFormat: "chat-completions" },
    });

    const start = Date.now();
    while (!envelopes.some((e) => e.event.type === "done") && Date.now() - start < 15_000) {
      await new Promise((r) => setTimeout(r, 25));
    }

    assert.ok(server.requests.length > 0, "provider was called");
    const messages = server.requests[0]?.messages as Array<{ role: string; content: string }> | undefined;
    const system = messages?.find((m) => m.role === "system")?.content ?? "";
    assert.match(system, /deploy-runbook/, "skill name must be advertised in the system prompt");
    assert.match(system, /Production deploy checklist/);
    assert.match(system, /SKILL.md/);
  } finally {
    host.dispose();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("web agent: unknown slash command aborts without calling the provider", async () => {
  const server = await startMockOpenAI(() => textResponse("should not run"));
  const root = mkdtempSync(join(tmpdir(), "deyin-web-slash-"));
  const envelopes: AgentEventEnvelope[] = [];
  const host = new WebAgentHost(
    root,
    new TerminalManager({ onData: () => undefined, onExit: () => undefined }),
    (envelope) => envelopes.push(envelope),
    () => undefined,
  );

  try {
    host.start({
      threadId: "slash-thread",
      prompt: "/zzzznotfound",
      model: "mock-model",
      thinking: false,
      approvalMode: "full-access",
      mode: "agent",
      history: [],
      provider: { baseUrl: server.url, token: "t", apiFormat: "chat-completions" },
    });

    const start = Date.now();
    while (!envelopes.some((e) => e.event.type === "done") && Date.now() - start < 15_000) {
      await new Promise((r) => setTimeout(r, 25));
    }

    assert.equal(server.requests.length, 0, "unknown slash must abort before LLM call");
    const err = envelopes.find((e) => e.event.type === "error");
    assert.ok(err && err.event.type === "error" && /Unknown command/.test(err.event.message));
    const done = envelopes.find((e) => e.event.type === "done");
    assert.ok(done?.event.type === "done" && done.event.reason === "aborted");
  } finally {
    host.dispose();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
