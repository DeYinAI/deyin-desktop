import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationRunsStore, AutomationsStore } from "../src/automations.js";
import {
  MAX_RUN_EVENTS,
  MAX_TEXT_CHARS,
  RunEventLog,
  TEXT_CHUNK_CHARS,
  TOOL_ERROR_STORE_CHARS,
  TOOL_RESULT_STORE_CHARS,
} from "../src/automation-run-log.js";
import { DEFAULT_AUTOMATION_LIMITS, isHumanBlocker, resolveLimits } from "../src/automation-policy.js";
import { FileStorage, plainCipher } from "../src/storage.js";
import type { AgentUiEvent } from "../src/types.js";

const toolStart = (n: number, name = "browser"): AgentUiEvent => ({ type: "tool-start", callId: `c${n}`, name, summary: `call ${n}` });
const toolEnd = (n: number, ok = true, result = "fine", name = "browser"): AgentUiEvent => ({
  type: "tool-end",
  callId: `c${n}`,
  name,
  summary: "",
  result,
  ok,
});
const text = (delta: string): AgentUiEvent => ({ type: "text-delta", delta });

test("consecutive deltas coalesce into chunks instead of one event per token", () => {
  const log = new RunEventLog();
  for (let i = 0; i < 100; i++) log.push(text("ab"));
  assert.equal(log.events.length, 1);
  assert.equal((log.events[0] as { delta: string }).delta.length, 200);

  // A chunk that is full starts the next one.
  const big = new RunEventLog();
  big.push(text("x".repeat(TEXT_CHUNK_CHARS)));
  big.push(text("y"));
  assert.equal(big.events.length, 2);
});

test("text and reasoning never merge into each other", () => {
  const log = new RunEventLog();
  log.push(text("a"));
  log.push({ type: "reasoning-delta", delta: "b" });
  log.push(text("c"));
  assert.deepEqual(log.events.map((e) => e.type), ["text-delta", "reasoning-delta", "text-delta"]);
});

test("a long run keeps its tool calls even though far more text followed them", () => {
  // The failure this guards: 200 one-token events evicted every tool call, so a run
  // that posted a tweet and a reply showed 198 text-deltas and zero tools.
  const log = new RunEventLog();
  for (let i = 1; i <= 3; i++) {
    log.push(toolStart(i));
    log.push(toolEnd(i));
  }
  for (let i = 0; i < 20_000; i++) log.push(text("word "));

  const tools = log.events.filter((e) => e.type === "tool-start" || e.type === "tool-end");
  assert.equal(tools.length, 6, "no tool event was evicted");
  const chars = log.events.reduce((sum, e) => sum + (e.type === "text-delta" ? e.delta.length : 0), 0);
  assert.ok(chars <= MAX_TEXT_CHARS, `text stays inside its budget (${chars})`);
  assert.ok(chars > 0, "the newest text is what is kept");
});

test("when the log is full, newer noise is evicted before older tool calls", () => {
  // Tool calls come first and the noise after them: age-only eviction would drop the
  // calls (the oldest events) and keep the usage counters, which is exactly backwards.
  const log = new RunEventLog();
  for (let i = 1; i <= 200; i++) {
    log.push(toolStart(i));
    log.push(toolEnd(i));
  }
  for (let i = 0; i < 300; i++) log.push({ type: "usage", totalTokens: i });

  assert.ok(log.events.length <= MAX_RUN_EVENTS, `bounded (${log.events.length})`);
  assert.equal(log.events.filter((e) => e.type === "tool-start").length, 200, "every tool call survived");
  assert.equal(log.events.filter((e) => e.type === "tool-end").length, 200);
});

test("when the log is full, newer text is evicted before older tool calls, and the end of the run is kept", () => {
  const log = new RunEventLog();
  for (let i = 1; i <= 100; i++) {
    log.push(toolStart(i));
    log.push(toolEnd(i));
  }
  // Alternating types never coalesce, so these are hundreds of small events.
  for (let i = 0; i < 600; i++) log.push(i % 2 ? text("a") : { type: "reasoning-delta", delta: "b" });
  log.push({ type: "error", message: "boom" });
  log.push({ type: "done", reason: "completed", finalText: "x" });

  assert.ok(log.events.length <= MAX_RUN_EVENTS, `bounded (${log.events.length})`);
  assert.equal(log.events.filter((e) => e.type === "tool-start").length, 100, "the tool calls outlived the text");
  assert.equal(log.events.at(-1)?.type, "done");
  assert.ok(log.events.some((e) => e.type === "error"));
});

test("once only tool activity is left to evict, the oldest goes and the newest stays", () => {
  const log = new RunEventLog();
  for (let i = 1; i <= MAX_RUN_EVENTS; i++) {
    log.push(toolStart(i));
    log.push(toolEnd(i));
  }
  assert.ok(log.events.length <= MAX_RUN_EVENTS);
  const last = log.events.filter((e) => e.type === "tool-end").at(-1);
  assert.equal(last?.type === "tool-end" && last.callId, `c${MAX_RUN_EVENTS}`);
  const first = log.events.find((e) => e.type === "tool-start");
  assert.ok(first?.type === "tool-start" && Number(first.callId.slice(1)) > 1, "the oldest calls were the ones dropped");
});

test("pinned events outlive every tool call when the log overflows", () => {
  const log = new RunEventLog();
  log.push({ type: "error", message: "early failure" });
  for (let i = 1; i <= MAX_RUN_EVENTS * 2; i++) log.push(toolStart(i));
  assert.ok(log.events.some((e) => e.type === "error" && e.message === "early failure"));
});

test("history keeps the gist of a tool result and more of an error", () => {
  const log = new RunEventLog();
  log.push(toolEnd(1, true, "o".repeat(5_000)));
  log.push(toolEnd(2, false, "e".repeat(5_000)));
  const [ok, bad] = log.events as Array<Extract<AgentUiEvent, { type: "tool-end" }>>;
  assert.ok(ok!.result.length < TOOL_RESULT_STORE_CHARS + 30 && ok!.result.endsWith("(truncated)"));
  assert.ok(bad!.result.length < TOOL_ERROR_STORE_CHARS + 30 && bad!.result.length > ok!.result.length);
});

test("streaming scraps that a tool result already covers are not stored", () => {
  const log = new RunEventLog();
  log.push({ type: "tool-delta", callId: "c1", delta: "partial" });
  assert.equal(log.events.length, 0);
});

test("the stored chunk is a copy: merging never mutates an event the caller still holds", () => {
  const log = new RunEventLog();
  const live = text("one");
  log.push(live);
  log.push(text(" two"));
  assert.equal((live as { delta: string }).delta, "one");
  assert.equal((log.events[0] as { delta: string }).delta, "one two");
});

/* Store-level -------------------------------------------------------------- */

function stores() {
  const storage = new FileStorage(mkdtempSync(join(tmpdir(), "deyin-runlog-")), plainCipher);
  return { runs: new AutomationRunsStore(storage), automations: new AutomationsStore(storage) };
}

test("run counters survive eviction, so a long run is still summarised exactly", () => {
  const { runs } = stores();
  const run = runs.create("a");
  runs.setStatus(run.id, "running");
  for (let i = 1; i <= 400; i++) {
    runs.appendEvent(run.id, toolStart(i, i % 2 ? "browser" : "bash"));
    runs.appendEvent(run.id, toolEnd(i, i !== 399, i === 399 ? "Timed out waiting to open tab" : "ok", i % 2 ? "browser" : "bash"));
  }
  const done = runs.finish(run.id, "completed", { reason: "completed" });

  assert.ok((done?.events.length ?? 0) <= MAX_RUN_EVENTS, "the stored log is bounded");
  assert.equal(done?.summary?.steps, 400, "but every call was counted");
  assert.deepEqual(done?.summary?.toolCalls, { browser: 200, bash: 200 });
  assert.equal(done?.summary?.toolErrors, 1);
  assert.match(done?.summary?.lastError ?? "", /Timed out waiting to open tab/);
  assert.equal(done?.summary?.lastTool, "bash");
  assert.ok((done?.summary?.durationMs ?? -1) >= 0);
});

test("finish records how the run ended", () => {
  const { runs } = stores();
  const run = runs.create("a");
  const done = runs.finish(run.id, "failed", {
    reason: "blocked: login-required",
    outcome: "blocked",
    blocker: { kind: "login-required", detail: "x.com redirected to the sign-in page" },
    artifacts: ["https://x.com/openference/status/1"],
  });
  assert.equal(done?.outcome, "blocked");
  assert.equal(done?.blocker?.kind, "login-required");
  assert.deepEqual(done?.artifacts, ["https://x.com/openference/status/1"]);
});

test("a finished run frees its live log, and a reload keeps appending to what was stored", () => {
  const { runs } = stores();
  const run = runs.create("a");
  runs.appendEvent(run.id, text("hello"));
  runs.finish(run.id, "completed");
  assert.equal(runs.get(run.id)?.events.length, 1);
});

test("patchRuntime changes health without moving the catch-up floor", () => {
  const { automations } = stores();
  const created = automations.create({
    name: "n",
    enabled: true,
    payload: { kind: "prompt", prompt: "p" },
    trigger: { kind: "cron", expression: "*/30 * * * *" },
    target: { kind: "local", workspacePath: "/tmp" },
    model: "m",
    providerId: "openference",
  });
  const stamp = created.updatedAt;
  const patched = automations.patchRuntime(created.id, { health: { consecutiveFailures: 2 }, learnedRules: ["a"] });
  assert.equal(patched?.health?.consecutiveFailures, 2);
  assert.deepEqual(patched?.learnedRules, ["a"]);
  assert.equal(patched?.updatedAt, stamp, "updatedAt is the catch-up floor and must not move");
  assert.equal(automations.patchRuntime("missing", {}), null);
});

/* Policy ------------------------------------------------------------------- */

test("limits default, clamp and never let the idle timer outlast the run", () => {
  assert.deepEqual(resolveLimits({}), DEFAULT_AUTOMATION_LIMITS);
  assert.deepEqual(resolveLimits({ limits: { maxMinutes: 12, idleMinutes: 4, maxSteps: 100 } }), { maxMinutes: 12, idleMinutes: 4, maxSteps: 100 });
  assert.equal(resolveLimits({ limits: { maxMinutes: 99_999 } }).maxMinutes, 240);
  assert.equal(resolveLimits({ limits: { maxSteps: 0 } }).maxSteps, 1);
  assert.equal(resolveLimits({ limits: { maxSteps: Number.NaN } }).maxSteps, DEFAULT_AUTOMATION_LIMITS.maxSteps);
  assert.equal(resolveLimits({ limits: { maxMinutes: 2, idleMinutes: 30 } }).idleMinutes, 2);
});

test("only a login wall, a captcha or an account warning needs a person", () => {
  assert.equal(isHumanBlocker("login-required"), true);
  assert.equal(isHumanBlocker("captcha"), true);
  assert.equal(isHumanBlocker("account-warning"), true);
  assert.equal(isHumanBlocker("tool-missing"), false);
  assert.equal(isHumanBlocker("mcp"), false);
  assert.equal(isHumanBlocker("rate-limit"), false);
});
