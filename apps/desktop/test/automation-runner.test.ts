import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AutomationRunsStore,
  AutomationsStore,
  FileStorage,
  SURFACE_LIMITS,
  plainCipher,
  type Automation,
  type AutomationRun,
} from "@deyin/host-core";
import type { AgentUiEvent } from "@deyin/contract";
import type { AgentRunContextDeps } from "../src/main/automations/agent-run-context.js";
import type { ChromeAutomationPort } from "../src/main/automations/consent.js";
import { AutomationRunner, RoutineBusyError, SKIPPED_OVERLAP, type RunExecutor } from "../src/main/automations/runner.js";
import type { AuthManager } from "../src/main/auth.js";
import { FakeClock, flush } from "./helpers/fake-clock.js";

const MINUTE = 60_000;

interface Harness {
  runner: AutomationRunner;
  automations: AutomationsStore;
  runs: AutomationRunsStore;
  clock: FakeClock;
  finished: AutomationRun[];
  notified: AutomationRun[];
  automation: Automation;
  /** Starts the automation and lets it get as far as the executor. */
  start(): Promise<AutomationRun>;
  settled(): Promise<AutomationRun>;
}

interface HarnessOptions {
  token?: () => Promise<string | null>;
  workspaceExists?: (path: string) => boolean;
  chrome?: ChromeAutomationPort;
  admit?: (automation: Automation, now: number) => string | null;
}

function harness(execute: RunExecutor, patch: Partial<Automation> = {}, extra: HarnessOptions = {}): Harness {
  const storage = new FileStorage(mkdtempSync(join(tmpdir(), "deyin-runner-")), plainCipher);
  const automations = new AutomationsStore(storage);
  const runs = new AutomationRunsStore(storage);
  const clock = new FakeClock();
  const finished: AutomationRun[] = [];
  const notified: AutomationRun[] = [];
  const waiters: Array<(run: AutomationRun) => void> = [];
  const deps = {
    capabilities: { enabledForRun: async () => ({ skills: [], subagents: [] }) },
    agents: { listProviders: () => [], getKey: () => null },
    chrome: extra.chrome,
  } as unknown as AgentRunContextDeps;
  const auth = { getAccessToken: extra.token ?? (async () => "token") } as unknown as AuthManager;
  const runner = new AutomationRunner(
    automations,
    runs,
    deps,
    auth,
    {
      onRunEvent: () => undefined,
      onRunFinished: (run) => {
        finished.push(run);
        for (const w of waiters.splice(0)) w(run);
      },
      execute,
      notify: (_a, run) => void notified.push(run),
    },
    { clock, tickMs: 1_000, graceMs: 15_000, workspaceExists: extra.workspaceExists ?? (() => true), ...(extra.admit ? { admit: extra.admit } : {}) },
  );
  const automation = automations.create({
    name: "X",
    description: "",
    enabled: true,
    payload: { kind: "prompt", prompt: "post" },
    trigger: { kind: "manual" },
    target: { kind: "local", workspacePath: "/tmp/x" },
    model: "m",
    providerId: "openference",
    ...patch,
  } as Omit<Automation, "id" | "createdAt" | "updatedAt">);
  return {
    runner,
    automations,
    runs,
    clock,
    finished,
    notified,
    automation,
    start: async () => {
      const run = runner.runNow(automation.id);
      await flush();
      return run;
    },
    settled: () => new Promise((resolve) => waiters.push(resolve)),
  };
}

/** An executor that works until told to stop, then winds down the way the real one does. */
const untilAborted: RunExecutor = (_automation, _resolved, _token, ctx) =>
  new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({ reason: "aborted", finalText: "" }), { once: true }));

const report = (patch = {}) => ({ outcome: "success" as const, summary: "Posted.", ...patch });
const text = (delta: string): AgentUiEvent => ({ type: "text-delta", delta });

test("a run that reports success is recorded with its outcome, summary and artifacts, and the user is told", async () => {
  const h = harness(async () => ({ reason: "completed", finalText: "Done.", report: report({ artifacts: ["https://x.com/o/status/1"] }) }));
  await h.start();
  const run = h.finished[0]!;
  assert.equal(run.status, "completed");
  assert.equal(run.outcome, "success");
  assert.deepEqual(run.artifacts, ["https://x.com/o/status/1"]);
  assert.equal(h.notified.length, 1);
  assert.ok(run.summary?.durationMs !== undefined, "duration is stored with the run");
});

test("a blocked run is a failed run with the blocker recorded", async () => {
  const h = harness(async () => ({
    reason: "completed",
    finalText: "",
    report: report({ outcome: "blocked", summary: "login wall", blocker: { kind: "login-required", detail: "x.com login page" } }),
  }));
  await h.start();
  const run = h.finished[0]!;
  assert.deepEqual([run.status, run.outcome, run.blocker?.kind], ["failed", "blocked", "login-required"]);
});

test("a local run that never reports is recorded as unreported, not as success", async () => {
  const h = harness(async () => ({ reason: "completed", finalText: "I did the thing." }));
  await h.start();
  assert.equal(h.finished[0]?.outcome, "unreported");
  assert.equal(h.finished[0]?.status, "completed");
});

test("an executor that throws fails the run with its message and an error event in the history", async () => {
  const h = harness(async () => {
    throw new Error("SSH host not found.");
  });
  await h.start();
  const run = h.runs.get(h.finished[0]!.id)!;
  assert.deepEqual([run.status, run.outcome, run.reason], ["failed", "failed", "SSH host not found."]);
  assert.ok(run.events.some((e) => e.type === "error" && e.message === "SSH host not found."));
});

test("a run past its time limit is aborted and recorded as a timeout", async () => {
  const h = harness(untilAborted, { limits: { maxMinutes: 2, idleMinutes: 2 } });
  const run = await h.start();
  await h.clock.advance(2 * MINUTE);
  const done = h.runs.get(run.id)!;
  assert.deepEqual([done.status, done.outcome, done.reason], ["failed", "failed", "timeout"]);
  assert.ok(done.events.some((e) => e.type === "error" && /2-minute limit/.test(e.message)));
});

test("a run that goes quiet is stopped as stalled; one that keeps working is not", async () => {
  const quiet = harness(
    (a, r, t, ctx) => {
      ctx.emit(text("starting"));
      return untilAborted(a, r, t, ctx);
    },
    { limits: { maxMinutes: 30, idleMinutes: 3 } },
  );
  const run = await quiet.start();
  await quiet.clock.advance(3 * MINUTE);
  assert.equal(quiet.runs.get(run.id)?.reason, "stalled");
  assert.ok(quiet.runs.get(run.id)?.events.some((e) => e.type === "error" && /no progress for 3 minutes/.test(e.message)));

  let finish!: (r: { reason: "completed"; finalText: string; report: ReturnType<typeof report> }) => void;
  const busy = harness(
    (_a, _r, _t, ctx) =>
      new Promise((resolve) => {
        finish = resolve;
        const beat = (): void => {
          ctx.touch();
          ctx.emit(text("."));
          if (!ctx.signal.aborted) busy.clock.setTimeout(beat, MINUTE);
        };
        beat();
      }),
    { limits: { maxMinutes: 30, idleMinutes: 3 } },
  );
  const busyRun = await busy.start();
  await busy.clock.advance(10 * MINUTE);
  assert.equal(busy.runs.get(busyRun.id)?.status, "running", "ten busy minutes with a three-minute quiet allowance");
  finish({ reason: "completed", finalText: "", report: report() });
  await flush();
  assert.equal(busy.runs.get(busyRun.id)?.outcome, "success");
});

test("a run stuck in a tool that ignores the abort is abandoned: it is recorded, its slot is freed, and its late output is not", async () => {
  let late!: (event: AgentUiEvent) => void;
  const h = harness(
    async (_a, _r, _t, ctx) => {
      late = ctx.emit;
      return new Promise(() => undefined);
    },
    { limits: { maxMinutes: 1, idleMinutes: 1 } },
  );
  const run = await h.start();
  await h.clock.advance(MINUTE); // limit trips
  assert.equal(h.runs.get(run.id)?.status, "running", "still inside the grace period");
  await h.clock.advance(15_000);

  const done = h.runs.get(run.id)!;
  assert.deepEqual([done.status, done.reason], ["failed", "timeout"]);
  assert.ok(done.events.some((e) => e.type === "error" && /left behind/.test(e.message)));
  assert.equal(h.finished.length, 1, "finished exactly once");

  const eventsBefore = done.events.length;
  late(text("zombie output"));
  assert.equal(h.runs.get(run.id)?.events.length, eventsBefore, "a finished run's history is closed");

  // The slot is free: the automation can run again.
  const again = h.runner.runNow(h.automation.id);
  await flush();
  assert.notEqual(again.id, run.id);
  assert.equal(h.runs.get(again.id)?.status, "running");
});

test("a user stop ends the run as stopped, with no outcome; quitting the app says so", async () => {
  const h = harness(untilAborted);
  const run = await h.start();
  h.runner.stop(run.id);
  await flush();
  const stopped = h.runs.get(run.id)!;
  assert.deepEqual([stopped.status, stopped.reason, stopped.outcome], ["aborted", "stopped", undefined]);
  assert.equal(h.notified.length, 0, "the user who pressed Stop does not need a notification");

  const q = harness(untilAborted);
  const quitRun = await q.start();
  q.runner.dispose();
  await flush();
  assert.equal(q.runs.get(quitRun.id)?.reason, "app-quit");
});

test("a tick that finds the previous run still going leaves one history row, however many ticks arrive", async () => {
  const h = harness(untilAborted);
  const live = await h.start();
  h.runner.runScheduled(h.automation.id, 1);
  h.runner.runScheduled(h.automation.id, 2);
  h.runner.runScheduled(h.automation.id, 3);
  const rows = h.runs.list(h.automation.id);
  const skipped = rows.filter((r) => r.reason === SKIPPED_OVERLAP);
  assert.equal(skipped.length, 1);
  assert.deepEqual([skipped[0]?.status, skipped[0]?.outcome], ["aborted", undefined]);
  assert.equal(h.runs.get(live.id)?.status, "running", "the live run is untouched");

  // Once that run is over and another goes live, a new overlap is worth noting again.
  h.runner.stop(live.id);
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 5)); // run rows are stamped with real time
  await h.start();
  h.runner.runScheduled(h.automation.id, 4);
  assert.equal(h.runs.list(h.automation.id).filter((r) => r.reason === SKIPPED_OVERLAP).length, 2);
});

test("abandoned runs give their share of the global concurrency back, so later runs are not left queued behind them", async () => {
  const h = harness(async () => new Promise(() => undefined), { limits: { maxMinutes: 1, idleMinutes: 1 } });
  const make = (name: string): Automation =>
    h.automations.create({
      name,
      description: "",
      enabled: true,
      payload: { kind: "prompt", prompt: "go" },
      trigger: { kind: "manual" },
      target: { kind: "local", workspacePath: "/tmp/x" },
      model: "m",
      providerId: "openference",
      limits: { maxMinutes: 1, idleMinutes: 1 },
    } as Omit<Automation, "id" | "createdAt" | "updatedAt">);
  const second = make("second");
  const third = make("third");

  h.runner.runNow(h.automation.id);
  h.runner.runNow(second.id);
  await flush();
  const queued = h.runner.runNow(third.id);
  assert.equal(h.runs.get(queued.id)?.status, "queued", "two runs are live, so the third waits");

  await h.clock.advance(MINUTE + 15_000);
  assert.equal(h.runs.get(queued.id)?.status === "queued", false, "both hung runs were abandoned, so the queued one has started");
});

/* Preflight and retry ------------------------------------------------------------------------ */

test("a signed-out automation is blocked before any model is called, and says so", async () => {
  let executed = false;
  const h = harness(
    async () => {
      executed = true;
      return { reason: "completed", finalText: "" };
    },
    {},
    { token: async () => null },
  );
  await h.start();
  await h.clock.advance(2_000); // the one retry of the token waits a moment
  const run = h.finished[0]!;
  assert.equal(executed, false);
  assert.deepEqual([run.status, run.outcome, run.blocker?.kind, run.reason], ["failed", "blocked", "auth", "auth"]);
});

test("a workspace that is gone blocks the run with the path in the reason", async () => {
  let executed = false;
  const h = harness(async () => ((executed = true), { reason: "completed", finalText: "" }), {}, { workspaceExists: () => false });
  await h.start();
  const run = h.finished[0]!;
  assert.equal(executed, false);
  assert.equal(run.outcome, "blocked");
  assert.match(run.blocker?.detail ?? "", /workspace folder does not exist: \/tmp\/x/);
});

test("a hiccup before any work is retried in the same slot, and the run is one row that succeeds", async () => {
  let attempts = 0;
  const h = harness(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("fetch failed");
    return { reason: "completed", finalText: "ok", report: report() };
  });
  const run = await h.start();
  assert.equal(attempts, 1);
  await h.clock.advance(5_000);
  assert.equal(attempts, 2);
  await h.clock.advance(20_000);
  assert.equal(attempts, 3);
  const done = h.runs.get(run.id)!;
  assert.deepEqual([done.status, done.outcome], ["completed", "success"]);
  assert.equal(h.runs.list(h.automation.id).length, 1, "retries are not new runs");
  assert.equal(done.events.filter((e) => e.type === "error" && /Trying again/.test(e.message)).length, 2, "each retry is visible in the history");
});

test("retries stop after two, and the failure then stands", async () => {
  let attempts = 0;
  const h = harness(async () => {
    attempts += 1;
    throw new Error("503 Service Unavailable");
  });
  const run = await h.start();
  await h.clock.advance(5_000);
  await h.clock.advance(20_000);
  assert.equal(attempts, 3);
  const done = h.runs.get(run.id)!;
  assert.equal(done.status, "failed");
  assert.equal(done.reason, "503 Service Unavailable");
});

test("nothing is retried once a tool has run: a second attempt could post twice", async () => {
  let attempts = 0;
  const h = harness(async (_a, _r, _t, ctx) => {
    attempts += 1;
    ctx.emit({ type: "tool-start", callId: "1", name: "chrome_click", summary: "Post" });
    throw new Error("fetch failed");
  });
  await h.start();
  await h.clock.advance(60_000);
  assert.equal(attempts, 1);
  assert.equal(h.finished[0]?.status, "failed");
});

test("an error that is not a hiccup is not retried, and a sign-in error is recorded as a blocker", async () => {
  let attempts = 0;
  const h = harness(async () => {
    attempts += 1;
    throw new Error("401 Unauthorized");
  });
  await h.start();
  assert.equal(attempts, 1);
  const run = h.finished[0]!;
  assert.deepEqual([run.outcome, run.blocker?.kind], ["blocked", "auth"]);

  const other = harness(async () => {
    throw new Error("Cannot read properties of undefined");
  });
  await other.start();
  assert.deepEqual([other.finished[0]?.outcome, other.finished[0]?.blocker], ["failed", undefined]);
});

test("a stop during the wait before a retry ends the run instead of trying again", async () => {
  let attempts = 0;
  const h = harness(async () => {
    attempts += 1;
    throw new Error("fetch failed");
  });
  const run = await h.start();
  h.runner.stop(run.id);
  await h.clock.advance(60_000);
  assert.equal(attempts, 1);
  assert.equal(h.runs.get(run.id)?.status, "aborted");
});

/* Browser consent ---------------------------------------------------------------------------- */

const X = "https://x.com";
const chromeAt = (patch: Partial<ReturnType<ChromeAutomationPort["status"]>> = {}, approved: string[] = [X]): ChromeAutomationPort => ({
  tools: () => [],
  status: () => ({ enabled: true, connection: "connected", stopped: false, ...patch }),
  getApprovedOrigins: () => approved,
});
const browserAutomation = (name: string, sites = [X]) =>
  ({
    name,
    description: "",
    enabled: true,
    payload: { kind: "prompt", prompt: "go" },
    trigger: { kind: "manual" },
    target: { kind: "local", workspacePath: "/tmp/x" },
    model: "m",
    providerId: "openference",
    consent: { browserOrigins: sites },
  }) as Omit<Automation, "id" | "createdAt" | "updatedAt">;

test("two automations that drive Chrome never run together: the second waits, then runs when the first is done", async () => {
  const release: Array<() => void> = [];
  const started: string[] = [];
  const h = harness(
    (automation) =>
      new Promise((resolve) => {
        started.push(automation.name);
        release.push(() => resolve({ reason: "completed", finalText: "", report: report() }));
      }),
    { name: "first", ...browserAutomation("first") },
    { chrome: chromeAt() },
  );
  const second = h.automations.create(browserAutomation("second"));
  const plain = h.automations.create({ ...browserAutomation("plain"), consent: undefined });

  h.runner.runNow(h.automation.id);
  await flush();
  const waiting = h.runner.runNow(second.id);
  await flush();
  assert.equal(h.runs.get(waiting.id)?.status, "queued", "Chrome is in use");
  assert.deepEqual(started, ["first"]);

  // A run that does not touch Chrome is not held up by the one that does.
  h.runner.runNow(plain.id);
  await flush();
  assert.deepEqual(started, ["first", "plain"], "a plain run starts beside the browser run, jumping the waiting one");

  // The plain run ending frees a slot, but not the browser: the waiting run must not slip in.
  release[1]!();
  await flush();
  assert.deepEqual(started, ["first", "plain"], "a slot opened, the browser did not");
  assert.equal(h.runs.get(waiting.id)?.status, "queued");

  release[0]!();
  await flush();
  assert.deepEqual(started, ["first", "plain", "second"], "the browser is free, so the waiting run starts");
  assert.equal(h.runs.get(waiting.id)?.status, "running");
  release[2]!();
  await flush();
});

test("an automation waiting for Chrome is not lost when its turn comes after it was disabled", async () => {
  const release: Array<() => void> = [];
  const h = harness(
    () => new Promise((resolve) => release.push(() => resolve({ reason: "completed", finalText: "", report: report() }))),
    browserAutomation("first"),
    { chrome: chromeAt() },
  );
  const second = h.automations.create(browserAutomation("second"));
  h.runner.runNow(h.automation.id);
  await flush();
  const waiting = h.runner.runNow(second.id);
  h.automations.setEnabled(second.id, false);
  release[0]!();
  await flush();
  assert.equal(h.runs.get(waiting.id)?.status, "aborted");
  assert.equal(h.runs.get(waiting.id)?.reason, "skipped");
});

test("Chrome that is not connected blocks the run before any model is called, naming what to fix", async () => {
  let executed = false;
  const h = harness(
    async () => {
      executed = true;
      return { reason: "completed", finalText: "" };
    },
    browserAutomation("x"),
    { chrome: chromeAt({ connection: "disconnected" }) },
  );
  await h.start();
  const run = h.finished[0]!;
  assert.equal(executed, false);
  assert.deepEqual([run.outcome, run.blocker?.kind], ["blocked", "tool-missing"]);
  assert.match(run.blocker?.detail ?? "", /not connected to Chrome/);
});

test("a site Chrome has not been approved for blocks the run as something only the user can clear", async () => {
  const h = harness(async () => ({ reason: "completed", finalText: "" }), browserAutomation("x", [X, "https://openference.com"]), {
    chrome: chromeAt({}, [X]),
  });
  await h.start();
  const run = h.finished[0]!;
  assert.deepEqual([run.outcome, run.blocker?.kind], ["blocked", "approval-required"]);
  assert.match(run.blocker?.detail ?? "", /https:\/\/openference\.com is not approved/);
});

test("a ready Chrome lets the run through to the executor", async () => {
  const h = harness(async () => ({ reason: "completed", finalText: "", report: report() }), browserAutomation("x"), { chrome: chromeAt() });
  await h.start();
  assert.equal(h.finished[0]?.outcome, "success");
});

test("a run the gate refuses never reaches the executor, and ends as skipped rather than failed", async () => {
  let executed = 0;
  const h = harness(
    async () => {
      executed += 1;
      return { reason: "completed", finalText: "" };
    },
    {},
    { admit: () => "rate-limited: slow down" },
  );
  const run = await h.start();
  await flush();
  const row = h.runs.get(run.id)!;
  assert.equal(executed, 0);
  assert.deepEqual([row.status, row.reason, row.outcome], ["aborted", "rate-limited: slow down", undefined]);
  assert.equal(h.notified.length, 0, "a skipped run is not a failure to tell the user about");
  assert.equal(h.finished.length, 1);
  assert.ok(row.events.some((e) => e.type === "error" && e.message === "rate-limited: slow down"), "the history says why");
});

test("a refused scheduled slot is still claimed, so catch-up does not replay it", async () => {
  const h = harness(untilAborted, { trigger: { kind: "cron", expression: "0 9 * * *" } }, { admit: () => "skipped: archived" });
  h.runner.runScheduled(h.automation.id, 123_456);
  await flush();
  assert.equal(h.automations.get(h.automation.id)?.lastScheduledAt, 123_456);
});

test("a refused run frees its slot: the next admitted run goes ahead", async () => {
  let refuse = true;
  let executed = 0;
  const h = harness(
    async () => {
      executed += 1;
      return { reason: "completed", finalText: "ok", report: { outcome: "success", summary: "ok" } };
    },
    {},
    { admit: () => (refuse ? "rate-limited: wait" : null) },
  );
  await h.start();
  await flush();
  assert.equal(executed, 0);
  refuse = false;
  await h.start();
  await flush();
  assert.equal(executed, 1);
});

test("the gate is asked once per run, with the automation and the time the run began", async () => {
  const asked: Array<[string, number]> = [];
  const h = harness(untilAborted, {}, { admit: (a, now) => (asked.push([a.id, now]), null) });
  h.clock.t = 7_777;
  await h.start();
  assert.deepEqual(asked, [[h.automation.id, 7_777]]);
});

/* Messages for a routine -------------------------------------------------------------------- */

/** An executor that records the prompt it was given and holds the run until released. */
function gate() {
  const prompts: string[] = [];
  const releases: Array<() => void> = [];
  const execute: RunExecutor = (_automation, resolved) => {
    prompts.push(resolved.prompt);
    return new Promise((resolve) => {
      releases.push(() => resolve({ reason: "completed", finalText: `spoken ${prompts.length}`, report: report({ summary: `reply ${prompts.length}` }) }));
    });
  };
  return { prompts, execute, release: async () => { releases.shift()?.(); await flush(); } };
}

test("a message is put after the routine's own instructions, and the routine's prompt is not changed", async () => {
  const g = gate();
  const h = harness(g.execute);
  h.runner.runNow(h.automation.id, { text: "<inbound_message>hi</inbound_message>" });
  await flush();
  assert.deepEqual(g.prompts, ["post\n\n<inbound_message>hi</inbound_message>"]);
  assert.equal(h.automations.get(h.automation.id)?.payload.kind === "prompt" && h.automations.get(h.automation.id)?.payload.prompt, "post");
  await g.release();
});

test("a message is never answered with another run's result: each is its own run, even while one is going", async () => {
  const g = gate();
  const h = harness(g.execute);
  const first = h.runner.runNow(h.automation.id, { text: "one" });
  await flush();
  const second = h.runner.runNow(h.automation.id, { text: "two" });
  assert.notEqual(first.id, second.id);
  assert.equal(h.runs.get(second.id)?.status, "queued", "it waits for the routine rather than starting beside the first");
  assert.deepEqual(g.prompts, ["post\n\none"]);
  await g.release();
  assert.deepEqual(g.prompts, ["post\n\none", "post\n\ntwo"], "and goes when the routine is free");
  await g.release();
  assert.deepEqual(h.runs.list(h.automation.id).map((r) => r.status).sort(), ["completed", "completed"]);
});

test("messages are taken in the order they arrived", async () => {
  const g = gate();
  const h = harness(g.execute);
  for (const word of ["a", "b", "c", "d"]) h.runner.runNow(h.automation.id, { text: word });
  await flush();
  for (let n = 0; n < 4; n += 1) await g.release();
  assert.deepEqual(g.prompts.map((p) => p.split("\n\n")[1]), ["a", "b", "c", "d"]);
});

test("what is sent back is the Bot's report, not the report with whatever it said after", async () => {
  const g = gate();
  const h = harness(g.execute);
  h.runner.runNow(h.automation.id, { text: "q" });
  await flush();
  await g.release();
  assert.equal(h.finished[0]?.finalText, "reply 1");
  // An ordinary run keeps its report and what came after it, as before.
  const plain = harness(async () => ({ reason: "completed", finalText: "spoken", report: report({ summary: "reported" }) }));
  await plain.start();
  assert.equal(plain.finished[0]?.finalText, "reported\n\nspoken");
});

test("only so many messages wait behind a routine, and the next is refused rather than lost quietly", async () => {
  const g = gate();
  const h = harness(g.execute);
  h.runner.runNow(h.automation.id, { text: "running" });
  await flush();
  for (let n = 0; n < SURFACE_LIMITS.queued; n += 1) h.runner.runNow(h.automation.id, { text: `wait ${n}` });
  assert.throws(() => h.runner.runNow(h.automation.id, { text: "too many" }), RoutineBusyError);
  assert.equal(h.runs.list(h.automation.id).length, SURFACE_LIMITS.queued + 1, "a refused message leaves no run behind");
});

test("a queued message can be stopped, and quitting ends the ones still waiting without running them", async () => {
  const g = gate();
  const h = harness(g.execute);
  h.runner.runNow(h.automation.id, { text: "live" });
  await flush();
  const waiting = h.runner.runNow(h.automation.id, { text: "stop me" });
  const lost = h.runner.runNow(h.automation.id, { text: "quit" });
  h.runner.stop(waiting.id);
  assert.equal(h.runs.get(waiting.id)?.status, "aborted");
  h.runner.dispose();
  assert.equal(h.runs.get(lost.id)?.reason, "app-quit");
  await flush();
  assert.deepEqual(g.prompts, ["post\n\nlive"], "neither waiting message ever reached the model");
});

test("a message for a routine that was switched off while it waited ends as skipped, not run", async () => {
  const g = gate();
  const h = harness(g.execute);
  h.runner.runNow(h.automation.id, { text: "live" });
  await flush();
  const waiting = h.runner.runNow(h.automation.id, { text: "late" });
  h.automations.setEnabled(h.automation.id, false);
  await g.release();
  assert.deepEqual([h.runs.get(waiting.id)?.status, h.runs.get(waiting.id)?.reason], ["aborted", "skipped"]);
  assert.equal(g.prompts.length, 1);
});

test("a message does not use up the slot a scheduled run is waiting for", async () => {
  const g = gate();
  const h = harness(g.execute, { trigger: { kind: "cron", expression: "0 9 * * *" } });
  h.runner.runNow(h.automation.id, { text: "hello" });
  await flush();
  assert.equal(h.automations.get(h.automation.id)?.lastScheduledAt, undefined);
  await g.release();
});

test("a message that cannot start because the routine is gone is an error, not a run", () => {
  const h = harness(untilAborted);
  assert.throws(() => h.runner.runNow("nope", { text: "x" }), /not found/);
});

test("a message goes through the same checks as any run: a signed-out routine is blocked and the model is never called", async () => {
  const g = gate();
  const h = harness(g.execute, {}, { token: async () => null });
  h.runner.runNow(h.automation.id, { text: "x" });
  await flush();
  await h.clock.advance(2_000); // the one retry of the token waits a moment
  assert.equal(g.prompts.length, 0);
  assert.deepEqual([h.finished[0]?.status, h.finished[0]?.blocker?.kind], ["failed", "auth"]);
});
