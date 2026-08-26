import assert from "node:assert/strict";
import test from "node:test";
import { goalPatchFromCommand, applyGoalCommandText, matchGoalCommand } from "../src/goal-command.js";

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
