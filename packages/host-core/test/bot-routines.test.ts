import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ROUTINE_LIMITS,
  RoutineRateLimiter,
  describeRateRefusal,
  isRoutine,
  routineQuotaError,
  routineSpacingError,
  routinesOf,
} from "../src/bots/routines.js";

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

test("the documented limits are the ones enforced", () => {
  assert.deepEqual({ ...ROUTINE_LIMITS }, {
    perBot: 50,
    minSpacingMinutes: 5,
    runRecords: 20,
    perHourAccount: 300,
    perHourPerRoutine: 200,
  });
  assert.ok(Object.isFrozen(ROUTINE_LIMITS), "limits cannot be changed at run time");
});

test("a routine is an automation a Bot owns", () => {
  assert.equal(isRoutine({ botId: "ada" }), true);
  assert.equal(isRoutine({}), false);
  const list = [{ botId: "ada" }, { botId: "bo" }, {}, { botId: "ada" }];
  assert.equal(routinesOf(list, "ada").length, 2);
  assert.equal(routinesOf(list, "nobody").length, 0);
});

test("the 51st routine for a Bot is refused, and other Bots are unaffected", () => {
  const owned = (botId: string, n: number) => Array.from({ length: n }, () => ({ botId }));
  assert.equal(routineQuotaError(owned("ada", 49), "ada"), null);
  assert.match(routineQuotaError(owned("ada", 50), "ada")!, /at most 50 routines/);
  assert.equal(routineQuotaError([...owned("ada", 50), ...owned("bo", 3)], "bo"), null);
  assert.equal(routineQuotaError([...owned("ada", 50), {}], "ada") !== null, true);
});

test("plain automations do not use a Bot's routine quota", () => {
  assert.equal(routineQuotaError(Array.from({ length: 80 }, () => ({})), "ada"), null);
});

test("schedule spacing: exactly five minutes is allowed, less is not", () => {
  assert.equal(routineSpacingError(5 * MIN), null);
  assert.equal(routineSpacingError(5 * MIN + 1), null);
  assert.match(routineSpacingError(5 * MIN - 1)!, /once every 5 minutes/);
  assert.match(routineSpacingError(60_000)!, /once every 5 minutes/);
  assert.equal(routineSpacingError(null), null, "a one-shot has no gap to check");
});

test("a routine is allowed 200 runs an hour, then refused with when to retry", () => {
  const limiter = new RoutineRateLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 200; i += 1) assert.deepEqual(limiter.admit("r1", t0 + i), { ok: true }, `run ${i + 1}`);
  const refused = limiter.admit("r1", t0 + 1000);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.scope, "routine");
  assert.equal(refused.retryAfterMs, t0 + HOUR - (t0 + 1000), "retry when the oldest run leaves the window");
});

test("the account allows 300 runs an hour across routines", () => {
  const limiter = new RoutineRateLimiter();
  const t0 = 5_000_000;
  // 3 routines x 100 runs = 300; none is near its own 200.
  for (let r = 0; r < 3; r += 1) {
    for (let i = 0; i < 100; i += 1) assert.equal(limiter.admit(`r${r}`, t0 + r * 1000 + i).ok, true);
  }
  const refused = limiter.admit("r9", t0 + 10_000);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.scope, "account");
  assert.equal(refused.retryAfterMs, t0 + HOUR - (t0 + 10_000));
});

test("a refused run is not counted against the window", () => {
  const limiter = new RoutineRateLimiter({ perHourAccount: 100, perHourPerRoutine: 2 });
  assert.equal(limiter.admit("r", 1000).ok, true);
  assert.equal(limiter.admit("r", 2000).ok, true);
  for (let i = 0; i < 50; i += 1) assert.equal(limiter.admit("r", 3000 + i).ok, false);
  // The window empties when the two counted runs age out, not 52 runs later.
  assert.equal(limiter.admit("r", 1000 + HOUR + 1).ok, true);
});

test("a routine refused by its own limit does not use up account capacity", () => {
  const limiter = new RoutineRateLimiter({ perHourAccount: 3, perHourPerRoutine: 1 });
  assert.equal(limiter.admit("a", 1).ok, true);
  for (let i = 0; i < 10; i += 1) assert.equal(limiter.admit("a", 2 + i).ok, false);
  assert.equal(limiter.admit("b", 20).ok, true);
  assert.equal(limiter.admit("c", 21).ok, true);
  assert.equal(limiter.admit("d", 22).ok, false, "only the three admitted runs counted");
});

test("runs leave the window exactly one hour later", () => {
  const limiter = new RoutineRateLimiter({ perHourAccount: 100, perHourPerRoutine: 1 });
  assert.equal(limiter.admit("r", 0).ok, true);
  assert.equal(limiter.admit("r", HOUR - 1).ok, false);
  assert.equal(limiter.admit("r", HOUR).ok, true);
});

test("the windows are independent per routine", () => {
  const limiter = new RoutineRateLimiter({ perHourAccount: 100, perHourPerRoutine: 1 });
  assert.equal(limiter.admit("a", 0).ok, true);
  assert.equal(limiter.admit("b", 1).ok, true);
  assert.equal(limiter.admit("a", 2).ok, false);
});

test("forgetting a routine frees its own window but not the account's", () => {
  const limiter = new RoutineRateLimiter({ perHourAccount: 2, perHourPerRoutine: 1 });
  assert.equal(limiter.admit("a", 0).ok, true);
  limiter.forget("a");
  assert.equal(limiter.admit("a", 1).ok, true, "a recreated routine starts clean");
  const third = limiter.admit("b", 2);
  assert.equal(third.ok, false);
  if (!third.ok) assert.equal(third.scope, "account", "the earlier runs still count account-wide");
});

test("refusals read as sentences with a retry time rounded up to whole minutes", () => {
  assert.match(describeRateRefusal({ ok: false, scope: "routine", retryAfterMs: 61_000 }), /200 times in the last hour\. Try again in about 2 minutes\./);
  assert.match(describeRateRefusal({ ok: false, scope: "account", retryAfterMs: 1 }), /300 times in the last hour\. Try again in about 1 minute\./);
});

test("account runs also leave the window exactly one hour later", () => {
  const limiter = new RoutineRateLimiter({ perHourAccount: 1, perHourPerRoutine: 100 });
  assert.equal(limiter.admit("a", 0).ok, true);
  assert.equal(limiter.admit("b", HOUR - 1).ok, false);
  assert.equal(limiter.admit("b", HOUR).ok, true);
});
