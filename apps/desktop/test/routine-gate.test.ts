import assert from "node:assert/strict";
import test from "node:test";
import { RoutineRateLimiter, type BotResult } from "@deyin/host-core";
import { RoutineGate, cronMinGapMs, routineScheduleError } from "../src/main/automations/routine-gate.js";

const FROM = Date.UTC(2026, 0, 5, 12, 0, 0);
const MIN = 60_000;

test("a cron schedule's shortest gap is measured, not just its first", () => {
  assert.equal(cronMinGapMs("*/5 * * * *", FROM), 5 * MIN);
  assert.equal(cronMinGapMs("* * * * *", FROM), MIN);
  // A daily run is a day apart, give or take the hour a daylight-saving change in the host's zone moves it.
  const daily = cronMinGapMs("0 9 * * *", FROM)!;
  assert.ok(daily >= 23 * 60 * MIN && daily <= 24 * 60 * MIN, `daily gap was ${daily}`);
  // Uneven: runs at :00 and :02 — gaps of 2 and 58 minutes. The shortest is 2.
  assert.equal(cronMinGapMs("0,2 * * * *", FROM), 2 * MIN);
  assert.equal(cronMinGapMs("0 * * * *", FROM), 60 * MIN);
});

test("a six-field schedule with seconds is measured in seconds", () => {
  assert.equal(cronMinGapMs("*/30 * * * * *", FROM), 30_000);
});

test("a schedule that never repeats has no gap", () => {
  assert.equal(cronMinGapMs("0 0 1 1 *", FROM, 1), null);
});

test("an unparseable expression throws from the measurer", () => {
  assert.throws(() => cronMinGapMs("not a cron", FROM));
});

test("routine schedules: every five minutes passes, every minute and uneven short gaps do not", () => {
  const cron = (expression: string) => routineScheduleError({ kind: "cron", expression }, FROM);
  assert.equal(cron("*/5 * * * *"), null);
  assert.equal(cron("0 9 * * *"), null);
  assert.match(cron("* * * * *")!, /once every 5 minutes/);
  assert.match(cron("*/4 * * * *")!, /once every 5 minutes/);
  assert.match(cron("0,2 * * * *")!, /once every 5 minutes/);
  assert.match(cron("*/30 * * * * *")!, /once every 5 minutes/);
});

test("one-shot and manual routines have no schedule to refuse", () => {
  assert.equal(routineScheduleError({ kind: "manual" }, FROM), null);
  assert.equal(routineScheduleError({ kind: "once", at: FROM + 1000 }, FROM), null);
});

test("an unparseable expression is left to the cron validator, not reported as a spacing problem", () => {
  assert.equal(routineScheduleError({ kind: "cron", expression: "garbage" }, FROM), null);
});

const ok: BotResult<unknown> = { ok: true, value: {} };

function gate(resolve: (id: string) => BotResult<unknown> = () => ok, limiter?: RoutineRateLimiter): RoutineGate {
  return new RoutineGate({ resolveBot: resolve, ...(limiter ? { limiter } : {}) });
}

test("a plain automation always passes and never touches a Bot or the limiter", () => {
  let looked = 0;
  const g = gate(() => {
    looked += 1;
    return ok;
  }, new RoutineRateLimiter({ perHourAccount: 0, perHourPerRoutine: 0 }));
  assert.equal(g.admit({ id: "a" }, 1), null);
  assert.equal(looked, 0);
});

test("a routine passes while its Bot can run", () => {
  assert.equal(gate().admit({ id: "r", botId: "ada" }, 1), null);
});

test("a routine whose Bot cannot run is skipped, with the reason from the Bot", () => {
  const g = gate(() => ({ ok: false, error: "Ada is archived. Restore it to chat with it.", code: "conflict" }));
  assert.equal(g.admit({ id: "r", botId: "ada" }, 1), "skipped: Ada is archived. Restore it to chat with it.");
});

test("a skipped run does not use up the hour's allowance", () => {
  let runnable = false;
  const limiter = new RoutineRateLimiter({ perHourAccount: 100, perHourPerRoutine: 1 });
  const g = gate(() => (runnable ? ok : { ok: false, error: "gone", code: "not_found" }), limiter);
  for (let i = 0; i < 5; i += 1) assert.match(g.admit({ id: "r", botId: "ada" }, i)!, /^skipped:/);
  runnable = true;
  assert.equal(g.admit({ id: "r", botId: "ada" }, 10), null, "the one allowed run is still available");
});

test("a routine over its hourly limit is rate-limited, with a reason that says when to retry", () => {
  const g = gate(() => ok, new RoutineRateLimiter({ perHourAccount: 100, perHourPerRoutine: 2 }));
  assert.equal(g.admit({ id: "r", botId: "ada" }, 0), null);
  assert.equal(g.admit({ id: "r", botId: "ada" }, 1), null);
  const refusal = g.admit({ id: "r", botId: "ada" }, 2)!;
  assert.match(refusal, /^rate-limited: This routine has run 200 times in the last hour\. Try again in about 60 minutes\.$/);
});

test("forgetting a routine lets a recreated one start clean", () => {
  const g = gate(() => ok, new RoutineRateLimiter({ perHourAccount: 100, perHourPerRoutine: 1 }));
  assert.equal(g.admit({ id: "r", botId: "ada" }, 0), null);
  assert.notEqual(g.admit({ id: "r", botId: "ada" }, 1), null);
  g.forget("r");
  assert.equal(g.admit({ id: "r", botId: "ada" }, 2), null);
});
