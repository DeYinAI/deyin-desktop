import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGoalCommandText,
  goalCommandDescription,
  goalComposerHint,
  goalInputAction,
  goalPatchFromCommand,
  matchGoalCommand,
} from "../src/goal-command.js";

test("matchGoalCommand parses set and clear forms", () => {
  assert.equal(matchGoalCommand("/goal make tests pass"), "make tests pass");
  assert.equal(matchGoalCommand("  /goal  fix the bug  "), "fix the bug");
  assert.equal(matchGoalCommand("/GOAL"), null);
  assert.equal(matchGoalCommand("/goal"), null);
  assert.equal(matchGoalCommand("/goal   "), null);
});

test("matchGoalCommand ignores non-goal input", () => {
  assert.equal(matchGoalCommand("/commit all"), undefined);
  assert.equal(matchGoalCommand("ship it"), undefined);
  assert.equal(matchGoalCommand("/goals are cool"), undefined);
});

test("applyGoalCommandText invokes callback for /goal", () => {
  let applied: string | null | undefined;
  assert.equal(
    applyGoalCommandText("/goal fix bug", (goal) => {
      applied = goal;
    }),
    true,
  );
  assert.equal(applied, "fix bug");
  assert.equal(
    applyGoalCommandText("/fix bug", () => {
      applied = "should not run";
    }),
    false,
  );
});

test("goalPatchFromCommand builds active goal or clears", () => {
  const set = goalPatchFromCommand("All tests pass");
  assert.equal(set.goal?.text, "All tests pass");
  assert.equal(set.goal?.status, "active");
  assert.ok(set.goal?.setAt);

  assert.equal(goalPatchFromCommand(null).goal, undefined);
});

/* goalInputAction: each /goal form keeps its own meaning --------------------- */

test("goalInputAction: a bare /goal is status, never a clear", () => {
  assert.deepEqual(goalInputAction("/goal"), { kind: "status" });
  assert.deepEqual(goalInputAction("/GOAL"), { kind: "status" });
  assert.deepEqual(goalInputAction("/goal   "), { kind: "status" });
  // The legacy helper still collapses these into "clear"; the new action must not.
  assert.equal(matchGoalCommand("/goal"), null);
});

test("goalInputAction: control words map to their own actions", () => {
  assert.deepEqual(goalInputAction("/goal clear"), { kind: "clear" });
  assert.deepEqual(goalInputAction("/goal pause"), { kind: "pause" });
  assert.deepEqual(goalInputAction("/goal resume"), { kind: "resume" });
  assert.deepEqual(goalInputAction("/goal PAUSE"), { kind: "pause" });
});

test("goalInputAction: any other text is a new objective", () => {
  assert.deepEqual(goalInputAction("/goal make the build green"), { kind: "set", objective: "make the build green" });
  assert.deepEqual(goalInputAction("  /goal  fix the bug  "), { kind: "set", objective: "fix the bug" });
  // A control word inside a longer objective is not a control word.
  assert.deepEqual(goalInputAction("/goal pause polling when offline"), {
    kind: "set",
    objective: "pause polling when offline",
  });
});

test("goalInputAction: non-goal input passes through", () => {
  assert.deepEqual(goalInputAction("ship it"), { kind: "not-goal" });
  assert.deepEqual(goalInputAction("/commit all"), { kind: "not-goal" });
  assert.deepEqual(goalInputAction("/goals are cool"), { kind: "not-goal" });
  assert.deepEqual(goalInputAction("please /goal this"), { kind: "not-goal" });
});

/* Composer copy ---------------------------------------------------------------- */

test("goalComposerHint explains what Enter does while an objective is typed", () => {
  assert.equal(goalComposerHint("hello", null), null);
  assert.equal(goalComposerHint("/goal", null), null, "no hint until the command has a space");
  assert.match(goalComposerHint("/goal ", null) ?? "", /restates this as a checkable objective/);
  assert.match(goalComposerHint("/goal fix it", undefined) ?? "", /then starts working/);
});

test("goalComposerHint names the current goal and offers to replace it", () => {
  const hint = goalComposerHint("/goal ship v2", "ship v1");
  assert.match(hint ?? "", /Current goal: ship v1/);
  assert.match(hint ?? "", /replace it/);
});

test("goalComposerHint stays quiet for control words that act on the existing goal", () => {
  assert.equal(goalComposerHint("/goal pause ", "ship v1"), null);
  assert.equal(goalComposerHint("/goal clear ", "ship v1"), null);
  assert.equal(goalComposerHint("/goal resume ", "ship v1"), null);
});

test("goalCommandDescription switches between set and replace", () => {
  assert.match(goalCommandDescription(null), /Set a goal/);
  assert.match(goalCommandDescription(undefined), /Set a goal/);
  assert.match(goalCommandDescription("ship v1"), /Replace the current goal/);
});
