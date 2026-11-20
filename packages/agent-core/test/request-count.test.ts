import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runAgent, type AgentEvent, type AgentRunOptions, type AgentRunResult, type RunSummary } from "../src/loop.js";
import { PermissionEngine } from "../src/permissions.js";
import { DEFAULT_STREAM_RETRY_POLICY } from "../src/stream-errors.js";
import { createBuiltinRegistry } from "../src/tools/index.js";
import type { AgentMessage } from "../src/types.js";
import { multiToolCallResponse, startMockOpenAI, textResponse } from "./helpers/mock-openai.js";

/**
 * How many HTTP requests does a run really send, and does the run summary say so?
 *
 * The UI shows steps and tool rows; the provider bills requests. These tests pin
 * the relationship between the two so "the app sends too many requests" is a
 * checkable claim: one request per step, none for parallel tool calls, and in an
 * outage exactly 1 + maxAttempts (the loop is the only retry layer).
 */

const dirs: string[] = [];
const servers: Server[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const server of servers) server.close();
});

/** The summary is optional on the result type; every run these tests make must report one. */
function summaryOf(result: AgentRunResult): RunSummary {
  assert.ok(result.summary, "the run reports a summary");
  return result.summary;
}

function workdir(): string {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-reqcount-"));
  dirs.push(cwd);
  writeFileSync(join(cwd, "hello.txt"), "hello");
  return cwd;
}

/** A provider that answers `status(i)` with a bare error, else a 200 text reply. Counts every request. */
async function startFlakyProvider(status: (requestIndex: number) => number | null): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const failure = status(hits++);
      if (failure !== null) {
        res.writeHead(failure).end("unavailable");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of textResponse("done.")) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, hits: () => hits };
}

function options(cwd: string, apiBaseUrl: string, extra: Partial<AgentRunOptions> = {}): AgentRunOptions {
  const messages: AgentMessage[] = [
    { role: "system", content: "You are a test agent." },
    { role: "user", content: "go" },
  ];
  return {
    apiBaseUrl,
    getToken: async () => "token",
    model: "test-model",
    messages,
    tools: createBuiltinRegistry(),
    permissions: new PermissionEngine(),
    resolvePermission: async () => "deny",
    cwd,
    // Keep replay waits out of the test clock; the count, not the pacing, is under test.
    streamRetry: { baseDelayMs: 1, maxDelayMs: 1 },
    ...extra,
  };
}

test("httpAttempts equals the requests the provider received; parallel tool calls add none", async () => {
  const cwd = workdir();
  const read = (id: string) => ({ id, name: "read", args: { path: "hello.txt" } });
  const server = await startMockOpenAI((i) =>
    i < 3 ? multiToolCallResponse([read(`a${i}`), read(`b${i}`)]) : textResponse("done."),
  );
  try {
    const result = await runAgent(options(cwd, server.url));

    assert.equal(result.reason, "completed");
    assert.equal(server.requests.length, 4, "three tool steps and a final answer");
    assert.equal(summaryOf(result).steps, 4);
    assert.equal(summaryOf(result).toolCalls, 6, "six tool calls ran locally");
    assert.equal(summaryOf(result).httpAttempts, server.requests.length, "the summary matches the provider's own count");
    assert.equal(summaryOf(result).streamRetries, undefined);
    assert.equal(summaryOf(result).reviewerCalls, undefined);
  } finally {
    await server.close();
  }
});

test("a provider outage costs 1 + maxAttempts requests: the loop is the only retry layer", async () => {
  const cwd = workdir();
  const provider = await startFlakyProvider(() => 503);
  const retries: Extract<AgentEvent, { type: "stream-retry" }>[] = [];

  await assert.rejects(
    runAgent(
      options(cwd, provider.url, {
        onEvent: (event) => {
          if (event.type === "stream-retry") retries.push(event);
        },
      }),
    ),
    /503/,
  );

  const expected = 1 + DEFAULT_STREAM_RETRY_POLICY.maxAttempts;
  // Before this was one layer, a hidden transport retry sat under each replay:
  // (1 + 5) x (1 + 3) = 24 requests for one step, 19 of them never announced.
  assert.equal(provider.hits(), expected);
  assert.equal(retries.length, DEFAULT_STREAM_RETRY_POLICY.maxAttempts, "every replay is announced");
  assert.deepEqual(
    retries.map((r) => r.attempt),
    [1, 2, 3, 4, 5],
  );
  assert.ok(retries.every((r) => r.step === 1), "each notice names the step it belongs to");
});

test("one transient 503 is replayed by the loop, announced, and counted", async () => {
  const cwd = workdir();
  const provider = await startFlakyProvider((i) => (i === 0 ? 503 : null));
  const retries: AgentEvent[] = [];

  const result = await runAgent(
    options(cwd, provider.url, {
      onEvent: (event) => {
        if (event.type === "stream-retry") retries.push(event);
      },
    }),
  );

  assert.equal(result.reason, "completed");
  assert.equal(provider.hits(), 2, "the failed attempt and its replay, nothing hidden");
  assert.equal(summaryOf(result).steps, 1, "a replay is not a step");
  assert.equal(summaryOf(result).httpAttempts, 2);
  assert.equal(summaryOf(result).streamRetries, 1);
  assert.equal(retries.length, 1, "the blip is visible, not silently absorbed");
});

test("goal-reviewer calls are counted, and their requests are part of httpAttempts", async () => {
  const cwd = workdir();
  const server = await startMockOpenAI((i) => {
    if (i === 0) return textResponse("Did step one.");
    if (i === 1) return textResponse(JSON.stringify({ verdict: "continue", reason: "more", next: "step two" }));
    if (i === 2) return textResponse("Did step two.");
    return textResponse(JSON.stringify({ verdict: "done", reason: "ok" }));
  });
  try {
    const result = await runAgent(
      options(cwd, server.url, {
        permissions: new PermissionEngine({ skipAll: true }),
        resolvePermission: async () => "allow",
        goalMaxRounds: 5,
        toolContext: { goalText: "do two steps" },
        applyGoal: () => undefined,
      }),
    );

    assert.equal(result.reason, "completed");
    assert.equal(server.requests.length, 4, "two worker turns and two reviews");
    assert.equal(summaryOf(result).steps, 2, "reviews are not steps");
    assert.equal(summaryOf(result).reviewerCalls, 2);
    assert.equal(summaryOf(result).httpAttempts, 4, "reviewer requests count toward the total");
  } finally {
    await server.close();
  }
});
