import assert from "node:assert/strict";
import test from "node:test";
import { resolveRunOutcome, type OutcomeInput } from "../src/main/automations/outcome.js";
import type { ReportedOutcome } from "../src/main/automations/run-tools.js";

const ended = (reason: "completed" | "max-steps" | "aborted" = "completed", finalText = "Done."): OutcomeInput["exec"] => ({ reason, finalText });
const reported = (patch: Partial<ReportedOutcome> = {}): ReportedOutcome => ({ outcome: "success", summary: "Posted the tweet.", ...patch });

test("a run that reports success is a success, and its report is what the history keeps", () => {
  const r = resolveRunOutcome({ exec: ended(), report: reported({ artifacts: ["https://x.com/o/status/1"] }), reportable: true });
  assert.equal(r.status, "completed");
  assert.equal(r.outcome, "success");
  assert.deepEqual(r.artifacts, ["https://x.com/o/status/1"]);
  assert.match(r.finalText ?? "", /^Posted the tweet\./);
});

test("a run that reports idle is completed, not a failure", () => {
  const r = resolveRunOutcome({ exec: ended(), report: reported({ outcome: "idle", summary: "Nothing new to post." }), reportable: true });
  assert.deepEqual([r.status, r.outcome], ["completed", "idle"]);
});

test("a blocked report is a failed run that says what blocked it — the login wall that used to read as success", () => {
  const blocker = { kind: "login-required" as const, detail: "x.com shows the login page" };
  const r = resolveRunOutcome({ exec: ended(), report: reported({ outcome: "blocked", summary: "Could not post.", blocker }), reportable: true });
  assert.equal(r.status, "failed");
  assert.equal(r.outcome, "blocked");
  assert.deepEqual(r.blocker, blocker);
  assert.equal(r.reason, "blocked: login-required");
});

test("a failed report is a failed run", () => {
  const r = resolveRunOutcome({ exec: ended(), report: reported({ outcome: "failed" }), reportable: true });
  assert.deepEqual([r.status, r.outcome, r.reason], ["failed", "failed", "reported failure"]);
});

test("a run that finishes without reporting is unreported, still completed — never a streak-breaking failure by itself", () => {
  const r = resolveRunOutcome({ exec: ended(), reportable: true });
  assert.deepEqual([r.status, r.outcome], ["completed", "unreported"]);
  assert.equal(r.finalText, "Done.");
});

test("a target that cannot be asked to report is judged by how its run ended", () => {
  assert.equal(resolveRunOutcome({ exec: ended(), reportable: false }).outcome, "success");
  assert.equal(resolveRunOutcome({ exec: ended("max-steps"), reportable: false }).outcome, "failed");
});

test("hitting the step limit without reporting is a failure", () => {
  const r = resolveRunOutcome({ exec: ended("max-steps", "partial"), reportable: true });
  assert.deepEqual([r.status, r.outcome, r.reason], ["failed", "failed", "max-steps"]);
});

test("a timeout or stall is a failed run whatever the loop returned", () => {
  for (const tripped of ["timeout", "stalled"] as const) {
    const r = resolveRunOutcome({ exec: ended("aborted", ""), tripped, reportable: true });
    assert.deepEqual([r.status, r.outcome, r.reason], ["failed", "failed", tripped]);
  }
  // Abandoned: no result at all.
  assert.equal(resolveRunOutcome({ tripped: "timeout", reportable: true }).outcome, "failed");
});

test("a user stop is aborted with no outcome, so it never counts against the automation", () => {
  const r = resolveRunOutcome({ exec: ended("aborted", ""), tripped: "stopped", reportable: true });
  assert.deepEqual([r.status, r.reason, r.outcome], ["aborted", "stopped", undefined]);
  assert.equal(resolveRunOutcome({ tripped: "stopped", stopReason: "app-quit", reportable: true }).reason, "app-quit");
});

test("a run that reported before being cut off keeps its word, and says it was cut off", () => {
  const r = resolveRunOutcome({ exec: ended("aborted", ""), report: reported(), tripped: "timeout", reportable: true });
  assert.deepEqual([r.status, r.outcome], ["completed", "success"]);
  assert.equal(r.reason, "completed (timeout after reporting)");
  // …but a user stop is still only a stop.
  assert.equal(resolveRunOutcome({ exec: ended("aborted", ""), report: reported(), tripped: "stopped", reportable: true }).outcome, undefined);
});

test("a thrown error is a failed run carrying the message", () => {
  const r = resolveRunOutcome({ error: "SSH host not found.", reportable: false });
  assert.deepEqual([r.status, r.outcome, r.reason], ["failed", "failed", "SSH host not found."]);
});

test("what the model said after reporting is kept below the report, not instead of it", () => {
  const r = resolveRunOutcome({ exec: ended("completed", "All done — see above."), report: reported(), reportable: true });
  assert.equal(r.finalText, "Posted the tweet.\n\nAll done — see above.");
  const same = resolveRunOutcome({ exec: ended("completed", "Posted the tweet."), report: reported(), reportable: true });
  assert.equal(same.finalText, "Posted the tweet.");
});
