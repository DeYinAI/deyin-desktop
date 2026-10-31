import assert from "node:assert/strict";
import { test } from "node:test";
import type { Thread, Ticket } from "../src/core/types.js";
import { policyEffects, policyVersion, settingsPolicy } from "../src/policy.js";
import { makeSettings, request, scopeOf, trigger } from "./helpers.js";

const thread = (patch: Partial<Thread> = {}): Thread => ({
  key: "github:1", ref: { source: "github", id: "1" }, createdAt: "2026-01-01T00:00:00.000Z", subscriptions: [], pending: [], meta: {}, ...patch,
});
const policyOf = (settings = makeSettings()) => settingsPolicy(settings, scopeOf(settings));

test("an allowed sender who mentions the agent is an explicit request", () => {
  const result = policyOf().gate(request(), thread(), []);
  assert.equal(result.admissible, true);
  if (result.admissible) {
    assert.equal(result.strength, "explicit");
    assert.equal(result.basis.via, "addressed");
  }
});

test("a sender who is not allowed is rejected even when addressing the agent", () => {
  const result = policyOf().gate(request({ actor: { source: "github", id: "mallory" } }), thread(), []);
  assert.deepEqual(result, { admissible: false, reason: "not_a_member" });
});

test("an unaddressed message is ignored unless the source observes the whole scope", () => {
  const quiet = policyOf().gate(trigger(), thread(), []);
  assert.equal(quiet.admissible, false);
  const observing = makeSettings({ github: { observeComments: true } });
  const result = policyOf(observing).gate(trigger(), thread(), []);
  assert.equal(result.admissible, true);
  if (result.admissible) assert.equal(result.strength, "inferred");
});

test("observed inferred candidates need accept mode other than off", () => {
  const settings = makeSettings({ github: { observeComments: true }, eval: { mode: "off" } });
  assert.equal(policyOf(settings).gate(trigger(), thread(), []).admissible, false);
  assert.equal(policyOf(settings).gate(request(), thread(), []).admissible, true);
});

test("a follow-up from an allowed sender on a thread with a ticket is explicit", () => {
  const ticket = { id: "t1" } as Ticket;
  const result = policyOf().gate(trigger(), thread({ subscriptions: ["t1"] }), [ticket]);
  assert.equal(result.admissible, true);
  if (result.admissible) {
    assert.equal(result.strength, "explicit");
    assert.equal(result.basis.via, "followup");
  }
});

test("a context-only subscription is not participation", () => {
  const ticket = { id: "t1" } as Ticket;
  const result = policyOf().gate(trigger(), thread({ subscriptions: ["t1"], context: ["t1"] }), [ticket]);
  assert.equal(result.admissible, false);
});

test("machine messages: only listed bots and senderless events pass, as inferred", () => {
  const settings = makeSettings({ github: { observeComments: true } });
  const policy = policyOf(settings);
  const stranger = trigger({ human: false, actor: { source: "github", id: "random[bot]" } });
  assert.deepEqual(policy.gate(stranger, thread(), []), { admissible: false, reason: "not_human" });
  const listed = trigger({ human: false, actor: { source: "github", id: "review-bot[bot]" } });
  const result = policy.gate(listed, thread(), []);
  assert.equal(result.admissible, true);
  if (result.admissible) {
    assert.equal(result.strength, "inferred");
    assert.equal(result.basis.via, "bot");
  }
  const senderless = trigger({ human: false, actor: { source: "github", id: "" } });
  assert.equal(policy.gate(senderless, thread(), []).admissible, false, "unlisted unaddressed defaults to ignore");
});

test("admitsInferred requires auto mode and enabled matched rules", () => {
  assert.equal(policyOf(makeSettings({ eval: { mode: "observe" } })).admitsInferred(["copy"]), false);
  const auto = policyOf(makeSettings({ eval: { mode: "auto" } }));
  assert.equal(auto.admitsInferred(["copy"]), true);
  assert.equal(auto.admitsInferred([]), false);
  assert.equal(auto.admitsInferred(["missing"]), false);
});

test("policy version ignores models, concurrency and pausing but follows rules, mode and lists", () => {
  const base = makeSettings();
  assert.equal(policyVersion(base), policyVersion(makeSettings({ paused: true, executor: { maxWorkers: 5 } })));
  assert.notEqual(policyVersion(base), policyVersion(makeSettings({ eval: { mode: "auto" } })));
  assert.notEqual(policyVersion(base), policyVersion(makeSettings({ policy: { sources: { github: { allowed: [{ id: "alice" }] } } } })));
});

test("revalidate: explicit holds while the sender stays allowed; inferred needs auto and its rules", () => {
  const settings = makeSettings({ eval: { mode: "auto" }, github: { observeComments: true } });
  const policy = policyOf(settings);
  const inferred = policy.gate(trigger(), thread(), []);
  assert.ok(inferred.admissible);
  const mandate = { strength: inferred.strength, policyVersion: policy.version, basis: { ...inferred.basis, rules: ["copy"] }, actor: { source: "github", id: "alice" }, scope: "x" };
  assert.equal(policy.revalidate(mandate), true);
  assert.equal(policyOf(makeSettings({ eval: { mode: "observe" }, github: { observeComments: true } })).revalidate(mandate), false);
  const explicit = policy.gate(request(), thread(), []);
  assert.ok(explicit.admissible);
  const emandate = { ...mandate, strength: explicit.strength, basis: explicit.basis };
  assert.equal(policy.revalidate(emandate), true);
  const removed = makeSettings({ policy: { sources: { github: { allowed: [{ id: "bob" }] } } } });
  assert.equal(policyOf(removed).revalidate(emandate), false);
});

test("policyEffects reports a removed requester and a disabled rule", () => {
  const before = makeSettings({ eval: { mode: "auto" } });
  const policy = settingsPolicy(before, scopeOf(before));
  const gated = policy.gate(request(), thread(), []);
  assert.ok(gated.admissible);
  const ticket = { id: "t1", mandate: { strength: gated.strength, policyVersion: policy.version, basis: { ...gated.basis, rules: ["copy"] }, actor: { source: "github", id: "alice" }, scope: "" } } as Ticket;
  const after = makeSettings({
    eval: { mode: "auto" },
    policy: { sources: { github: { allowed: [{ id: "bob" }] } }, rules: [{ id: "copy", name: "Copy fixes", enabled: false, instruction: "x" }] },
  });
  const effects = policyEffects([ticket], before, after, scopeOf);
  const effect = effects.get("t1");
  assert.equal(effect?.requesterAllowed, false);
  assert.equal(effect?.rules?.[0]?.change, "disabled");
});
