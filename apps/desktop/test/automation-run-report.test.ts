import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationRun } from "@deyin/host-core";
import { createAutomationTools } from "../src/main/automation-tools.js";
import { describeRunDetail, describeRunLine } from "../src/main/automations/run-report.js";
import type { AutomationService } from "../src/main/automations/service.js";

function run(patch: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run-aaaa1111",
    automationId: "auto-1",
    status: "completed",
    startedAt: Date.UTC(2026, 8, 2, 14, 0, 0),
    finishedAt: Date.UTC(2026, 8, 2, 14, 3, 20),
    events: [],
    ...patch,
  };
}

const withCalls = (n: number): AutomationRun =>
  run({
    events: Array.from({ length: n }, (_, i) => [
      { type: "tool-start" as const, callId: `c${i}`, name: "chrome_click", summary: `click e${i}` },
      { type: "tool-end" as const, callId: `c${i}`, name: "chrome_click", summary: "", result: i === n - 1 ? "page closed" : "ok", ok: i !== n - 1 },
    ]).flat(),
  });

test("a run line names the outcome, so a failed run is visible at a glance", () => {
  const line = describeRunLine(run({ status: "failed", outcome: "blocked", reason: "login-required" }));
  assert.match(line, /failed\/blocked/);
  assert.match(line, /reason: login-required/);
});

test("run detail leads with the facts the creating agent lacked: outcome, blocker, produced, tool counts, last error", () => {
  const text = describeRunDetail(
    run({
      outcome: "success",
      artifacts: ["posts/log.md"],
      summary: { steps: 4, toolCalls: { chrome_click: 3, bash: 1 }, toolErrors: 1, durationMs: 200_000, lastError: "page closed" },
      finalText: "Posted: https://x.com/openference/status/1",
    }),
  );
  assert.match(text, /completed\/success/);
  assert.match(text, /\(3m 20s\)/);
  assert.match(text, /Produced: posts\/log\.md/);
  assert.match(text, /Tool calls: 4 \(1 failed\): chrome_click×3, bash×1/);
  assert.match(text, /Last error: page closed/);
  assert.match(text, /Final output:\nPosted: https:\/\/x\.com\/openference\/status\/1/);
});

test("a blocked run says what blocked it", () => {
  const text = describeRunDetail(run({ status: "failed", outcome: "blocked", blocker: { kind: "login-required", detail: "x.com shows the login page" } }));
  assert.match(text, /Blocker: login-required — x\.com shows the login page/);
});

test("a long timeline keeps its start and its end, where the failure is", () => {
  const text = describeRunDetail(withCalls(200));
  const rows = text.split("\n").filter((l) => /^ {2}\d+\. /.test(l));
  assert.ok(rows.length <= 71, `${rows.length} rows`);
  assert.match(text, /… 130 more calls …/);
  assert.match(text, / {2}1\. chrome_click \[ok\] click e0/);
  assert.match(text, / {2}200\. chrome_click \[ERROR\] click e199 — page closed/, "the final failing call is shown");
});

test("a run recorded before summaries existed is labelled, not shown as having made no calls", () => {
  assert.match(describeRunDetail(run()), /not counted/);
});

test("a long final output is cut, and a live run is not reported as having no output", () => {
  assert.match(describeRunDetail(run({ finalText: "x".repeat(9_000) })), /\(truncated\)/);
  assert.doesNotMatch(describeRunDetail(run({ status: "running", finishedAt: undefined })), /Final output: none/);
});

/* The tools ---------------------------------------------------------------------------------- */

function fakeService(runs: AutomationRun[]): { service: AutomationService; stopped: string[] } {
  const stopped: string[] = [];
  const service = {
    listRuns: (id?: string) => (id ? runs.filter((r) => r.automationId === id) : runs),
    stopRun: (runId: string) => void stopped.push(runId),
    list: () => [],
  } as unknown as AutomationService;
  return { service, stopped };
}

function tool(service: AutomationService, name: string) {
  const found = createAutomationTools(service, {} as never).find((t) => t.name === name);
  assert.ok(found, `${name} exists`);
  return found;
}

const ctx = {} as never;

test("automation_stop stops the live run of an automation, or a run named by a unique prefix", async () => {
  const live = run({ id: "run-live0001", status: "running", finishedAt: undefined });
  const done = run({ id: "run-done0002" });
  const { service, stopped } = fakeService([done, live]);
  const stop = tool(service, "automation_stop");

  assert.match(await stop.execute({ id: "auto-1" }, ctx), /Stop requested for run run-live0001/);
  assert.match(await stop.execute({ runId: "run-live" }, ctx), /Stop requested/);
  assert.deepEqual(stopped, ["run-live0001", "run-live0001"]);

  assert.match(await stop.execute({ runId: "run-done0002" }, ctx), /already completed; nothing to stop/);
  assert.match(await stop.execute({ runId: "run-" }, ctx), /matches 2 runs/);
  assert.match(await stop.execute({ id: "nobody" }, ctx), /no run in progress/);
  assert.match(await stop.execute({}, ctx), /Pass runId/);
  assert.equal(stopped.length, 2, "nothing else was stopped");
});

test("automation_runs with detail returns the full record of the newest run; without it, one line per run", async () => {
  const { service } = fakeService([withCalls(3), run({ id: "run-bbbb2222" })]);
  const runs = tool(service, "automation_runs");
  const detailed = await runs.execute({ detail: true }, ctx);
  assert.match(detailed, /Timeline:/);
  assert.doesNotMatch(detailed, /run-bbbb2222/, "detail defaults to a single run");
  const plain = await runs.execute({}, ctx);
  assert.doesNotMatch(plain, /Timeline:/);
  assert.equal(plain.split("\n").length, 2);
  assert.match(await runs.execute({ runId: "run-bbbb", detail: true }, ctx), /Run run-bbbb2222/);
});

test("limits can be set on create and update, are echoed back, and only the fields given change", async () => {
  const created: unknown[] = [];
  const patches: unknown[] = [];
  const existing = { id: "a1", name: "X", target: { kind: "local", workspacePath: "/w" }, providerId: "openference", model: "m", trigger: { kind: "manual" }, enabled: true, limits: { maxMinutes: 30 } };
  const service = {
    create: (input: unknown) => {
      created.push(input);
      return { automation: { ...(input as object), id: "a2", trigger: { kind: "manual" } } };
    },
    update: (_id: string, patch: unknown) => void patches.push(patch),
    list: () => [existing],
  } as unknown as AutomationService;
  const settings = { get: () => ({ defaultModel: "openference::m" }) } as never;
  const find = (name: string) => createAutomationTools(service, settings).find((t) => t.name === name)!;

  await find("automation_create").execute({ name: "N", prompt: "p", workspacePath: "/w", maxMinutes: 12, maxSteps: 80 }, ctx);
  assert.deepEqual((created[0] as { limits: unknown }).limits, { maxMinutes: 12, maxSteps: 80 });
  await find("automation_create").execute({ name: "N", prompt: "p", workspacePath: "/w" }, ctx);
  assert.equal("limits" in (created[1] as object), false, "no limits given, none stored: the defaults apply");

  const reply = await find("automation_update").execute({ id: "a1", idleMinutes: 3 }, ctx);
  assert.deepEqual((patches[0] as { limits: unknown }).limits, { maxMinutes: 30, idleMinutes: 3 }, "merged over what was there");
  assert.match(reply, /limits 30m run \/ 5m quiet \/ 120 steps/, "the listing shows effective limits");
});
