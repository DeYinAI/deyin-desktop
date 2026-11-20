import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings, type SuperagentStatus } from "@deyin/superagent/client";
import {
  accountsText,
  admissionOptions,
  admissionValue,
  blankRule,
  changedAdvancedCells,
  changedPolicyCells,
  commandsText,
  githubPolicy,
  HEADLINE_CELL,
  modelOptions,
  modelValue,
  needsPerson,
  newRuleId,
  overallState,
  parseAccounts,
  parseCommands,
  parseModelValue,
  runStateOf,
  runStateOptions,
  sameEditable,
  ticketLabel,
  timeAgo,
  withAdmission,
  withGithubPolicy,
  withRule,
  withRunState,
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

test("the header's one control maps to the two switches and back", () => {
  const settings = defaultSettings();
  assert.equal(runStateOf({ enabled: false, paused: false }), "off");
  assert.equal(runStateOf({ enabled: true, paused: false }), "on");
  assert.equal(runStateOf({ enabled: true, paused: true }), "paused");
  // A stored pause under a disabled Superagent reads as Off, not Paused.
  assert.equal(runStateOf({ enabled: false, paused: true }), "off");

  for (const state of ["on", "paused", "off"] as const) {
    assert.equal(runStateOf(withRunState(settings, state)), state, `round trip: ${state}`);
  }
  // Pausing needs it enabled; switching it on or off leaves no stale pause behind.
  assert.deepEqual(pick(withRunState({ ...settings, enabled: false, paused: false }, "paused")), { enabled: true, paused: true });
  assert.deepEqual(pick(withRunState({ ...settings, enabled: true, paused: true }, "on")), { enabled: true, paused: false });
  assert.deepEqual(pick(withRunState({ ...settings, enabled: true, paused: true }, "off")), { enabled: false, paused: false });
  // Nothing but the two switches changes, so the form is not made dirty by the header.
  assert.equal(sameEditable(settings, withRunState(settings, "paused")), true);
});

const pick = (s: { enabled: boolean; paused: boolean }) => ({ enabled: s.enabled, paused: s.paused });

test("the headline admission cell is the one that offers all three choices", () => {
  assert.equal(HEADLINE_CELL, "unlistedAddressed");
  assert.equal(admissionValue(defaultSettings(), "issues", HEADLINE_CELL), "ignore", "strangers who mention the agent are ignored by default");
});

test("cells that only Advanced policy shows are counted when they leave their default", () => {
  const settings = defaultSettings();
  assert.deepEqual(changedAdvancedCells(settings), [], "a default policy has nothing hidden");

  // The headline cell is on the page itself, so changing it is not 'hidden'.
  const headline = withAdmission(settings, "issues", HEADLINE_CELL, "explicit");
  assert.deepEqual(changedAdvancedCells(headline), []);

  // Strangers' unaddressed messages let through is hidden state and must be reported, with where it is.
  const hidden = withAdmission(settings, "comments", "unlistedUnaddressed", "inferred");
  assert.deepEqual(changedAdvancedCells(hidden), [{ row: "comments", cell: "unlistedUnaddressed" }]);

  // Ignoring allowed accounts' unaddressed messages is also a change from the default (inferred).
  const quieter = withAdmission(hidden, "pulls", "listedUnaddressed", "ignore");
  assert.equal(changedAdvancedCells(quieter).length, 2);

  // Setting a cell back to its default stops counting it.
  assert.deepEqual(changedAdvancedCells(withAdmission(hidden, "comments", "unlistedUnaddressed", "ignore")), []);
});

test("the collapsed Advanced section opens for any policy change, the headline cell included", () => {
  const settings = defaultSettings();
  assert.deepEqual(changedPolicyCells(settings), [], "a default policy hides nothing, so Advanced can stay closed");

  // Letting strangers who mention the agent start work is the most consequential cell: it must never sit behind a closed section.
  const headline = withAdmission(settings, "issues", HEADLINE_CELL, "explicit");
  assert.deepEqual(changedPolicyCells(headline), [{ row: "issues", cell: HEADLINE_CELL }]);
  assert.deepEqual(changedAdvancedCells(headline), [], "while the table's own count still leaves it out");

  const both = withAdmission(headline, "comments", "unlistedUnaddressed", "inferred");
  assert.deepEqual(changedPolicyCells(both), [
    { row: "issues", cell: HEADLINE_CELL },
    { row: "comments", cell: "unlistedUnaddressed" },
  ]);
  assert.deepEqual(changedAdvancedCells(both), [{ row: "comments", cell: "unlistedUnaddressed" }]);

  // Back to the defaults, nothing is left to show.
  assert.deepEqual(changedPolicyCells(withAdmission(headline, "issues", HEADLINE_CELL, "ignore")), []);
});

test("the model menu offers the app's default and the provider's chat models only", () => {
  const models = [{ id: "chat-a", name: "A" }, { id: "draw", name: "D", kind: "image" as const }, { id: "film", name: "F", kind: "video" as const }];
  const options = modelOptions(models, "acme", null);
  assert.deepEqual(options.map((o) => o.id), ["", "acme::chat-a"], "image and video models cannot answer messages");
  assert.equal(options[0]!.label, "The app's default model");
  assert.equal(options[1]!.label, "chat-a");
});

test("a stored model the provider no longer offers stays listed, so opening the page does not change it", () => {
  const options = modelOptions([{ id: "chat-a", name: "A" }], "acme", { providerId: "old", model: "retired" });
  assert.deepEqual(options.map((o) => o.id), ["", "old::retired", "acme::chat-a"]);
  assert.equal(options[1]!.label, "old · retired");
  // Nothing extra when the stored model is among the provider's.
  assert.equal(modelOptions([{ id: "chat-a", name: "A" }], "acme", { providerId: "acme", model: "chat-a" }).length, 2);
});

test("each admission cell offers the choices it allows, in plain words", () => {
  for (const cell of ["listedUnaddressed", "unlistedAddressed", "unlistedUnaddressed"] as const) {
    const options = admissionOptions(cell);
    assert.ok(options.length >= 2, `${cell} has a real choice`);
    assert.ok(options.every((o) => o.label !== o.id), `${cell}: no raw value is shown to a person`);
  }
  assert.deepEqual(admissionOptions(HEADLINE_CELL).map((o) => o.label), ["Treat as a request", "Let the agent decide", "Ignore"]);
});

test("until setup is done only Off can be chosen, and the others say why", () => {
  const blocked = runStateOptions(false);
  assert.deepEqual(blocked.map((o) => [o.id, o.label, o.disabled === true]), [["on", "On", true], ["paused", "Paused", true], ["off", "Off", false]]);
  assert.ok(blocked.filter((o) => o.disabled).every((o) => o.hint === "Finish setup first"));
  const ready = runStateOptions(true);
  assert.ok(ready.every((o) => !o.disabled && o.hint === undefined), "nothing is held back once Superagent can run");
});
