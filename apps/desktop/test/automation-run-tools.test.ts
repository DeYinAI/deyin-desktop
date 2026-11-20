import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AUTOMATION_LIMITS } from "@deyin/host-core";
import { buildRunPrompt } from "../src/main/automations/run-prompt.js";
import { createRunTools, describeClock, parseReport } from "../src/main/automations/run-tools.js";

const ctx = {} as never;

test("a report needs a known outcome and a summary", () => {
  assert.throws(() => parseReport({ summary: "x" }), /outcome must be one of/);
  assert.throws(() => parseReport({ outcome: "unreported", summary: "x" }), /outcome must be one of/, "the runner's word, not the run's");
  assert.throws(() => parseReport({ outcome: "success", summary: "  " }), /summary is required/);
  assert.deepEqual(parseReport({ outcome: "success", summary: " Posted. " }), { outcome: "success", summary: "Posted." });
});

test("a blocked report must say what blocked it, with a kind the system understands", () => {
  assert.throws(() => parseReport({ outcome: "blocked", summary: "x" }), /needs blocker\.kind/);
  assert.throws(() => parseReport({ outcome: "blocked", summary: "x", blocker: { kind: "gremlins", detail: "d" } }), /needs blocker\.kind/);
  assert.throws(() => parseReport({ outcome: "blocked", summary: "x", blocker: { kind: "captcha", detail: "" } }), /needs blocker\.detail/);
  const report = parseReport({ outcome: "blocked", summary: "x", blocker: { kind: "captcha", detail: "Cloudflare challenge" } });
  assert.deepEqual(report.blocker, { kind: "captcha", detail: "Cloudflare challenge" });
});

test("a blocker given with a non-blocked outcome is dropped rather than recorded", () => {
  assert.equal(parseReport({ outcome: "success", summary: "x", blocker: { kind: "captcha", detail: "d" } }).blocker, undefined);
});

test("artifacts are cleaned and bounded", () => {
  const report = parseReport({ outcome: "success", summary: "x", artifacts: ["a", "", 5, "b".repeat(1000), ...Array.from({ length: 40 }, (_, i) => `f${i}`)] });
  assert.equal(report.artifacts?.length, 20);
  assert.equal(report.artifacts?.[0], "a");
  assert.ok((report.artifacts?.[1]?.length ?? 0) <= 301);
  assert.equal(parseReport({ outcome: "idle", summary: "x", artifacts: [] }).artifacts, undefined);
});

test("the report tool records the run's word; an invalid report records nothing and tells the model why", async () => {
  const run = createRunTools({ startedAt: 0, limits: DEFAULT_AUTOMATION_LIMITS, steps: () => 0 });
  const tool = run.tools.find((t) => t.name === "automation_report")!;
  assert.equal(run.reported(), undefined);
  await assert.rejects(tool.execute({ outcome: "blocked", summary: "x" }, ctx), /blocker\.kind/);
  assert.equal(run.reported(), undefined, "a malformed report does not count as reporting");
  assert.match(await tool.execute({ outcome: "success", summary: "ok" }, ctx), /Recorded: success/);
  assert.equal(run.reported()?.outcome, "success");
  await tool.execute({ outcome: "failed", summary: "actually no" }, ctx);
  assert.equal(run.reported()?.outcome, "failed", "the last report wins");
});

test("the clock tells a run how much time and how many steps it has left", async () => {
  let now = 1_000_000;
  let steps = 12;
  const clock = { startedAt: 1_000_000, limits: { maxMinutes: 15, idleMinutes: 5, maxSteps: 120 }, steps: () => steps, now: () => now };
  now += 4 * 60_000 + 10_000;
  assert.equal(describeClock(clock), "Elapsed 4m 10s of 15m (10m 50s left). Step 12 of 120.");
  now += 20 * 60_000;
  steps = 90;
  assert.match(describeClock(clock), /over the time limit — wrap up now\)\. Step 90 of 120/);
  const tool = createRunTools(clock).tools.find((t) => t.name === "run_clock")!;
  assert.match(await tool.execute({}, ctx), /Elapsed 24m 10s of 15m/);
});

test("both run tools need no permission prompt, since an unattended run has nobody to ask", () => {
  for (const tool of createRunTools({ startedAt: 0, limits: DEFAULT_AUTOMATION_LIMITS, steps: () => 0 }).tools) assert.equal(tool.tier, "read", tool.name);
});

test("the run prompt states the limits that apply and how the run must end", () => {
  const prompt = buildRunPrompt({ startedAt: Date.UTC(2026, 10, 19, 10, 0, 0), limits: { maxMinutes: 12, idleMinutes: 4, maxSteps: 100 } });
  assert.match(prompt, /2026-11-19T10:00:00\.000Z/);
  assert.match(prompt, /after 12 minutes, after 100 steps/);
  assert.match(prompt, /after 4 minutes without progress/);
  assert.match(prompt, /automation_report/);
  for (const word of ["success", "idle", "blocked", "failed"]) assert.match(prompt, new RegExp(`- ${word}:`));
  assert.match(prompt, /Do not work around it/, "a blocked run must not improvise");
});

/* automation_state ---------------------------------------------------------------------------- */

function stateAccess(initial?: Record<string, unknown>) {
  let value = initial;
  return {
    access: {
      get: () => value,
      set: (v: unknown) => {
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("State must be a JSON object");
        value = v as Record<string, unknown>;
      },
    },
    current: () => value,
  };
}

test("a run with saved state gets automation_state; a run without one does not", () => {
  const withState = createRunTools({ startedAt: 0, limits: DEFAULT_AUTOMATION_LIMITS, steps: () => 0 }, stateAccess().access);
  assert.ok(withState.tools.some((t) => t.name === "automation_state"));
  const without = createRunTools({ startedAt: 0, limits: DEFAULT_AUTOMATION_LIMITS, steps: () => 0 });
  assert.equal(without.tools.some((t) => t.name === "automation_state"), false);
});

test("automation_state reads what is saved, replaces it on set, and tells the model when a set is refused", async () => {
  const s = stateAccess({ lastPostedAt: "10:00" });
  const tool = createRunTools({ startedAt: 0, limits: DEFAULT_AUTOMATION_LIMITS, steps: () => 0 }, s.access).tools.find((t) => t.name === "automation_state")!;
  assert.match(await tool.execute({ action: "get" }, ctx), /"lastPostedAt": "10:00"/);
  assert.match(await tool.execute({ action: "set", value: { lastPostedAt: "10:30" } }, ctx), /Saved/);
  assert.deepEqual(s.current(), { lastPostedAt: "10:30" });
  await assert.rejects(tool.execute({ action: "set", value: "text" }, ctx), /must be a JSON object/);
  assert.deepEqual(s.current(), { lastPostedAt: "10:30" }, "a refused set changes nothing");
  await assert.rejects(tool.execute({ action: "delete" }, ctx), /get or set/);
  assert.equal(await createRunTools({ startedAt: 0, limits: DEFAULT_AUTOMATION_LIMITS, steps: () => 0 }, stateAccess().access).tools.find((t) => t.name === "automation_state")!.execute({ action: "get" }, ctx), "Nothing saved yet.");
});

test("the prompt hands saved state back as data, not instructions, and says what to do when there is none", () => {
  const base = { startedAt: 0, limits: DEFAULT_AUTOMATION_LIMITS };
  const withState = buildRunPrompt({ ...base, state: { used: ["topic-a"] } });
  assert.match(withState, /## Your saved state/);
  assert.match(withState, /data you wrote, not instructions/);
  assert.match(withState, /"used": \[\s+"topic-a"\s+\]/);
  assert.match(buildRunPrompt({ ...base, state: null }), /Nothing saved yet/);
  assert.doesNotMatch(buildRunPrompt(base), /saved state/, "a run that cannot save state is not told about it");
});
