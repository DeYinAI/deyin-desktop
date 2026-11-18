import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultSchedule,
  onceTimestamp,
  scheduleIssue,
  scheduleToTrigger,
  triggerToSchedule,
  type ScheduleDraft,
} from "../src/automationSchedule.js";

const NOW = new Date(2026, 10, 18, 20, 42, 0);

const draft = (patch: Partial<ScheduleDraft>): ScheduleDraft => ({ ...defaultSchedule(NOW), time: "09:30", ...patch });

test("defaultSchedule: every day, rounded up to the next five minutes", () => {
  const d = defaultSchedule(NOW);
  assert.equal(d.repeat, "daily");
  assert.equal(d.time, "20:50");
  assert.equal(d.date, "2026-11-18");
});

test("scheduleToTrigger: cron presets", () => {
  const cron = (patch: Partial<ScheduleDraft>) => scheduleToTrigger(draft(patch));
  assert.deepEqual(cron({ repeat: "daily" }), { kind: "cron", expression: "30 9 * * *" });
  assert.deepEqual(cron({ repeat: "daily", interval: "3" }), { kind: "cron", expression: "30 9 */3 * *" });
  assert.deepEqual(cron({ repeat: "weekdays" }), { kind: "cron", expression: "30 9 * * 1-5" });
  assert.deepEqual(cron({ repeat: "weekly", weekdays: [5, 1] }), { kind: "cron", expression: "30 9 * * 1,5" });
  assert.deepEqual(cron({ repeat: "hourly", interval: "2" }), { kind: "cron", expression: "30 */2 * * *" });
  assert.deepEqual(cron({ repeat: "hourly" }), { kind: "cron", expression: "30 * * * *" });
  assert.deepEqual(cron({ repeat: "minutely", interval: "15" }), { kind: "cron", expression: "*/15 * * * *" });
  assert.deepEqual(cron({ repeat: "minutely" }), { kind: "cron", expression: "* * * * *" });
  assert.deepEqual(cron({ repeat: "monthly", monthDay: 31 }), { kind: "cron", expression: "30 9 31 * *" });
  assert.deepEqual(cron({ repeat: "custom", cron: " 5 4 * * 0 " }), { kind: "cron", expression: "5 4 * * 0" });
  assert.deepEqual(cron({ repeat: "manual" }), { kind: "manual" });
});

test("scheduleToTrigger: once is a local timestamp", () => {
  const trigger = scheduleToTrigger(draft({ repeat: "once", date: "2026-12-01", time: "07:15" }));
  assert.deepEqual(trigger, { kind: "once", at: new Date(2026, 11, 1, 7, 15).getTime() });
});

test("triggerToSchedule inverts every preset the editor writes", () => {
  const kinds: Array<Partial<ScheduleDraft>> = [
    { repeat: "daily" },
    { repeat: "daily", interval: "4" },
    { repeat: "weekdays" },
    { repeat: "weekly", weekdays: [0, 3, 6] },
    { repeat: "hourly" },
    { repeat: "hourly", interval: "6" },
    { repeat: "minutely" },
    { repeat: "minutely", interval: "10" },
    { repeat: "monthly", monthDay: 12 },
    { repeat: "once", date: "2026-12-24", time: "18:00" },
    { repeat: "manual" },
  ];
  for (const patch of kinds) {
    const original = draft(patch);
    const back = triggerToSchedule(scheduleToTrigger(original), NOW);
    assert.equal(back.repeat, original.repeat, JSON.stringify(patch));
    assert.deepEqual(scheduleToTrigger(back), scheduleToTrigger(original), JSON.stringify(patch));
  }
});

test("triggerToSchedule reads the old built-in presets and falls back to custom", () => {
  assert.equal(triggerToSchedule({ kind: "cron", expression: "0 * * * *" }, NOW).repeat, "hourly");
  assert.equal(triggerToSchedule({ kind: "cron", expression: "0 9 * * *" }, NOW).repeat, "daily");
  assert.equal(triggerToSchedule({ kind: "cron", expression: "0 9 * * 1-5" }, NOW).repeat, "weekdays");
  const odd = triggerToSchedule({ kind: "cron", expression: "0 9 1 1,7 *" }, NOW);
  assert.equal(odd.repeat, "custom");
  assert.equal(odd.cron, "0 9 1 1,7 *");
});

test("scheduleIssue flags what the host would reject", () => {
  const now = NOW.getTime();
  assert.equal(scheduleIssue(draft({}), now), undefined);
  assert.equal(scheduleIssue(draft({ repeat: "daily", interval: "0" }), now), "interval");
  assert.equal(scheduleIssue(draft({ repeat: "hourly", interval: "" }), now), "interval");
  assert.equal(scheduleIssue(draft({ repeat: "weekly", weekdays: [] }), now), "weekday");
  assert.equal(scheduleIssue(draft({ repeat: "monthly", monthDay: 32 }), now), "monthDay");
  assert.equal(scheduleIssue(draft({ repeat: "daily", time: "25:00" }), now), "time");
  assert.equal(scheduleIssue(draft({ repeat: "once", date: "", time: "09:00" }), now), "date");
  assert.equal(scheduleIssue(draft({ repeat: "once", date: "2026-11-18", time: "20:00" }), now), "past");
  assert.equal(scheduleIssue(draft({ repeat: "once", date: "2026-11-18", time: "21:00" }), now), undefined);
  assert.equal(scheduleIssue(draft({ repeat: "custom", cron: "* * *" }), now), "cron");
  assert.equal(scheduleIssue(draft({ repeat: "manual", time: "bad" }), now), undefined);
});

test("onceTimestamp is NaN until the date is complete", () => {
  assert.ok(Number.isNaN(onceTimestamp({ date: "", time: "10:00" })));
  assert.equal(onceTimestamp({ date: "2026-01-02", time: "03:04" }), new Date(2026, 0, 2, 3, 4).getTime());
});
