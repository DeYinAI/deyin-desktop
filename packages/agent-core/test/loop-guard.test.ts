import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLOCKED_STREAK_THRESHOLD,
  LoopGuard,
  NO_PROGRESS_NUDGE_ROUNDS,
  REPEAT_SUCCESS_THRESHOLD,
  STORM_THRESHOLD,
  errorCategory,
  looksFailed,
  type GuardOutcome,
} from "../src/loop-guard.js";

function outcome(over: Partial<GuardOutcome> = {}): GuardOutcome {
  return { toolName: "bash", result: "ok", ok: true, denied: false, argsKey: "{}", ...over };
}

const failed = (result: string, toolName = "bash"): GuardOutcome =>
  outcome({ toolName, result, ok: false });
const blocked = (result = "Denied: the user rejected this tool call.", toolName = "bash"): GuardOutcome =>
  outcome({ toolName, result, ok: false, denied: true });

test("errorCategory collapses the same failure wearing different details", () => {
  // A stuck model retries against a different path / line number. Those must
  // land in the same category or the storm detector never trips.
  assert.equal(
    errorCategory("ERROR: could not apply edit to 'src/a.ts' at line 42"),
    errorCategory("ERROR: could not apply edit to 'src/b.ts' at line 91"),
  );
  // Genuinely different failures stay distinct.
  assert.notEqual(errorCategory("ERROR: ENOENT missing file"), errorCategory("Denied: nope"));
});

test("looksFailed treats an ERROR: string as a failure, not a success", () => {
  assert.equal(looksFailed("ERROR: boom"), true);
  assert.equal(looksFailed("Denied: nope"), true);
  assert.equal(looksFailed("Blocked by hook: nope"), true);
  assert.equal(looksFailed("wrote 3 bytes"), false);
});

test("storm detector fires on the third identical failure, not before", () => {
  const guard = new LoopGuard();
  const call = () => guard.observe([failed("ERROR: ENOENT no such file")]);
  for (let i = 1; i < STORM_THRESHOLD; i++) {
    assert.equal(call(), null, `fired early on attempt ${i}`);
  }
  const trip = call();
  assert.ok(trip, "third identical failure must trip the guard");
  assert.equal(trip!.code, "storm");
  assert.match(trip!.message, /loop guard/);
});

test("a success between failures resets the storm counter", () => {
  const guard = new LoopGuard();
  guard.observe([failed("ERROR: ENOENT no such file")]);
  guard.observe([failed("ERROR: ENOENT no such file")]);
  guard.observe([outcome({ argsKey: '{"path":"a"}' })]); // progress
  assert.equal(guard.observe([failed("ERROR: ENOENT no such file")]), null);
});

test("reworded arguments do not escape the storm detector", () => {
  // The whole point of keying on the host response: the model changes the args
  // every time but keeps hitting the same wall.
  const guard = new LoopGuard();
  let trip = null;
  for (let i = 0; i < STORM_THRESHOLD; i++) {
    trip = guard.observe([outcome({ result: "ERROR: ENOENT no such file", ok: false, argsKey: `{"try":${i}}` })]);
  }
  assert.ok(trip);
  assert.equal(trip!.code, "storm");
});

test("blocked-streak fires when every call is refused for three turns", () => {
  const guard = new LoopGuard();
  // Rotate tools and vary the message so the signature detector cannot match:
  // only the streak detector should catch this.
  const trips = [
    guard.observe([blocked("Denied: a", "edit")]),
    guard.observe([blocked("Blocked by hook: b", "write")]),
    guard.observe([blocked("ERROR: delivery gate (c): nope", "bash")]),
  ];
  assert.equal(trips[0], null);
  assert.equal(trips[1], null);
  assert.ok(trips[2]);
  assert.equal(trips[2]!.code, "blocked-streak");
  assert.match(trips[2]!.message, new RegExp(String(BLOCKED_STREAK_THRESHOLD)));
});

test("repeat-success precheck blocks the third identical write", () => {
  const guard = new LoopGuard();
  const args = '{"path":"a.ts","content":"x"}';
  for (let i = 0; i < REPEAT_SUCCESS_THRESHOLD - 1; i++) {
    assert.equal(guard.precheck("write", args, "write"), null, `blocked early at ${i}`);
    guard.observe([outcome({ toolName: "write", argsKey: args })]);
  }
  const refusal = guard.precheck("write", args, "write");
  assert.ok(refusal, "the third identical write should be refused");
  assert.match(refusal!, /loop guard/);
});

test("repeat-success never blocks read-tier tools", () => {
  const guard = new LoopGuard();
  const args = '{"path":"a.ts"}';
  for (let i = 0; i < 5; i++) {
    assert.equal(guard.precheck("read", args, "read"), null);
    guard.observe([outcome({ toolName: "read", argsKey: args })]);
  }
});

test("no-progress nudge fires after the configured rounds of churn", () => {
  const guard = new LoopGuard();
  const args = '{"path":"a.ts"}';
  // The same successful read over and over: succeeds, but adds nothing new.
  let trip = null;
  for (let i = 0; i < NO_PROGRESS_NUDGE_ROUNDS + 1; i++) {
    const got = guard.observe([outcome({ toolName: "read", argsKey: args })]);
    if (got) trip = got;
  }
  assert.ok(trip, "repeating one read forever must eventually be noticed");
  assert.equal(trip!.code, "no-progress");
});

test("genuinely new work never trips the no-progress guard", () => {
  const guard = new LoopGuard();
  for (let i = 0; i < NO_PROGRESS_NUDGE_ROUNDS * 2; i++) {
    const trip = guard.observe([outcome({ toolName: "read", argsKey: `{"path":"f${i}.ts"}` })]);
    assert.equal(trip, null, `fired on genuinely new work at round ${i}`);
  }
});

test("an empty batch is not an event", () => {
  assert.equal(new LoopGuard().observe([]), null);
});
