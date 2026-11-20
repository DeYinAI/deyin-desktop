import assert from "node:assert/strict";
import test from "node:test";
import type { Automation, AutomationBlocker, AutomationHealth, AutomationRun } from "@deyin/host-core";
import {
  HealthKeeper,
  PAUSE_AFTER_FAILURES,
  PAUSE_AFTER_UNREPORTED,
  PROBE_SCHEDULE_MS,
  checkRequiredTools,
  classifyError,
  connectWithRetry,
  matchesGlob,
  preflight,
  recordOutcome,
  recordProbe,
} from "../src/main/automations/health.js";
import { FakeClock, flush } from "./helpers/fake-clock.js";

const MINUTE = 60_000;
const NOW = 1_000_000_000_000;

/* Error classification ---------------------------------------------------------------------- */

test("errors are sorted into 'try again', 'rate limited', 'signed out' and 'stop'", () => {
  for (const message of ["fetch failed", "read ECONNRESET", "503 Service Unavailable", "upstream overloaded", "request timed out", "getaddrinfo ENOTFOUND api.example.com"]) {
    assert.deepEqual(classifyError(message), { transient: true, kind: "other" }, message);
  }
  assert.deepEqual(classifyError("429 Too Many Requests"), { transient: true, kind: "rate-limit" });
  assert.deepEqual(classifyError("monthly quota exceeded"), { transient: true, kind: "rate-limit" });
  for (const message of ["401 Unauthorized", "Not signed in. Connect your account.", "invalid api key"]) {
    assert.deepEqual(classifyError(message), { transient: false, kind: "auth" }, message);
  }
  assert.deepEqual(classifyError("MCP server crashed"), { transient: false, kind: "mcp" });
  assert.deepEqual(classifyError("Cannot read properties of undefined"), { transient: false, kind: "other" });
});

/* Required tools ---------------------------------------------------------------------------- */

test("a required tool is satisfied by an exact name or a glob, and a missing one blocks with the pattern named", () => {
  assert.equal(matchesGlob("chrome_open", "chrome_*"), true);
  assert.equal(matchesGlob("chrome_open", "chrome_open"), true);
  assert.equal(matchesGlob("xchrome_open", "chrome_*"), false, "anchored at the start");
  assert.equal(matchesGlob("chrome_open", "chrome_op"), false, "anchored at the end");
  assert.equal(matchesGlob("a.b", "a.b"), true);
  assert.equal(matchesGlob("axb", "a.b"), false, "a dot is a dot");

  assert.equal(checkRequiredTools(undefined, []), null);
  assert.equal(checkRequiredTools({ tools: ["chrome_*", "bash"] }, ["chrome_open", "bash"]), null);
  const blocker = checkRequiredTools({ tools: ["chrome_*", "bash"] }, ["bash"], () => "Chrome control is off.");
  assert.equal(blocker?.kind, "tool-missing");
  assert.match(blocker?.detail ?? "", /"chrome_\*" is not available/);
  assert.match(blocker?.detail ?? "", /Chrome control is off\./);
});

/* Preflight --------------------------------------------------------------------------------- */

function probes(tokens: Array<string | null>, exists = true) {
  const slept: number[] = [];
  let calls = 0;
  return {
    probes: {
      token: async () => tokens[Math.min(calls++, tokens.length - 1)] ?? null,
      workspaceExists: () => exists,
      sleep: async (ms: number) => void slept.push(ms),
    },
    slept,
    calls: () => calls,
  };
}
const local = { target: { kind: "local" as const, workspacePath: "/w" } };

test("preflight passes a signed-in automation with its workspace, without sleeping", async () => {
  const p = probes(["tok"]);
  assert.deepEqual(await preflight(local, p.probes), { ok: true, token: "tok" });
  assert.deepEqual(p.slept, []);
});

test("a token that fails once is tried again after a pause; one that fails twice is a sign-in problem", async () => {
  const flaky = probes([null, "tok"]);
  assert.deepEqual(await preflight(local, flaky.probes), { ok: true, token: "tok" });
  assert.equal(flaky.slept.length, 1);

  const out = probes([null, null]);
  const result = await preflight(local, out.probes);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.blocker.kind, "auth");
  assert.equal(out.calls(), 2, "exactly one retry");
});

test("a local workspace that is gone blocks the run; a remote target is not checked on this machine", async () => {
  const missing = await preflight(local, probes(["tok"], false).probes);
  assert.equal(!missing.ok && missing.blocker.detail, "The workspace folder does not exist: /w");
  const wsl = await preflight({ target: { kind: "wsl", distro: "Ubuntu", workspacePath: "/home/x" } }, probes(["tok"], false).probes);
  assert.equal(wsl.ok, true);
});

/* Connecting with retries ------------------------------------------------------------------- */

test("only the servers that failed are retried, with backoff, and a late success is kept", async () => {
  const calls: string[][] = [];
  const attemptsByName = new Map<string, number>();
  const slept: number[] = [];
  const result = await connectWithRetry(
    [{ name: "a" }, { name: "b" }, { name: "c" }],
    async (defs, onFail) => {
      calls.push(defs.map((d) => d.name));
      const connected: string[] = [];
      for (const { name } of defs) {
        const n = (attemptsByName.get(name) ?? 0) + 1;
        attemptsByName.set(name, n);
        if (name === "b" && n < 2) onFail(name, new Error("down"));
        else if (name === "c") onFail(name, new Error("still down"));
        else connected.push(name);
      }
      return connected;
    },
    { attempts: 3, backoffMs: [100, 300], sleep: async (ms) => void slept.push(ms) },
  );
  assert.deepEqual(calls, [["a", "b", "c"], ["b", "c"], ["c"]]);
  assert.deepEqual(slept, [100, 300]);
  assert.deepEqual(result.connections, ["a", "b"]);
  assert.deepEqual(result.failures.map((f) => f.name), ["c"], "b recovered, c is reported by name");
});

test("a failure that retrying cannot fix is reported at once, and the attempts are capped", async () => {
  let attempts = 0;
  const slept: number[] = [];
  const needsSignIn = await connectWithRetry(
    [{ name: "oauth" }],
    async (_d, onFail) => {
      attempts += 1;
      onFail("oauth", new Error("401"));
      return [];
    },
    { attempts: 3, backoffMs: [1], sleep: async (ms) => void slept.push(ms), retryable: () => false },
  );
  assert.equal(attempts, 1);
  assert.deepEqual(slept, []);
  assert.equal(needsSignIn.failures.length, 1);

  attempts = 0;
  await connectWithRetry(
    [{ name: "flaky" }],
    async (_d, onFail) => {
      attempts += 1;
      onFail("flaky", new Error("down"));
      return [];
    },
    { attempts: 3, backoffMs: [1], sleep: async () => undefined },
  );
  assert.equal(attempts, 3);
});

/* The state machine ------------------------------------------------------------------------- */

const failedRun = (patch: Partial<AutomationRun> = {}): Pick<AutomationRun, "outcome" | "blocker" | "reason"> => ({ outcome: "failed", reason: "boom", ...patch });
const blockedRun = (blocker: AutomationBlocker) => ({ outcome: "blocked" as const, blocker, reason: `blocked: ${blocker.kind}` });

function fold(runs: Array<Pick<AutomationRun, "outcome" | "blocker" | "reason">>, from?: AutomationHealth) {
  let health = from;
  const events: string[] = [];
  runs.forEach((run, i) => {
    const t = recordOutcome(health, run, NOW + i * MINUTE);
    health = t.health;
    if (t.paused) events.push(`paused:${t.paused.kind}`);
    if (t.resumed) events.push("resumed");
  });
  return { health: health!, events };
}

test("three failures in a row pause the automation, with a probe scheduled; two do not", () => {
  const two = fold([failedRun(), failedRun()]);
  assert.equal(two.health.consecutiveFailures, 2);
  assert.equal(two.health.pausedAt, undefined);

  const three = fold([failedRun(), failedRun(), failedRun({ reason: "last one" })]);
  assert.deepEqual(three.events, ["paused:failures"]);
  assert.match(three.health.pausedReason ?? "", /3 runs in a row failed\. Last: last one/);
  assert.equal(three.health.nextProbeAt, NOW + 2 * MINUTE + PROBE_SCHEDULE_MS[0]!);
  assert.equal(PAUSE_AFTER_FAILURES, 3);
});

test("a success in between starts the count again", () => {
  const { health, events } = fold([failedRun(), failedRun(), { outcome: "success" }, failedRun(), failedRun()]);
  assert.equal(health.consecutiveFailures, 2);
  assert.deepEqual(events, []);
});

test("a blocker only a person can clear pauses at once and is never probed", () => {
  for (const kind of ["login-required", "captcha", "account-warning", "approval-required", "stopped"] as const) {
    const { health, events } = fold([blockedRun({ kind, detail: "x.com login page" })]);
    assert.deepEqual(events, [`paused:${kind}`], kind);
    assert.equal(health.nextProbeAt, undefined, `${kind} schedules no probe`);
    assert.equal(health.pausedReason, "x.com login page");
  }
});

test("a blocker that may clear on its own needs the full three, then pauses with a probe", () => {
  const blocker = { kind: "rate-limit" as const, detail: "429 from the API" };
  assert.deepEqual(fold([blockedRun(blocker), blockedRun(blocker)]).events, []);
  const three = fold([blockedRun(blocker), blockedRun(blocker), blockedRun(blocker)]);
  assert.deepEqual(three.events, ["paused:rate-limit"]);
  assert.ok(three.health.nextProbeAt);
});

test("unreported runs are soft: they neither break a failure streak nor count as one, until there are too many", () => {
  const mixed = fold([failedRun(), failedRun(), { outcome: "unreported" }]);
  assert.equal(mixed.health.consecutiveFailures, 2, "an unreported run is not a success, so the streak stands…");
  assert.deepEqual(mixed.events, [], "…and is not a failure, so it does not complete it");

  const many = fold(Array.from({ length: PAUSE_AFTER_UNREPORTED }, () => ({ outcome: "unreported" as const })));
  assert.deepEqual(many.events, ["paused:failures"]);
  assert.match(many.health.pausedReason ?? "", /without reporting/);
  assert.equal(fold(Array.from({ length: PAUSE_AFTER_UNREPORTED - 1 }, () => ({ outcome: "unreported" as const }))).events.length, 0);
});

test("runs with no outcome (a user stop, a skipped tick) leave health alone", () => {
  const before = fold([failedRun(), failedRun()]).health;
  const after = recordOutcome(before, { outcome: undefined, reason: "stopped" }, NOW);
  assert.deepEqual(after.health, before);
  assert.equal(after.paused, undefined);
});

test("a success on a paused automation resumes it and wipes the pause; idle counts the same", () => {
  const paused = fold([blockedRun({ kind: "login-required", detail: "login page" })]).health;
  for (const outcome of ["success", "idle"] as const) {
    const t = recordOutcome(paused, { outcome, reason: "completed" }, NOW + 5);
    assert.equal(t.resumed, true);
    assert.equal(t.health.pausedAt, undefined);
    assert.equal(t.health.consecutiveFailures, 0);
    assert.equal(t.health.lastSuccessAt, NOW + 5);
    assert.equal(t.health.probeAttempts, 0, "a real success resets the probe escalation");
  }
});

test("another failure of an already-paused automation is not news, and keeps when the pause began", () => {
  const paused = fold([failedRun(), failedRun(), failedRun()]).health;
  const again = recordOutcome(paused, failedRun({ reason: "still broken" }), NOW + 99 * MINUTE);
  assert.equal(again.paused, undefined);
  assert.equal(again.health.pausedAt, paused.pausedAt);
  assert.equal(again.health.nextProbeAt, paused.nextProbeAt);
});

test("probes escalate 30m, 2h, 6h, then stop; a pass resumes with one strike left", () => {
  let health = fold([failedRun(), failedRun(), failedRun()]).health;
  const gaps: Array<number | undefined> = [];
  let now = NOW;
  for (let i = 0; i < 3; i += 1) {
    now = health.nextProbeAt ?? now;
    health = recordProbe(health, false, now).health;
    gaps.push(health.nextProbeAt === undefined ? undefined : health.nextProbeAt - now);
  }
  assert.deepEqual(gaps, [PROBE_SCHEDULE_MS[1], PROBE_SCHEDULE_MS[2], undefined]);
  assert.equal(health.pausedAt !== undefined, true, "still paused, waiting for a person");

  const resumed = recordProbe(health, true, now);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.health.pausedAt, undefined);
  assert.equal(resumed.health.consecutiveFailures, PAUSE_AFTER_FAILURES - 1);
  assert.equal(resumed.health.probeAttempts, 3, "a flapping automation keeps escalating");
  // One more failure and it is paused again at once.
  assert.deepEqual(recordOutcome(resumed.health, failedRun(), now).paused?.kind, "failures");
});

/* The keeper -------------------------------------------------------------------------------- */

function keeperHarness(probeResult: () => AutomationBlocker | null = () => null) {
  const clock = new FakeClock();
  clock.t = NOW;
  const store = new Map<string, Automation>();
  const log: string[] = [];
  const automation = {
    id: "a1",
    name: "X growth",
    enabled: true,
    payload: { kind: "prompt", prompt: "go" },
    trigger: { kind: "cron", expression: "*/30 * * * *" },
    target: { kind: "local", workspacePath: "/w" },
    model: "m",
    providerId: "openference",
    createdAt: 0,
    updatedAt: 0,
    description: "",
  } as Automation;
  store.set(automation.id, automation);
  const keeper = new HealthKeeper({
    get: (id) => store.get(id),
    patch: (id, patch) => void Object.assign(store.get(id)!, patch),
    setEnabled: (id, enabled) => {
      store.get(id)!.enabled = enabled;
      log.push(`enabled:${enabled}`);
    },
    probe: async () => {
      log.push("probe");
      return probeResult();
    },
    notify: (_a, message) => void log.push(`notify:${message.split(":")[0]}`),
    clock,
  });
  const finishRun = (patch: Partial<AutomationRun>) =>
    keeper.recordRun({ id: "r", automationId: "a1", status: "failed", startedAt: 0, events: [], ...patch });
  return { keeper, clock, store, log, automation, finishRun };
}

test("the third failure disables the automation once, tells the user, and arms a probe", async () => {
  const h = keeperHarness();
  for (let i = 0; i < 2; i += 1) h.finishRun({ outcome: "failed", reason: "boom" });
  assert.deepEqual(h.log, []);
  h.finishRun({ outcome: "failed", reason: "boom" });
  assert.deepEqual(h.log, ["enabled:false", "notify:Paused"]);
  assert.equal(h.automation.enabled, false);
  assert.equal(h.clock.pending(), 1, "a probe is armed");
  h.finishRun({ outcome: "failed", reason: "boom" }); // a manual run while paused
  assert.deepEqual(h.log, ["enabled:false", "notify:Paused"], "no second notification");
});

test("a pause the user must clear arms no probe and says it needs them", async () => {
  const h = keeperHarness();
  h.finishRun({ outcome: "blocked", status: "failed", blocker: { kind: "login-required", detail: "login page" } });
  assert.equal(h.automation.enabled, false);
  assert.equal(h.clock.pending(), 0);
  assert.equal(h.automation.health?.pausedKind, "login-required");
});

test("the probe runs after its delay, and a pass re-enables the automation", async () => {
  const h = keeperHarness(() => null);
  for (let i = 0; i < 3; i += 1) h.finishRun({ outcome: "failed", reason: "boom" });
  h.log.length = 0;
  await h.clock.advance(PROBE_SCHEDULE_MS[0]! - 1);
  assert.deepEqual(h.log, [], "not yet");
  await h.clock.advance(1);
  assert.deepEqual(h.log, ["probe", "enabled:true", "notify:Resumed"]);
  assert.equal(h.automation.enabled, true);
  assert.equal(h.automation.health?.pausedAt, undefined);
  assert.equal(h.clock.pending(), 0);
});

test("a probe that still finds the problem schedules the next one further out", async () => {
  const h = keeperHarness(() => ({ kind: "auth", detail: "Not signed in." }));
  for (let i = 0; i < 3; i += 1) h.finishRun({ outcome: "failed", reason: "boom" });
  await h.clock.advance(PROBE_SCHEDULE_MS[0]!);
  assert.equal(h.automation.enabled, false);
  assert.equal(h.automation.health?.probeAttempts, 1);
  await h.clock.advance(PROBE_SCHEDULE_MS[1]! - 1);
  assert.equal(h.log.filter((l) => l === "probe").length, 1);
  await h.clock.advance(1);
  assert.equal(h.log.filter((l) => l === "probe").length, 2);
  await h.clock.advance(PROBE_SCHEDULE_MS[2]!);
  assert.equal(h.log.filter((l) => l === "probe").length, 3);
  assert.equal(h.clock.pending(), 0, "after the last probe, only a person can resume it");
});

test("a probe that throws counts as a failed probe rather than crashing the keeper", async () => {
  const h = keeperHarness(() => {
    throw new Error("registry exploded");
  });
  for (let i = 0; i < 3; i += 1) h.finishRun({ outcome: "failed", reason: "boom" });
  await h.clock.advance(PROBE_SCHEDULE_MS[0]!);
  assert.equal(h.automation.enabled, false);
  assert.equal(h.automation.health?.probeAttempts, 1);
});

test("the user taking over cancels the probe, and clears the pause without re-enabling", async () => {
  const h = keeperHarness();
  for (let i = 0; i < 3; i += 1) h.finishRun({ outcome: "failed", reason: "boom" });
  h.keeper.clear("a1");
  assert.equal(h.clock.pending(), 0);
  assert.equal(h.automation.health?.pausedAt, undefined);
  assert.equal(h.automation.health?.consecutiveFailures, 0);
  await h.clock.advance(10 * 3_600_000);
  assert.equal(h.log.includes("probe"), false);
});

test("a user who resumes mid-probe is not overridden when the probe lands", async () => {
  let release!: () => void;
  const h = keeperHarness();
  (h.keeper as unknown as { ports: { probe: () => Promise<null> } }).ports.probe = () => new Promise<null>((resolve) => (release = () => resolve(null)));
  for (let i = 0; i < 3; i += 1) h.finishRun({ outcome: "failed", reason: "boom" });
  await h.clock.advance(PROBE_SCHEDULE_MS[0]!);
  h.keeper.clear("a1"); // the user took over while the probe was in flight
  h.log.length = 0;
  release();
  await flush();
  assert.deepEqual(h.log, [], "the probe's answer is discarded");
});

test("paused automations are probed again after an app restart", async () => {
  const h = keeperHarness();
  for (let i = 0; i < 3; i += 1) h.finishRun({ outcome: "failed", reason: "boom" });
  h.keeper.dispose();
  assert.equal(h.clock.pending(), 0);
  h.keeper.start([...h.store.values()]);
  assert.equal(h.clock.pending(), 1);
  h.keeper.dispose();
});

test("a run for an automation that was deleted is ignored", () => {
  const h = keeperHarness();
  h.store.clear();
  h.finishRun({ outcome: "failed", reason: "boom" });
  assert.deepEqual(h.log, []);
});
