import assert from "node:assert/strict";
import test from "node:test";
import { ExternalAgentDetector } from "../src/main/external-agents/detector.js";
import { ExternalAgentService, parseCliEvent } from "../src/main/external-agents/service.js";
import { BotWorkflowScheduler } from "../src/main/external-agents/scheduler.js";
import {
  BotWorkflowEngine,
  BotWorkflowsStore,
  interpolatePrompt,
} from "@deyin/host-core";
import type { BotWorkflowDefinition, BotStageProgress } from "@deyin/contract";
import {
  BOT_AGENT,
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
} from "@deyin/agent-core";

test("Bot Mode Auto-Discovery: detects installed & uninstalled tools across platform", async () => {
  const detector = new ExternalAgentDetector();
  const agents = await detector.detectAll(true);

  assert.ok(Array.isArray(agents));
  assert.ok(agents.length >= 4);

  const claude = agents.find((a) => a.id === "claude");
  assert.ok(claude);
  assert.ok(claude.protocol === "headless-cli" || claude.protocol === "acp");
  assert.ok(claude.availableModels.length >= 2);

  const codex = agents.find((a) => a.id === "codex");
  assert.ok(codex);
  assert.ok(codex.protocol === "headless-cli" || codex.protocol === "acp");

  const opencode = agents.find((a) => a.id === "opencode");
  assert.ok(opencode);

  const zcode = agents.find((a) => a.id === "zcode");
  assert.ok(zcode);

  // Test nonexistent tool returns graceful status
  const testRes = await detector.testAgent("unknown-tool");
  assert.equal(testRes.ok, false);
  assert.match(testRes.message, /not recognized/);
});

test("Bot Mode Agent Core: BOT_AGENT definition and orchestration tools", () => {
  assert.equal(BOT_AGENT.name, "bot");
  assert.match(BOT_AGENT.prompt, /Engineering Manager/);
  assert.match(BOT_AGENT.prompt, /external tools/);
  assert.match(BOT_AGENT.prompt, /delegation/);

  // Verify Bot Mode tools
  assert.equal(listExternalBotsTool.name, "list_external_bots");
  assert.equal(delegateExternalBotTool.name, "delegate_external_bot");
  assert.equal(inspectBotRunTool.name, "inspect_bot_run");
  assert.equal(mergeBotDiffTool.name, "merge_bot_diff");
});

test("Bot Mode Conversational Pipeline: multi-stage execution with artifact bus and interpolation", async () => {
  const engine = new BotWorkflowEngine();

  const workflow: BotWorkflowDefinition = {
    id: "wf-pipeline-test",
    name: "Architect -> Backend -> Reviewer",
    description: "End-to-end 3-stage pipeline",
    stages: [
      {
        id: "stage-architect",
        name: "Architect & Schemas",
        agentId: "codex",
        userPromptTemplate: "Design schema for {{inputs.system}}",
        worktree: { isolate: false },
      },
      {
        id: "stage-backend",
        name: "Implement API",
        agentId: "claude",
        userPromptTemplate: "Implement using schema:\n{{stage.stage-architect.output}}",
        worktree: { isolate: false },
      },
      {
        id: "stage-review",
        name: "Security & Smoke Test",
        agentId: "opencode",
        userPromptTemplate: "Review code:\n{{stage.stage-backend.output}}\nArtifacts:\n{{artifacts}}",
        worktree: { isolate: false },
      },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const executedPrompts: { agentId: string; prompt: string }[] = [];
  const emittedEvents: any[] = [];

  const runner = async (opts: any) => {
    executedPrompts.push({ agentId: opts.agentId, prompt: opts.prompt });
    opts.onRawLine?.(`Output from ${opts.agentId}`);
    return {
      ok: true,
      outputText: `Finished ${opts.agentId} step with 2 artifacts.`,
      artifacts: [
        {
          name: `${opts.agentId}-result.json`,
          path: `/tmp/${opts.agentId}-result.json`,
          stageId: opts.stageId,
          content: `{"status":"ok","agent":"${opts.agentId}"}`,
        },
      ],
    };
  };

  const state = await engine.execute({
    workflow,
    workspaceRoot: process.cwd(),
    inputs: { system: "Payment Gateway" },
    runner,
    onEvent: (ev) => emittedEvents.push(ev),
  });

  assert.equal(state.status, "completed");
  assert.equal(state.stages.length, 3);
  assert.equal(state.stages[0]?.status, "completed");
  assert.equal(state.stages[1]?.status, "completed");
  assert.equal(state.stages[2]?.status, "completed");

  // Verify chained inputs
  assert.equal(executedPrompts.length, 3);
  assert.match(executedPrompts[0]!.prompt, /Payment Gateway/);
  assert.match(executedPrompts[1]!.prompt, /Finished codex step/);
  assert.match(executedPrompts[2]!.prompt, /Finished claude step/);
  assert.match(executedPrompts[2]!.prompt, /claude-result\.json/);

  // Check event sequences
  assert.ok(emittedEvents.some((e) => e.type === "workflow:started"));
  assert.ok(emittedEvents.some((e) => e.type === "stage:started" && e.stageId === "stage-architect"));
  assert.ok(emittedEvents.some((e) => e.type === "stage:completed" && e.stageId === "stage-architect"));
  assert.ok(emittedEvents.some((e) => e.type === "workflow:completed"));
});

test("Bot Mode Watchdog & Stall Recovery: stall detection, heartbeat recovery, and timeout", () => {
  const testId = `watchdog-test-${Date.now()}`;
  const now = 1_000_000;
  const timeoutMs = 60_000; // 60s
  const stallThresholdMs = 15_000; // 15s

  fastWatchdogRegister(testId, 12345, timeoutMs, stallThresholdMs, now);

  // 1. Initial state: running
  let check = fastWatchdogCheck(testId, now + 5_000);
  assert.equal(check.status, "running");
  assert.equal(check.inactiveMs, 5_000);

  // 2. Inactive beyond stall threshold -> "stalled"
  check = fastWatchdogCheck(testId, now + 16_000);
  assert.equal(check.status, "stalled");
  assert.equal(check.inactiveMs, 16_000);

  // 3. Heartbeat received -> recovers to "running"
  const heartbeatOk = fastWatchdogHeartbeat(testId, now + 17_000);
  assert.equal(heartbeatOk, true);

  check = fastWatchdogCheck(testId, now + 18_000);
  assert.equal(check.status, "running");
  assert.equal(check.inactiveMs, 1_000);

  // 4. Exceeds total timeout -> "timed-out"
  check = fastWatchdogCheck(testId, now + 65_000);
  assert.equal(check.status, "timed-out");

  // 5. Unregister
  const unregistered = fastWatchdogUnregister(testId);
  assert.equal(unregistered, true);

  check = fastWatchdogCheck(testId, now + 70_000);
  assert.equal(check.status, "not-found");
});

test("Rust Hot-Path Stream Framing: ACP & NDJSON split-chunk handling", () => {
  // Test ACP JSON-RPC message framing across fragmented stream chunks
  const msg1 = '{"jsonrpc":"2.0","method":"session/prompt","params":{"text":"hello"}}\n';
  const msg2 = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n';

  // Split into 3 fragments
  const combined = msg1 + msg2;
  const chunk1 = combined.slice(0, 25);
  const chunk2 = combined.slice(25, 75);
  const chunk3 = combined.slice(75);

  const res1 = fastFrameAcpChunk("", chunk1);
  assert.equal(res1.payloads.length, 0);
  assert.equal(res1.rest, chunk1);

  const res2 = fastFrameAcpChunk(res1.rest, chunk2);
  assert.equal(res2.payloads.length, 1);
  assert.equal(res2.payloads[0], msg1.trim());

  const res3 = fastFrameAcpChunk(res2.rest, chunk3);
  assert.equal(res3.payloads.length, 1);
  assert.equal(res3.payloads[0], msg2.trim());
  assert.equal(res3.rest, "");

  // Test NDJSON stream chunk framing
  const ndjsonLines = '{"event":"start"}\n{"event":"progress","pct":50}\n{"event":"finish"}\n';
  const ndjsonRes = fastFrameNdjsonChunk("", ndjsonLines);
  assert.equal(ndjsonRes.lines.length, 3);
  assert.equal(ndjsonRes.rest, "");
});

test("Rust Hot-Path Ring Buffer: capacity eviction and retrieval", () => {
  const bufId = `ring-test-${Date.now()}`;
  fastRingBufferClear(bufId);

  // Append 10 lines to capacity 5
  for (let i = 1; i <= 10; i++) {
    fastRingBufferAppend(bufId, `line ${i}`, 5);
  }

  const lines = fastRingBufferGetLines(bufId);
  assert.equal(lines.length, 5);
  assert.equal(lines[0], "line 6");
  assert.equal(lines[4], "line 10");

  const recent2 = fastRingBufferGetLines(bufId, 2);
  assert.equal(recent2.length, 2);
  assert.equal(recent2[0], "line 9");
  assert.equal(recent2[1], "line 10");

  fastRingBufferClear(bufId);
  const afterClear = fastRingBufferGetLines(bufId);
  assert.equal(afterClear.length, 0);
});

test("Polymorphic CLI Parsing: Claude Code, OpenAI Codex, OpenCode stream event normalization", () => {
  // 1. Claude Code text delta
  const claudeDelta = parseCliEvent({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "streaming token" },
    },
  });
  assert.equal(claudeDelta.delta, "streaming token");

  // 2. Claude Code result string
  const claudeResult = parseCliEvent({
    type: "result",
    result: "Final architectural plan",
  });
  assert.equal(claudeResult.finalText, "Final architectural plan");

  // 3. OpenAI Codex command execution
  const codexCmd = parseCliEvent({
    type: "item.started",
    item: { type: "command_execution", command: "npm test" },
  });
  assert.equal(codexCmd.toolInfo?.name, "bash");
  assert.equal(codexCmd.toolInfo?.summary, "npm test");

  // 4. OpenAI Codex agent message
  const codexMsg = parseCliEvent({
    type: "item.completed",
    item: { type: "agent_message", text: "Codex implementation output" },
  });
  assert.equal(codexMsg.finalText, "Codex implementation output");

  // 5. OpenAI Codex error
  const codexErr = parseCliEvent({
    type: "turn.failed",
    error: { message: "Sandbox write violation" },
  });
  assert.equal(codexErr.error, "Sandbox write violation");

  // 6. Generic NDJSON delta
  const generic = parseCliEvent({ delta: "standard delta" });
  assert.equal(generic.delta, "standard delta");
});

test("BotWorkflowEngine Lifecycle: single event emission on failure and proper abort event", async () => {
  const engine = new BotWorkflowEngine();
  const workflow: BotWorkflowDefinition = {
    id: "wf-lifecycle-fail",
    name: "Failing Workflow",
    stages: [
      {
        id: "stage-fail",
        name: "Stage that throws",
        agentId: "claude",
        userPromptTemplate: "Doomed prompt",
        worktree: { isolate: false },
      },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const failRunId = `custom-run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const emittedEvents: any[] = [];
  const state = await engine.execute({
    workflow,
    workspaceRoot: process.cwd(),
    runId: failRunId,
    runner: async () => {
      return { ok: false, error: "Simulated agent process crash", outputText: "" };
    },
    onEvent: (ev) => emittedEvents.push(ev),
  });

  assert.equal(state.status, "failed");
  assert.equal(state.runId, failRunId);

  // Verify only 1 workflow:completed event is emitted
  const completedEvents = emittedEvents.filter((e) => e.type === "workflow:completed");
  assert.equal(completedEvents.length, 1);
  assert.equal(completedEvents[0].error, "Simulated agent process crash");

  // Test Abort
  const abortRunId = `abort-run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const abortWf: BotWorkflowDefinition = {
    id: "wf-lifecycle-abort",
    name: "Aborting Workflow",
    stages: [
      {
        id: "stage-slow",
        name: "Slow Stage",
        agentId: "claude",
        userPromptTemplate: "Slow prompt",
        worktree: { isolate: false },
      },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const abortEvents: any[] = [];
  const execPromise = engine.execute({
    workflow: abortWf,
    workspaceRoot: process.cwd(),
    runId: abortRunId,
    runner: async (opts) => {
      // Simulate waiting until abort signal
      return new Promise((resolve) => {
        opts.signal?.addEventListener("abort", () => {
          resolve({ ok: false, error: "Aborted by user", outputText: "" });
        });
      });
    },
    onEvent: (ev) => abortEvents.push(ev),
  });

  // Give execution a moment to register
  await new Promise((r) => setTimeout(r, 10));
  const abortedOk = engine.abort(abortRunId);
  assert.equal(abortedOk, true);

  const abortState = await execPromise;
  assert.equal(abortState.status, "aborted");
  const abortedEvents = abortEvents.filter((e) => e.type === "workflow:aborted");
  assert.equal(abortedEvents.length, 1);
});

test("BotWorkflowScheduler: protects against concurrent duplicate runs", async () => {
  const store = {
    list: () => [
      {
        id: "wf-scheduled",
        name: "Hourly Scheduled Bot",
        stages: [],
        schedule: { enabled: true, intervalMinutes: 60 },
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    get: (id: string) => (id === "wf-scheduled" ? store.list()[0] : undefined),
  } as any;

  let executeCount = 0;
  let finishExecution: () => void;
  const engine = {
    execute: () => {
      executeCount++;
      return new Promise<any>((resolve) => {
        finishExecution = () => resolve({ status: "completed" });
      });
    },
  } as any;

  const scheduler = new BotWorkflowScheduler(
    store,
    engine,
    {} as any,
    () => process.cwd(),
    () => {},
  );

  // Trigger once
  (scheduler as any).trigger("wf-scheduled");
  assert.equal(executeCount, 1);
  assert.equal(scheduler.isWorkflowRunning("wf-scheduled"), true);

  // Trigger second time while still executing -> skipped
  (scheduler as any).trigger("wf-scheduled");
  assert.equal(executeCount, 1);

  // Finish execution
  finishExecution!();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(scheduler.isWorkflowRunning("wf-scheduled"), false);

  // Now trigger again -> succeeds
  (scheduler as any).trigger("wf-scheduled");
  assert.equal(executeCount, 2);

  scheduler.dispose();
});

test("Bot Mode Agent Tools: execution via ToolContext bridge", async () => {
  let delegatedOpts: any = null;
  let mergedArgs: any = null;

  const mockContext: any = {
    listExternalAgents: async () => [
      { id: "claude", name: "Claude Code", installed: true, binaryName: "claude" },
    ],
    runExternalAgent: async (opts: any) => {
      delegatedOpts = opts;
      return { ok: true, outputText: "Bot output finished." };
    },
    mergeBotBranch: async (cwd: string, branch: string) => {
      mergedArgs = { cwd, branch };
      return { ok: true, message: `Merged ${branch} cleanly.` };
    },
  };

  // 1. listExternalBotsTool
  const listRes = await listExternalBotsTool.execute({ force_refresh: true }, mockContext);
  assert.match(listRes, /Claude Code/);

  // 2. delegateExternalBotTool
  const delegateRes = await delegateExternalBotTool.execute(
    { agentId: "claude", prompt: "Create REST API" },
    mockContext,
  );
  assert.equal(delegatedOpts.agentId, "claude");
  assert.equal(delegatedOpts.prompt, "Create REST API");
  assert.match(delegateRes, /SUCCESS from claude/);

  // 3. mergeBotDiffTool
  const mergeRes = await mergeBotDiffTool.execute(
    { branchName: "bot/stage-architect" },
    mockContext,
  );
  assert.equal(mergedArgs.branch, "bot/stage-architect");
  assert.match(mergeRes, /Merged bot\/stage-architect successfully/);
});

test("Bot Mode Bugfix: Ring buffer deletion and cleanup removes entries", () => {
  const bufId = "buf-cleanup-test";
  fastRingBufferAppend(bufId, "log line 1");
  fastRingBufferAppend(bufId, "log line 2");
  assert.equal(fastRingBufferGetLines(bufId).length, 2);

  fastRingBufferClear(bufId);
  assert.equal(fastRingBufferGetLines(bufId).length, 0);
});

test("Bot Mode Bugfix: Stage recovery from stalled back to running on raw line", async () => {
  const engine = new BotWorkflowEngine();
  const workflow: BotWorkflowDefinition = {
    id: "wf-recovery",
    name: "Stall Recovery Workflow",
    stages: [
      {
        id: "stage-recover",
        name: "Recovering Stage",
        agentId: "codex",
        userPromptTemplate: "Do task",
        worktree: { isolate: false },
      },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  let onRawLineCb: any;
  let onStallCb: any;

  const execPromise = engine.execute({
    workflow,
    workspaceRoot: process.cwd(),
    runner: async (opts) => {
      onRawLineCb = opts.onRawLine;
      onStallCb = opts.onStall;
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, outputText: "Done" }), 30);
      });
    },
  });

  await new Promise((r) => setTimeout(r, 5));
  // Simulate stall:
  onStallCb?.(120_000);
  const activeRun = Array.from(engine["activeRuns"].values())[0];
  assert.equal(activeRun?.state.stages[0]?.status, "stalled");

  // Output new line:
  onRawLineCb?.("new line from bot");
  assert.equal(activeRun?.state.stages[0]?.status, "running");

  await execPromise;
});
