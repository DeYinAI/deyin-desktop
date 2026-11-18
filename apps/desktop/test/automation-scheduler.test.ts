import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationsStore, FileStorage, automationStatus, plainCipher, type Automation } from "@deyin/host-core";
import {
  AutomationScheduler,
  nextRunAt,
  previousOccurrence,
  validateCronExpression,
} from "../src/main/automations/scheduler.js";

function store(): AutomationsStore {
  return new AutomationsStore(new FileStorage(mkdtempSync(join(tmpdir(), "deyin-sched-")), plainCipher));
}

const DAILY_9AM = "0 9 * * *";

/** Pretend the automation was last touched `days` ago, so its recent slots count as missed. */
function age(s: AutomationsStore, id: string, days: number): void {
  s.get(id)!.updatedAt = Date.now() - days * 86_400_000;
}


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
  age(s, automation.id, 2);
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
  age(s, automation.id, 2);
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
  const automation = create(s);
  age(s, automation.id, 2);
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
  age(s, good.id, 2);

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

test("a freshly created automation does not run for slots from before it existed", () => {
  const s = store();
  create(s, { trigger: { kind: "cron", expression: "* * * * *" } });
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

test("resuming a paused automation does not replay the slots missed while paused", () => {
  const s = store();
  const automation = create(s, { enabled: false });
  age(s, automation.id, 3);
  s.setEnabled(automation.id, true);
  const fired: string[] = [];
  const scheduler = new AutomationScheduler(s, {
    onTrigger: (id) => fired.push(id),
    isCatchUpEnabled: () => true,
  });
  scheduler.refresh();
  scheduler.dispose();
  assert.deepEqual(fired, []);
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

/* one-shot ("once") automations -------------------------------------------- */

test("a one-shot that came due while closed catches up once, then ends", () => {
  const s = store();
  const at = Date.now() - 60 * 60_000;
  const automation = create(s, { trigger: { kind: "once", at } });
  const fired: Array<[string, number]> = [];
  const scheduler = new AutomationScheduler(s, {
    onTrigger: (id, scheduledAt) => fired.push([id, scheduledAt]),
    isCatchUpEnabled: () => true,
  });
  scheduler.refresh();
  assert.deepEqual(fired, [[automation.id, at]]);

  // The runner claims the slot when it starts; after that the one-shot is ended.
  s.setLastScheduledAt(automation.id, at);
  assert.equal(automationStatus(s.get(automation.id)!), "ended");
  fired.length = 0;
  scheduler.refresh();
  scheduler.handleResume();
  scheduler.dispose();
  assert.deepEqual(fired, []);
});

test("a one-shot older than the catch-up window is dropped", () => {
  const s = store();
  create(s, { trigger: { kind: "once", at: Date.now() - 8 * 86_400_000 } });
  const fired: string[] = [];
  const scheduler = new AutomationScheduler(s, {
    onTrigger: (id) => fired.push(id),
    isCatchUpEnabled: () => true,
  });
  scheduler.refresh();
  scheduler.dispose();
  assert.deepEqual(fired, []);
});

test("a future one-shot is armed but does not fire immediately", () => {
  const s = store();
  create(s, { trigger: { kind: "once", at: Date.now() + 3_600_000 } });
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

test("nextRunAt: cron, once, paused, ended and manual", () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  const base = {
    id: "a", name: "A", enabled: true, payload: { kind: "prompt", prompt: "x" },
    target: { kind: "local", workspacePath: "/tmp" }, model: "m", providerId: "p", createdAt: 0, updatedAt: 0,
  } as const;
  const hourly = { ...base, trigger: { kind: "cron", expression: "0 * * * *" } } as Automation;
  assert.equal(nextRunAt(hourly, now), now + 3_600_000);
  assert.equal(nextRunAt({ ...hourly, enabled: false }, now), undefined);

  const once = { ...base, trigger: { kind: "once", at: now + 5_000 } } as Automation;
  assert.equal(nextRunAt(once, now), now + 5_000);
  assert.equal(nextRunAt({ ...once, lastScheduledAt: now + 5_000 }, now), undefined);
  assert.equal(nextRunAt({ ...once, trigger: { kind: "once", at: now - 1 } }, now), undefined);
  assert.equal(nextRunAt({ ...base, trigger: { kind: "manual" } } as Automation, now), undefined);
});

test("automationStatus: active, paused, ended", () => {
  const trigger = { kind: "once", at: 1 } as const;
  assert.equal(automationStatus({ enabled: true, trigger: { kind: "manual" } }), "active");
  assert.equal(automationStatus({ enabled: false, trigger: { kind: "manual" } }), "paused");
  assert.equal(automationStatus({ enabled: true, trigger, lastScheduledAt: 1 }), "ended");
  assert.equal(automationStatus({ enabled: true, trigger }), "active");
});
