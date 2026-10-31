import assert from "node:assert/strict";
import { test } from "node:test";
import { UserError } from "../src/core/errors.js";
import * as s from "../src/schema.js";
import { defaultSettings, parseSettings, setupGaps } from "../src/settings.js";

test("schema.object refuses unknown keys and reports the path", () => {
  const schema = s.object({ a: s.string({ min: 1 }), n: s.optional(s.number({ int: true })) });
  assert.deepEqual(schema.parse({ a: "x" }), { a: "x" });
  assert.throws(() => schema.parse({ a: "x", b: 1 }), (error: unknown) => error instanceof UserError && /b: unknown property/.test(error.message));
  assert.throws(() => schema.parse({ a: "" }), /a: must not be empty/);
  assert.throws(() => schema.parse({ a: "x", n: 1.5 }), /n: expected an integer/);
});

test("schema.object emits JSON Schema with required derived from optional", () => {
  const json = s.object({ a: s.string(), b: s.nullish(s.string()) }).json as { required: string[]; additionalProperties: boolean };
  assert.deepEqual(json.required, ["a"]);
  assert.equal(json.additionalProperties, false);
});

test("schema.enumeration and arrays validate members", () => {
  const schema = s.array(s.enumeration(["x", "y"] as const), { max: 2 });
  assert.deepEqual(schema.parse(["x"]), ["x"]);
  assert.throws(() => schema.parse(["z"]), /\[0\]: expected one of x, y/);
  assert.throws(() => schema.parse(["x", "y", "x"]), /at most 2 items/);
});

test("default settings are safe: off, observe, no repository, no allowed sender", () => {
  const settings = defaultSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.eval.mode, "observe");
  assert.equal(settings.github.repository, "");
  assert.equal(settings.policy.sources.github, undefined);
  assert.equal(settings.executor.maxWorkers, 2);
  assert.equal(settings.policy.rules.length, 2);
});

test("settings validation names the offending field", () => {
  assert.throws(() => parseSettings({ github: { repository: "not a repo" } }), /github.repository/);
  assert.throws(() => parseSettings({ eval: { mode: "yolo" } }), /eval.mode/);
  assert.throws(() => parseSettings({ executor: { blockedCommands: ["gh"] } }), /cannot be blocked/);
  assert.throws(() => parseSettings({ executor: { maxWorkers: 99 } }), /executor.maxWorkers/);
  assert.throws(() => parseSettings({ executor: { directory: "relative/path" } }), /absolute path/);
  assert.throws(() => parseSettings({ unknown: 1 }), /unknown: unknown property/);
  const rule = { id: "r", name: "n", enabled: true, instruction: "i" };
  assert.throws(() => parseSettings({ policy: { rules: [rule, rule] } }), /duplicate rule ids/);
});

test("allowed lists are de-duplicated case-insensitively", () => {
  const settings = parseSettings({ policy: { sources: { github: { allowed: [{ id: "Alice" }, { id: "alice" }, { id: "bob" }] } } } });
  assert.deepEqual(settings.policy.sources.github!.allowed.map((entry) => entry.id), ["Alice", "bob"]);
});

test("setupGaps lists what is missing and refuses the agent's own account as an originator", () => {
  const settings = defaultSettings();
  assert.equal(setupGaps(settings, { hasToken: false }).length, 3);
  const ready = parseSettings({ github: { repository: "a/b" }, policy: { sources: { github: { allowed: [{ id: "alice" }] } } } });
  assert.deepEqual(setupGaps(ready, { hasToken: true, login: "agent" }), []);
  assert.match(setupGaps(ready, { hasToken: true, login: "ALICE" }).join(" "), /own GitHub account/);
});
