import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  buildRewritePrompt,
  parseRewrittenObjective,
  rewriteGoalObjective,
  REWRITER_SYSTEM_PROMPT,
} from "../src/goal-rewriter.js";
import { MAX_GOAL_OBJECTIVE } from "../src/goal-constants.js";
import { startMockOpenAI, textResponse } from "./helpers/mock-openai.js";

/* Parsing --------------------------------------------------------------------- */

test("parseRewrittenObjective accepts plain text and trims it", () => {
  assert.deepEqual(parseRewrittenObjective("  Make the build pass; show `pnpm build` output.\n"), {
    objective: "Make the build pass; show `pnpm build` output.",
  });
});

test("parseRewrittenObjective strips a fence, a label and wrapping quotes", () => {
  assert.deepEqual(parseRewrittenObjective("```\nShip the fix.\n```"), { objective: "Ship the fix." });
  assert.deepEqual(parseRewrittenObjective("Objective: Ship the fix."), { objective: "Ship the fix." });
  assert.deepEqual(parseRewrittenObjective("Restated objective: Ship the fix."), { objective: "Ship the fix." });
  assert.deepEqual(parseRewrittenObjective('"Ship the fix."'), { objective: "Ship the fix." });
});

test("parseRewrittenObjective keeps inner quotes that do not wrap the whole reply", () => {
  assert.deepEqual(parseRewrittenObjective('Rename "foo" to "bar" everywhere.'), {
    objective: 'Rename "foo" to "bar" everywhere.',
  });
});

test("parseRewrittenObjective rejects empty, oversized and refused replies", () => {
  assert.deepEqual(parseRewrittenObjective("   "), { fallbackReason: "empty" });
  assert.deepEqual(parseRewrittenObjective("```\n\n```"), { fallbackReason: "empty" });
  assert.deepEqual(parseRewrittenObjective("x".repeat(MAX_GOAL_OBJECTIVE + 1)), { fallbackReason: "too-long" });
  assert.deepEqual(parseRewrittenObjective("I'm sorry, I can't help with that."), { fallbackReason: "refused" });
  assert.deepEqual(parseRewrittenObjective("I cannot restate this."), { fallbackReason: "refused" });
});

test("rewriter prompts fence the typed objective as data and forbid inventing requirements", () => {
  const prompt = buildRewritePrompt("  fix the flaky test  ");
  assert.match(prompt, /<typed_objective>\nfix the flaky test\n<\/typed_objective>/);
  assert.match(REWRITER_SYSTEM_PROMPT, /Do not add requirements/);
  assert.match(REWRITER_SYSTEM_PROMPT, /Output only the objective text/);
});

/* Transport ------------------------------------------------------------------- */

test("rewriteGoalObjective returns the model's restatement over a tool-less request", async () => {
  const server = await startMockOpenAI(() =>
    textResponse("Make `pnpm test` pass in packages/ui/client, and show the passing output."),
  );
  try {
    const result = await rewriteGoalObjective({
      apiBaseUrl: server.url,
      token: "t",
      model: "m",
      objective: "fix the client tests",
    });
    assert.equal(result.rewritten, true);
    assert.equal(result.objective, "Make `pnpm test` pass in packages/ui/client, and show the passing output.");
    assert.equal(result.fallbackReason, undefined);
    assert.equal(result.usage?.totalTokens, 15);

    assert.equal(server.requests.length, 1);
    const body = server.requests[0]!;
    const tools = body.tools;
    assert.ok(tools === undefined || (Array.isArray(tools) && tools.length === 0), "rewriter must declare no tools");
    const messages = body.messages as { role: string; content: string }[];
    assert.equal(messages[0]?.role, "system");
    assert.equal(messages[0]?.content, REWRITER_SYSTEM_PROMPT);
    assert.match(messages[1]?.content ?? "", /fix the client tests/);
  } finally {
    await server.close();
  }
});

test("rewriteGoalObjective reports rewritten=false when the model echoes the typed text", async () => {
  const server = await startMockOpenAI(() => textResponse("fix the client tests"));
  try {
    const result = await rewriteGoalObjective({
      apiBaseUrl: server.url,
      token: "t",
      model: "m",
      objective: "fix the client tests",
    });
    assert.equal(result.rewritten, false);
    assert.equal(result.objective, "fix the client tests");
  } finally {
    await server.close();
  }
});

test("rewriteGoalObjective falls back to the typed text on empty output", async () => {
  const server = await startMockOpenAI(() => textResponse("   "));
  try {
    const result = await rewriteGoalObjective({
      apiBaseUrl: server.url,
      token: "t",
      model: "m",
      objective: "  ship it  ",
    });
    assert.deepEqual({ ...result, usage: undefined }, {
      objective: "ship it",
      rewritten: false,
      fallbackReason: "empty",
      usage: undefined,
    });
  } finally {
    await server.close();
  }
});

test("rewriteGoalObjective falls back to the typed text on oversized output", async () => {
  const server = await startMockOpenAI(() => textResponse("y".repeat(MAX_GOAL_OBJECTIVE + 50)));
  try {
    const result = await rewriteGoalObjective({ apiBaseUrl: server.url, token: "t", model: "m", objective: "ship it" });
    assert.equal(result.objective, "ship it");
    assert.equal(result.rewritten, false);
    assert.equal(result.fallbackReason, "too-long");
  } finally {
    await server.close();
  }
});

test("rewriteGoalObjective falls back to the typed text on a refusal", async () => {
  const server = await startMockOpenAI(() => textResponse("I'm sorry, but I can't help with that request."));
  try {
    const result = await rewriteGoalObjective({ apiBaseUrl: server.url, token: "t", model: "m", objective: "ship it" });
    assert.equal(result.objective, "ship it");
    assert.equal(result.fallbackReason, "refused");
  } finally {
    await server.close();
  }
});

/** A bare HTTP server for failure modes the SSE mock cannot express. */
async function startServer(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, server };
}

const stopServer = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

test("rewriteGoalObjective falls back to the typed text when the provider errors", async () => {
  const { url, server } = await startServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "boom" } }));
  });
  try {
    const result = await rewriteGoalObjective({ apiBaseUrl: url, token: "t", model: "m", objective: "ship it" });
    assert.equal(result.objective, "ship it");
    assert.equal(result.rewritten, false);
    assert.equal(result.fallbackReason, "error");
  } finally {
    await stopServer(server);
  }
});

test("rewriteGoalObjective falls back to the typed text on timeout", async () => {
  const { url, server } = await startServer(() => {
    // Never answer.
  });
  try {
    const started = Date.now();
    const result = await rewriteGoalObjective({
      apiBaseUrl: url,
      token: "t",
      model: "m",
      objective: "ship it",
      timeoutMs: 150,
    });
    assert.equal(result.objective, "ship it");
    assert.equal(result.rewritten, false);
    assert.equal(result.fallbackReason, "timeout");
    assert.ok(Date.now() - started < 5000, "the timeout must bound the wait");
  } finally {
    await stopServer(server);
  }
});

test("rewriteGoalObjective reports aborted when the run was stopped", async () => {
  const { url, server } = await startServer(() => {
    // Never answer.
  });
  try {
    const controller = new AbortController();
    const pending = rewriteGoalObjective({
      apiBaseUrl: url,
      token: "t",
      model: "m",
      objective: "ship it",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    assert.equal(result.objective, "ship it");
    assert.equal(result.fallbackReason, "aborted");

    const already = await rewriteGoalObjective({
      apiBaseUrl: url,
      token: "t",
      model: "m",
      objective: "ship it",
      signal: controller.signal,
    });
    assert.equal(already.fallbackReason, "aborted");
  } finally {
    await stopServer(server);
  }
});

test("rewriteGoalObjective does not call the provider for a blank objective", async () => {
  const server = await startMockOpenAI(() => textResponse("anything"));
  try {
    const result = await rewriteGoalObjective({ apiBaseUrl: server.url, token: "t", model: "m", objective: "   " });
    assert.equal(result.rewritten, false);
    assert.equal(result.fallbackReason, "empty");
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});
