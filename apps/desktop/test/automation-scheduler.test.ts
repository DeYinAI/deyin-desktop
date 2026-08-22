import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationsStore, FileStorage, plainCipher, type Automation } from "@deyin/host-core";
import { AutomationScheduler, previousOccurrence, validateCronExpression } from "../src/main/automations/scheduler.js";

function store(): AutomationsStore {
  return new AutomationsStore(new FileStorage(mkdtempSync(join(tmpdir(), "deyin-sched-")), plainCipher));
}

const DAILY_9AM = "0 9 * * *";


function create(s: AutomationsStore, patch: Partial<Automation> = {}): Automation {
  return s.create({
    name: "Nightly",
    enabled: true,
    payload: { kind: "prompt", prompt: "go" },
    trigger: { kind: "cron", expression: DAILY_9AM },
    target: { kind: "local", workspacePath: "/tmp/proj" },
    model: "GLM-5.2",
    providerId: "openference",
    ...patch,
  } as Omit<Automation, "id" | "createdAt" | "updatedAt">);
}

test("validateCronExpression accepts five-field cron and rejects junk", () => {
  assert.equal(validateCronExpression(DAILY_9AM), null);
  assert.equal(validateCronExpression("0 * * * *"), null);
  assert.equal(validateCronExpression("0 9 * * 1-5"), null);
  assert.notEqual(validateCronExpression(""), null);
  assert.notEqual(validateCronExpression("not a cron"), null);
  assert.notEqual(validateCronExpression("99 99 * * *"), null);
});

test("a never-run automation catches up exactly once", () => {
  const s = store();
  const automation = create(s);
  const fired: string[] = [];

  const scheduler = new AutomationScheduler(s, {
    onTrigger: (id) => fired.push(id),
    isCatchUpEnabled: () => true,
  });
  scheduler.refresh();
  // handleResume re-evaluates the same predicate; a second pass must not
  // double-fire for a slot already claimed.
  s.setLastScheduledAt(automation.id, Date.now());
  scheduler.handleResume();
  scheduler.dispose();

  assert.equal(fired.length, 1);
  assert.equal(fired[0], automation.id);
});

test("an automation that already ran its last slot does not catch up", () => {
  const s = store();
  const automation = create(s);
  // Claim the slot before the scheduler ever looks.
  s.setLastScheduledAt(automation.id, Date.now());

  const fired: string[] = [];
  const scheduler = new AutomationScheduler(s, {
    onTrigger: (id) => fired.push(id),
    isCatchUpEnabled: () => true,
  });
  scheduler.refresh();
  scheduler.dispose();

  assert.deepEqual(fired, []);
});

test("catch-up is skipped when the setting is off", () => {
  const s = store();
  create(s);
  const fired: string[] = [];
  const scheduler = new AutomationScheduler(s, {
    onTrigger: (id) => fired.push(id),
    isCatchUpEnabled: () => false,
  });
  scheduler.refresh();
  scheduler.handleResume();
  scheduler.dispose();

  assert.deepEqual(fired, []);
});

test("disabled and manual automations are never scheduled", () => {
  const s = store();
  create(s, { enabled: false });
  create(s, { trigger: { kind: "manual" }, name: "Manual" });

  const fired: string[] = [];
  const scheduler = new AutomationScheduler(s, {
    onTrigger: (id) => fired.push(id),
    isCatchUpEnabled: () => true,
  });
  scheduler.refresh();
  scheduler.handleResume();
  scheduler.dispose();

  assert.deepEqual(fired, []);
});

test("an invalid cron expression is skipped instead of crashing the scheduler", () => {
  const s = store();
  create(s, { trigger: { kind: "cron", expression: "totally invalid" } });
  const good = create(s, { name: "Good" });

  const fired: string[] = [];
  const scheduler = new AutomationScheduler(s, {
    onTrigger: (id) => fired.push(id),
    isCatchUpEnabled: () => true,
  });
  // Must not throw: one bad row cannot take the whole scheduler down.
  scheduler.refresh();
  scheduler.dispose();

  assert.deepEqual(fired, [good.id]);
});

test("a slot missed by more than the catch-up window is discarded", () => {
  const s = store();
  const automation = create(s);
  // Pretend the last claim was long ago AND the previous slot is ancient by
  // using a cron that only fires yearly, far outside the 7-day window.
  s.update(automation.id, { trigger: { kind: "cron", expression: "0 9 1 1 *" } });

  const fired: string[] = [];
  const scheduler = new AutomationScheduler(s, {
    onTrigger: (id) => fired.push(id),
    isCatchUpEnabled: () => true,
  });
  scheduler.refresh();
  scheduler.dispose();

  // Jan 1 is more than seven days ago for all but the first week of the year.
  const daysSinceJan1 = (Date.now() - new Date(new Date().getFullYear(), 0, 1, 9).getTime()) / 86_400_000;
  if (daysSinceJan1 > 7) assert.deepEqual(fired, []);
});

/* previousOccurrence ------------------------------------------------------- */

test("previousOccurrence finds the last slot in the window", () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  const weekAgo = now - 7 * 86_400_000;
  // Hourly: the most recent slot at or before noon is noon itself.
  const hourly = previousOccurrence("0 * * * *", weekAgo, now);
  assert.equal(hourly, now);
});

test("previousOccurrence returns null when nothing is due in the span", () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  // A slot one minute from now has not happened yet.
  assert.equal(previousOccurrence("0 * * * *", now, now + 60_000), null);
});

test("previousOccurrence ignores slots at or before the lower bound", () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  // Bound set to noon: the noon slot is already claimed, nothing newer exists.
  assert.equal(previousOccurrence("0 * * * *", now, now), null);
});

test("previousOccurrence survives a malformed expression", () => {
  assert.equal(previousOccurrence("not a cron", 0, Date.now()), null);
});
