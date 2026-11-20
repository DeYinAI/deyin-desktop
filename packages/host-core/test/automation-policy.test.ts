import assert from "node:assert/strict";
import test from "node:test";
import { BLOCKER_KINDS, isHumanBlocker, limitsError } from "../src/automation-policy.js";

test("usable limits pass, including none at all and partial overrides", () => {
  assert.equal(limitsError(undefined), null);
  assert.equal(limitsError({}), null);
  assert.equal(limitsError({ maxMinutes: 12, idleMinutes: 4, maxSteps: 100 }), null);
  assert.equal(limitsError({ maxSteps: 1_000 }), null);
});

test("out-of-range, fractional and non-numeric limits are refused with a message that names the field and the range", () => {
  assert.match(limitsError({ maxMinutes: 0 }) ?? "", /Run time limit \(minutes\) must be a whole number from 1 to 240/);
  assert.match(limitsError({ maxMinutes: 241 }) ?? "", /1 to 240/);
  assert.match(limitsError({ idleMinutes: 61 }) ?? "", /Quiet limit .* 1 to 60/);
  assert.match(limitsError({ maxSteps: 1_001 }) ?? "", /Step limit .* 1 to 1000/);
  assert.match(limitsError({ maxSteps: 2.5 }) ?? "", /whole number/);
  assert.match(limitsError({ maxSteps: "many" as unknown as number }) ?? "", /Step limit/);
  assert.match(limitsError({ maxSteps: Number.NaN }) ?? "", /Step limit/);
});

test("a quiet allowance longer than the whole run is refused, since it could never trip", () => {
  assert.match(limitsError({ maxMinutes: 5, idleMinutes: 10 }) ?? "", /cannot be longer/);
  assert.equal(limitsError({ maxMinutes: 10, idleMinutes: 10 }), null);
});

test("blockers that need a person never auto-resume; ones that can clear on their own do", () => {
  for (const kind of ["login-required", "captcha", "account-warning", "approval-required", "stopped"] as const) {
    assert.equal(isHumanBlocker(kind), true, kind);
  }
  for (const kind of ["rate-limit", "tool-missing", "mcp", "auth", "other"] as const) {
    assert.equal(isHumanBlocker(kind), false, kind);
  }
  assert.equal(new Set(BLOCKER_KINDS).size, BLOCKER_KINDS.length);
});
