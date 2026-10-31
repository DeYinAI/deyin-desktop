import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings, type SuperagentStatus } from "@deyin/superagent/client";
import {
  accountsText,
  admissionValue,
  blankRule,
  commandsText,
  githubPolicy,
  modelValue,
  needsPerson,
  newRuleId,
  overallState,
  parseAccounts,
  parseCommands,
  parseModelValue,
  sameEditable,
  ticketLabel,
  timeAgo,
  withAdmission,
  withGithubPolicy,
  withRule,
} from "../src/components/superagent/model.js";

const status = (patch: Partial<SuperagentStatus> = {}): SuperagentStatus => ({
  enabled: true,
  paused: false,
  mode: "observe",
  ready: true,
  gaps: [],
  repository: "acme/app",
  account: { login: "agent-bot" },
  accountError: null,
  poll: { at: null, error: null },
  orchestrator: { running: false },
  workers: { running: 0, max: 2 },
  storeError: null,
  ...patch,
});

test("the overall state says what Superagent is doing, with setup before anything else", () => {
  assert.equal(overallState(status({ ready: false, enabled: true })).label, "Needs setup");
  assert.equal(overallState(status({ enabled: false })).label, "Off");
  assert.equal(overallState(status({ paused: true })).label, "Paused");
  assert.equal(overallState(status({ mode: "off" })).label, "Mentions only");
  assert.equal(overallState(status({ mode: "observe" })).label, "Observing");
  assert.equal(overallState(status({ mode: "auto" })).label, "Active");
});

test("every ticket state has a label, and the ones a person must act on are found", () => {
  const states = ["person/review", "person/answer", "person/blocked", "person/delivery", "failed", "working", "working/queued", "idle", "completed", "merged", "closed", "dropped", "stopped"] as const;
  for (const state of states) assert.ok(ticketLabel(state).label.length > 0);
  assert.deepEqual(states.filter(needsPerson), ["person/answer", "person/blocked", "person/delivery", "failed"]);
});

test("a model reference round-trips through a select value, and the default is empty", () => {
  assert.equal(modelValue(null), "");
  assert.equal(modelValue({ providerId: "acme", model: "m:1" }), "acme::m:1");
  assert.deepEqual(parseModelValue("acme::m:1"), { providerId: "acme", model: "m:1" });
  assert.equal(parseModelValue(""), null);
  assert.equal(parseModelValue("::m"), null);
  assert.equal(parseModelValue("acme::"), null);
});

test("accounts are read from lines, tolerate @ and commas, drop duplicates, and keep known names", () => {
  const previous = [{ id: "alice", name: "Alice A." }, { id: "bob" }];
  assert.deepEqual(parseAccounts("@Alice\n bob ,carol\n\nALICE", previous), [{ id: "Alice", name: "Alice A." }, { id: "bob" }, { id: "carol" }]);
  assert.deepEqual(parseAccounts("", previous), []);
  assert.equal(accountsText(previous), "alice\nbob");
});

test("commands are split on any whitespace or comma, once each", () => {
  assert.deepEqual(parseCommands("rm  curl,\nwget rm"), ["rm", "curl", "wget"]);
  assert.deepEqual(parseCommands(""), []);
  assert.equal(commandsText(["rm", "curl"]), "rm curl");
});

test("the admission table reads defaults and edits one cell without touching the others", () => {
  const settings = defaultSettings();
  assert.equal(admissionValue(settings, "issues", "listedUnaddressed"), "inferred");
  assert.equal(admissionValue(settings, "comments", "unlistedAddressed"), "ignore");
  const edited = withAdmission(settings, "issues", "unlistedAddressed", "explicit");
  assert.equal(admissionValue(edited, "issues", "unlistedAddressed"), "explicit");
  assert.equal(admissionValue(edited, "pulls", "unlistedAddressed"), "ignore");
  assert.equal(admissionValue(edited, "issues", "listedUnaddressed"), "inferred");
  assert.equal(admissionValue(settings, "issues", "unlistedAddressed"), "ignore", "the original is unchanged");
  const again = withAdmission(edited, "issues", "listedUnaddressed", "ignore");
  assert.equal(admissionValue(again, "issues", "unlistedAddressed"), "explicit");
});

test("policy edits start from an empty source and keep what is already set", () => {
  const settings = defaultSettings();
  assert.deepEqual(githubPolicy(settings), { allowed: [], bots: [], admission: {} });
  const withAllowed = withGithubPolicy(settings, { allowed: [{ id: "alice" }] });
  const withBots = withGithubPolicy(withAllowed, { bots: [{ id: "ci[bot]" }] });
  assert.deepEqual(githubPolicy(withBots).allowed, [{ id: "alice" }]);
  assert.deepEqual(githubPolicy(withBots).bots, [{ id: "ci[bot]" }]);
});

test("rules get unique, valid ids and are edited by id", () => {
  assert.equal(newRuleId("Copy fixes!", []), "copy-fixes");
  assert.equal(newRuleId("Copy fixes", ["copy-fixes", "copy-fixes-2"]), "copy-fixes-3");
  assert.equal(newRuleId("***", []), "rule");
  assert.match(newRuleId("a".repeat(200), []), /^[a-z0-9-]{1,80}$/);
  const settings = defaultSettings();
  const rule = blankRule(settings.policy.rules.map((item) => item.id));
  assert.ok(!settings.policy.rules.some((item) => item.id === rule.id));
  const edited = withRule(settings, "copy", { enabled: false });
  assert.equal(edited.policy.rules.find((item) => item.id === "copy")?.enabled, false);
  assert.equal(edited.policy.rules.find((item) => item.id === "visual")?.enabled, true);
});

test("the on and pause switches are not edits of the form", () => {
  const settings = defaultSettings();
  assert.equal(sameEditable(settings, { ...settings, enabled: true, paused: true }), true);
  assert.equal(sameEditable(settings, { ...settings, github: { ...settings.github, repository: "acme/app" } }), false);
});

test("relative times read naturally", () => {
  const now = Date.parse("2026-01-02T12:00:00Z");
  assert.equal(timeAgo(null, now), "never");
  assert.equal(timeAgo("2026-01-02T11:59:50Z", now), "just now");
  assert.equal(timeAgo("2026-01-02T11:30:00Z", now), "30 min ago");
  assert.equal(timeAgo("2026-01-02T09:00:00Z", now), "3 h ago");
  assert.equal(timeAgo("2025-12-30T12:00:00Z", now), "3 d ago");
  assert.equal(timeAgo("nonsense", now), "unknown");
});
