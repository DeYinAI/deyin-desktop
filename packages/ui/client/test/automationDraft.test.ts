import assert from "node:assert/strict";
import test from "node:test";
import { translate } from "@deyin/host-core/shared";
import type { Automation } from "@deyin/contract";
import {
  draftChanged,
  draftFromAutomation,
  draftIssues,
  draftToAutomationInput,
  emptyDraft,
} from "../src/automationDraft.js";
import { describeSchedule, describeTimeZone, formatNextRun, formatRelative } from "../src/automationFormat.js";

const NOW = new Date(2026, 10, 18, 20, 42, 0);
const t = (key: Parameters<typeof translate>[1]) => translate("en", key);

const filled = () => ({
  ...emptyDraft("/work/app", "deepseek-v4", "openference", NOW),
  name: "Digest",
  prompt: "Summarize my reading list",
});

test("draftIssues: a fresh draft needs a name and an instruction", () => {
  const issues = draftIssues(emptyDraft("/work/app", "m", "p", NOW), NOW.getTime());
  assert.equal(issues.name, "automations.issue.incomplete");
  assert.equal(issues.prompt, "automations.err.prompt");
  assert.equal(issues.workspacePath, undefined);
  assert.equal(issues.schedule, undefined);
});

test("draftIssues: a complete draft has none", () => {
  assert.deepEqual(draftIssues(filled(), NOW.getTime()), {});
});

test("draftIssues: skill payload needs a skill, not a prompt", () => {
  const issues = draftIssues({ ...filled(), payloadKind: "skill", prompt: "" }, NOW.getTime());
  assert.equal(issues.skill, "automations.err.skill");
  assert.equal(issues.prompt, undefined);
});

test("draftIssues: remote targets need their host or distro", () => {
  assert.equal(draftIssues({ ...filled(), targetKind: "ssh" }, NOW.getTime()).hostId, "automations.err.host");
  assert.equal(draftIssues({ ...filled(), targetKind: "wsl" }, NOW.getTime()).distro, "automations.err.distro");
});

test("draftIssues: a once-schedule in the past is rejected", () => {
  const draft = filled();
  draft.schedule = { ...draft.schedule, repeat: "once", date: "2026-01-01", time: "09:00" };
  assert.equal(draftIssues(draft, NOW.getTime()).schedule, "automations.issue.past");
});

test("draftToAutomationInput: trims, builds the trigger and pins remote runs to Openference", () => {
  const draft = { ...filled(), name: "  Digest  ", providerId: "custom", targetKind: "wsl" as const, distro: "Ubuntu" };
  const input = draftToAutomationInput(draft);
  assert.equal(input.name, "Digest");
  assert.deepEqual(input.trigger, { kind: "cron", expression: "50 20 * * *" });
  assert.deepEqual(input.target, { kind: "wsl", distro: "Ubuntu", workspacePath: "/work/app" });
  assert.equal(input.providerId, "openference");
  assert.equal(draftToAutomationInput(filled()).providerId, "openference");
  assert.equal(draftToAutomationInput({ ...filled(), providerId: "custom" }).providerId, "custom");
});

test("draftFromAutomation round-trips through draftToAutomationInput", () => {
  const stored: Automation = {
    id: "a1",
    name: "Nightly",
    description: "check deps",
    enabled: false,
    payload: { kind: "skill", skill: "review", input: "src/" },
    trigger: { kind: "cron", expression: "30 9 * * 1-5" },
    target: { kind: "ssh", hostId: "h1", workspacePath: "/srv/app" },
    model: "m",
    providerId: "openference",
    createdAt: 1,
    updatedAt: 2,
  };
  const draft = draftFromAutomation(stored, NOW);
  assert.equal(draft.schedule.repeat, "weekdays");
  assert.equal(draft.schedule.time, "09:30");
  const input = draftToAutomationInput(draft);
  assert.deepEqual(input.payload, stored.payload);
  assert.deepEqual(input.trigger, stored.trigger);
  assert.deepEqual(input.target, stored.target);
  assert.equal(input.enabled, false);
  assert.equal(input.description, "check deps");
});

test("draftChanged ignores the schedule's unused fields but sees real edits", () => {
  const base = filled();
  assert.equal(draftChanged({ ...base, schedule: { ...base.schedule, cron: "* * * * *" } }, base), false);
  assert.equal(draftChanged({ ...base, prompt: "Different" }, base), true);
  assert.equal(draftChanged({ ...base, schedule: { ...base.schedule, time: "07:00" } }, base), true);
});

test("describeSchedule words every repeat kind", () => {
  const d = (expression: string) => describeSchedule({ kind: "cron", expression }, t, "en");
  assert.equal(d("30 9 * * *"), "Every day at 09:30");
  assert.equal(d("30 9 */3 * *"), "Every 3 days at 09:30");
  assert.equal(d("30 9 * * 1-5"), "Monday to Friday at 09:30");
  assert.equal(d("30 9 * * 1,3"), "Weekly on Mon, Wed at 09:30");
  assert.equal(d("15 * * * *"), "Every hour at :15");
  assert.equal(d("15 */2 * * *"), "Every 2 hours at :15");
  assert.equal(d("* * * * *"), "Every minute");
  assert.equal(d("*/10 * * * *"), "Every 10 minutes");
  assert.equal(d("0 8 5 * *"), "Monthly on day 5 at 08:00");
  assert.equal(d("0 8 1 1 *"), "0 8 1 1 *");
  assert.equal(describeSchedule({ kind: "manual" }, t, "en"), "Manual only");
  assert.match(describeSchedule({ kind: "once", at: new Date(2026, 11, 24, 18, 0).getTime() }, t, "en"), /^Once on .*Dec 24, 2026/);
});

test("formatRelative / formatNextRun pick the largest fitting unit", () => {
  const now = NOW.getTime();
  assert.equal(formatRelative(now + 3 * 3_600_000, now, "en"), "in 3 hours");
  assert.equal(formatRelative(now + 20 * 60_000, now, "en"), "in 20 minutes");
  assert.equal(formatRelative(now + 2 * 86_400_000, now, "en"), "in 2 days");
  assert.match(formatNextRun(now + 3 * 3_600_000, now, "en"), /^Wed, Nov 18, .*\(in 3 hours\)$/);
});

test("describeTimeZone leads with the signed UTC offset and ends with the zone name", () => {
  const label = describeTimeZone(NOW);
  assert.match(label, /^UTC[+-]\d{2}:\d{2} · \S+$/);
  const [offset] = label.split(" · ");
  const minutes = -NOW.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  assert.equal(offset, `UTC${sign}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`);
});
