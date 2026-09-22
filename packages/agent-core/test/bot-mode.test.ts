import test from "node:test";
import assert from "node:assert/strict";
import {
  BOT_AGENT,
  agentForMode,
  fastFrameAcpChunk,
  fastFrameNdjsonChunk,
  fastRingBufferAppend,
  fastRingBufferClear,
  fastRingBufferGetLines,
  fastWatchdogCheck,
  fastWatchdogHeartbeat,
  fastWatchdogRegister,
  fastWatchdogUnregister,
  listExternalBotsTool,
  delegateExternalBotTool,
  inspectBotRunTool,
  mergeBotDiffTool,
  modeReminder,
} from "../src/index.js";

test("ACP stream framing decomposes incoming chunks correctly", () => {
  const chunk1 = '{"jsonrpc":"2.0","id":1,"method":"session/new"}\n{"jsonrpc":"2.0",';
  const res1 = fastFrameAcpChunk("", chunk1);
  assert.equal(res1.payloads.length, 1);
  assert.equal(res1.payloads[0], '{"jsonrpc":"2.0","id":1,"method":"session/new"}');
  assert.equal(res1.rest, '{"jsonrpc":"2.0",');

  const chunk2 = '"id":2,"result":{"ok":true}}\n';
  const res2 = fastFrameAcpChunk(res1.rest, chunk2);
  assert.equal(res2.payloads.length, 1);
  assert.equal(res2.payloads[0], '{"jsonrpc":"2.0","id":2,"result":{"ok":true}}');
  assert.equal(res2.rest, "");
});

test("NDJSON stream framing processes line-delimited JSON with carriage returns", () => {
  const raw = '{"type":"text-delta","delta":"Hello"}\r\n{"type":"text-delta","delta":" World"}\n';
  const framed = fastFrameNdjsonChunk("", raw);
  assert.equal(framed.lines.length, 2);
  assert.equal(framed.lines[0], '{"type":"text-delta","delta":"Hello"}');
  assert.equal(framed.lines[1], '{"type":"text-delta","delta":" World"}');
  assert.equal(framed.rest, "");
});

test("Terminal Ring Buffer maintains max capacity with FIFO eviction", () => {
  const bufId = "test-bot-buf";
  fastRingBufferClear(bufId);

  for (let i = 0; i < 5; i++) {
    fastRingBufferAppend(bufId, `line-${i}`, 3);
  }

  const lines = fastRingBufferGetLines(bufId);
  assert.deepEqual(lines, ["line-2", "line-3", "line-4"]);

  const recent = fastRingBufferGetLines(bufId, 2);
  assert.deepEqual(recent, ["line-3", "line-4"]);

  fastRingBufferClear(bufId);
  assert.deepEqual(fastRingBufferGetLines(bufId), []);
});

test("High-Resolution Process Watchdog tracks heartbeats, stalls, and timeouts", () => {
  const id = "watchdog-test-run";
  const now = 1_000_000;

  // 10s timeout, 2s stall threshold
  fastWatchdogRegister(id, 4321, 10_000, 2_000, now);

  // Status at 1.5s -> running
  const check1 = fastWatchdogCheck(id, now + 1500);
  assert.equal(check1.status, "running");

  // Status at 3.5s with no heartbeat -> stalled
  const check2 = fastWatchdogCheck(id, now + 3500);
  assert.equal(check2.status, "stalled");

  // Send heartbeat at 3.5s
  const heartbeated = fastWatchdogHeartbeat(id, now + 3500);
  assert.equal(heartbeated, true);

  // Status at 3.7s -> running again
  const check3 = fastWatchdogCheck(id, now + 3700);
  assert.equal(check3.status, "running");

  // Status at 12s -> timed-out
  const check4 = fastWatchdogCheck(id, now + 12_000);
  assert.equal(check4.status, "timed-out");

  assert.equal(fastWatchdogUnregister(id), true);
  assert.equal(fastWatchdogCheck(id, now + 12_000).status, "not-found");
});

test("BOT_AGENT definition and mode resolution", () => {
  const agent = agentForMode("bot");
  assert.equal(agent.name, "bot");
  assert.equal(agent, BOT_AGENT);
  assert.match(agent.prompt, /Bot Mode Orchestrator/);

  const reminder = modeReminder({ event: "enter", target: "bot" });
  assert.match(reminder, /Bot Mode/);
});

test("Bot orchestrator tools invoke context bindings cleanly", async () => {
  // 1. listExternalBotsTool
  const dummyCtx = {
    cwd: "/test/workspace",
    listExternalAgents: async () => [
      { id: "codex", name: "Codex", installed: true, availableModels: ["gpt-5.3-codex"] },
    ],
    runExternalAgent: async (opts: any) => ({
      ok: true,
      outputText: `Executed ${opts.agentId} with prompt: ${opts.prompt}`,
    }),
    mergeBotBranch: async (_cwd: string, branch: string) => ({
      ok: true,
      message: `Merged ${branch}`,
    }),
  };

  const listRes = await listExternalBotsTool.execute({}, dummyCtx as any);
  const parsed = JSON.parse(listRes);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "codex");

  // 2. delegateExternalBotTool
  const delRes = await delegateExternalBotTool.execute(
    { agentId: "codex", prompt: "Build authentication flow" },
    dummyCtx as any,
  );
  assert.match(delRes, /SUCCESS from codex/);

  // 3. inspectBotRunTool
  fastRingBufferAppend("run-xyz", "compilation success", 10);
  fastWatchdogRegister("run-xyz", 999, 5000, 1000, Date.now());
  const inspectRes = await inspectBotRunTool.execute({ runId: "run-xyz", maxLines: 5 }, dummyCtx as any);
  const inspectParsed = JSON.parse(inspectRes);
  assert.equal(inspectParsed.runId, "run-xyz");
  assert.deepEqual(inspectParsed.recentLogs, ["compilation success"]);

  // 4. mergeBotDiffTool
  const mergeRes = await mergeBotDiffTool.execute({ branchName: "bot/stage-checkout" }, dummyCtx as any);
  assert.match(mergeRes, /Merged bot\/stage-checkout successfully/);
});
