import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_PERMISSIONS,
  PERMISSION_LIMITS,
  missingTranslations,
  translate,
  updatePermissions,
  type BotPermissionSettings,
} from "@deyin/host-core/shared";
import {
  APPROVAL_MODE_OPTIONS,
  PERMISSION_OPTIONS,
  addRulePatch,
  attemptPermissionLoad,
  attemptPermissionUpdate,
  emptyPermissionForm,
  isToolPermission,
  permissionFormPatch,
  permissionFormProblem,
  permissionRows,
  removeRulePatch,
  rowLabelKey,
  rowPatch,
  ruleProblem,
  type PermissionsApi,
} from "../src/bots/botPermissions.js";

const settingsWith = (patch: unknown): BotPermissionSettings => updatePermissions(EMPTY_PERMISSIONS, patch);

test("the three approval modes are offered in order, each with text", () => {
  assert.deepEqual(APPROVAL_MODE_OPTIONS.map((o) => o.mode), ["auto_review", "read_only", "run_everything"]);
  for (const option of APPROVAL_MODE_OPTIONS) {
    assert.notEqual(translate("en", option.label), option.label);
    assert.notEqual(translate("en", option.hint), option.hint);
  }
  for (const option of PERMISSION_OPTIONS) assert.notEqual(translate("en", option.label), option.label);
  assert.deepEqual(PERMISSION_OPTIONS.map((o) => o.permission), ["always_allow", "needs_approval", "blocked"]);
});

test("every permissions string is translated into every language", () => {
  for (const locale of ["zh", "de"] as const) {
    assert.deepEqual(missingTranslations(locale).filter((key) => key.startsWith("bot.permissions.")), [], locale);
  }
});

test("isToolPermission accepts exactly the three permissions", () => {
  for (const ok of ["always_allow", "needs_approval", "blocked"]) assert.equal(isToolPermission(ok), true);
  for (const bad of ["", "allow", "BLOCKED", "__proto__", "constructor"]) assert.equal(isToolPermission(bad), false);
});

test("a rule is tidied, and refused when empty, too long, or the list is full", () => {
  assert.equal(ruleProblem("  ", []), "bot.permissions.err.rule");
  assert.equal(ruleProblem("Reply to my team", []), null);
  assert.equal(ruleProblem("x".repeat(PERMISSION_LIMITS.instructionLength), []), null);
  assert.equal(ruleProblem("x".repeat(PERMISSION_LIMITS.instructionLength + 1), []), "bot.permissions.err.tooLong");
  const full = Array.from({ length: PERMISSION_LIMITS.instructions }, (_, i) => `rule ${i}`);
  assert.equal(ruleProblem("one more", full), "bot.permissions.err.full");
  assert.equal(ruleProblem("rule 3", full), null, "a rule already there is not 'too many'");
});

test("adding a rule appends it, collapsing whitespace; a duplicate or empty rule adds nothing", () => {
  assert.deepEqual(addRulePatch("allowInstructions", ["a"], "  Reply   to my team "), { autoReview: { allowInstructions: ["a", "Reply to my team"] } });
  assert.deepEqual(addRulePatch("blockInstructions", [], "Never delete"), { autoReview: { blockInstructions: ["Never delete"] } });
  assert.equal(addRulePatch("allowInstructions", ["a"], "a"), null);
  assert.equal(addRulePatch("allowInstructions", ["a"], "   "), null);
  assert.equal(addRulePatch("allowInstructions", [], "x".repeat(PERMISSION_LIMITS.instructionLength + 1)), null);
});

test("removing a rule keeps the others in order and touches only its list", () => {
  assert.deepEqual(removeRulePatch("blockInstructions", ["a", "b", "c"], "b"), { autoReview: { blockInstructions: ["a", "c"] } });
  assert.deepEqual(removeRulePatch("blockInstructions", ["a"], "zzz"), { autoReview: { blockInstructions: ["a"] } });
});

test("the rows list a group's defaults first, then its tools by name, groups in order", () => {
  const settings = settingsWith({ tool: { scope: "gmail", tool: "send_email", permission: "needs_approval" } });
  const more = updatePermissions(settings, { tool: { scope: "gmail", tool: "delete_email", permission: "blocked" } });
  const withDefaults = updatePermissions(more, { defaults: { scope: "gmail", writes: "blocked", reads: "always_allow" } });
  const all = updatePermissions(withDefaults, { tool: { scope: "local", tool: "bash", permission: "blocked" } });
  const rows = permissionRows(all);
  assert.deepEqual(
    rows.map((r) => `${r.group}/${r.kind}/${r.tool}/${r.permission}`),
    [
      "gmail/reads//always_allow",
      "gmail/writes//blocked",
      "gmail/tool/delete_email/blocked",
      "gmail/tool/send_email/needs_approval",
      "local/tool/bash/blocked",
    ],
  );
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, "keys are unique");
  assert.deepEqual(permissionRows(EMPTY_PERMISSIONS), []);
});

test("a tool named like a default does not collide with it", () => {
  const rows = permissionRows(
    updatePermissions(settingsWith({ tool: { scope: "g", tool: "reads", permission: "blocked" } }), { defaults: { scope: "g", reads: "always_allow" } }),
  );
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((r) => r.key)).size, 2);
});

test("each kind of row has its own label, and a patch that sets or clears exactly it", () => {
  assert.equal(rowLabelKey({ key: "", group: "g", kind: "tool", tool: "t", permission: "blocked" }), "bot.permissions.row.tool");
  assert.equal(rowLabelKey({ key: "", group: "g", kind: "reads", tool: "", permission: "blocked" }), "bot.permissions.row.reads");
  assert.equal(rowLabelKey({ key: "", group: "g", kind: "writes", tool: "", permission: "blocked" }), "bot.permissions.row.writes");
  assert.deepEqual(rowPatch({ group: "g", kind: "tool", tool: "t" }, "blocked"), { tool: { scope: "g", tool: "t", permission: "blocked" } });
  assert.deepEqual(rowPatch({ group: "g", kind: "tool", tool: "t" }, null), { tool: { scope: "g", tool: "t", permission: null } });
  assert.deepEqual(rowPatch({ group: "g", kind: "reads", tool: "" }, "needs_approval"), { defaults: { scope: "g", reads: "needs_approval" } });
  assert.deepEqual(rowPatch({ group: "g", kind: "writes", tool: "" }, null), { defaults: { scope: "g", writes: null } });
});

test("the patches the panel builds are ones the host accepts, and do what the row says", () => {
  let settings = EMPTY_PERMISSIONS;
  settings = updatePermissions(settings, permissionFormPatch({ group: "gmail", kind: "tool", tool: "send_email", permission: "needs_approval" }));
  settings = updatePermissions(settings, permissionFormPatch({ group: "gmail", kind: "writes", tool: "", permission: "blocked" }) ?? {});
  assert.deepEqual(permissionRows(settings).map((r) => r.kind), ["writes", "tool"]);
  const first = permissionRows(settings).find((r) => r.kind === "tool");
  assert.ok(first);
  settings = updatePermissions(settings, rowPatch(first, "always_allow"));
  assert.equal(permissionRows(settings).find((r) => r.kind === "tool")?.permission, "always_allow");
  settings = updatePermissions(settings, rowPatch(first, null));
  assert.deepEqual(permissionRows(settings).map((r) => r.kind), ["writes"], "reset removes just that row");
  const writes = permissionRows(settings)[0];
  assert.ok(writes);
  settings = updatePermissions(settings, rowPatch(writes, null));
  assert.deepEqual(permissionRows(settings), [], "a group default can be reset too");
});

test("the add form needs a group, and a tool name unless it covers all reads or changes", () => {
  assert.equal(permissionFormProblem({ ...emptyPermissionForm(), group: " ", tool: "x" }), "bot.permissions.err.group");
  assert.equal(permissionFormProblem({ ...emptyPermissionForm(), tool: " " }), "bot.permissions.err.tool");
  assert.equal(permissionFormProblem({ ...emptyPermissionForm(), tool: "bash" }), null);
  assert.equal(permissionFormProblem({ ...emptyPermissionForm(), kind: "reads", tool: "" }), null);
  assert.equal(permissionFormProblem({ ...emptyPermissionForm(), kind: "writes", tool: "" }), null);
  assert.equal(permissionFormPatch({ ...emptyPermissionForm(), tool: "" }), null);
  assert.deepEqual(permissionFormPatch({ group: " gmail ", kind: "tool", tool: " send_email ", permission: "blocked" }), {
    tool: { scope: "gmail", tool: "send_email", permission: "blocked" },
  });
  assert.deepEqual(emptyPermissionForm(), { group: "local", kind: "tool", tool: "", permission: "blocked" });
});

test("a reads or writes form ignores a leftover tool name", () => {
  assert.deepEqual(permissionFormPatch({ group: "g", kind: "reads", tool: "stale", permission: "blocked" }), { defaults: { scope: "g", reads: "blocked" } });
});

/* Talking to the host ----------------------------------------------------- */

const api = (over: Partial<PermissionsApi>): PermissionsApi => ({
  get: async () => EMPTY_PERMISSIONS,
  update: async () => ({ ok: true, value: EMPTY_PERMISSIONS }),
  onChange: () => () => undefined,
  ...over,
});

test("an accepted change gives the saved settings; a refusal gives its text", async () => {
  const saved = settingsWith({ autoReview: { allowInstructions: ["a"] } });
  assert.deepEqual(await attemptPermissionUpdate(api({ update: async () => ({ ok: true, value: saved }) }), {}), { ok: true, settings: saved });
  assert.deepEqual(await attemptPermissionUpdate(api({ update: async () => ({ ok: false, error: "no", code: "invalid" }) }), {}), { ok: false, error: "no" });
});

test("a call that throws becomes an error, never an unhandled rejection", async () => {
  assert.deepEqual(await attemptPermissionUpdate(api({ update: async () => { throw new Error("ipc closed"); } }), {}), { ok: false, error: "ipc closed" });
  assert.deepEqual(await attemptPermissionUpdate(api({ update: async () => { throw "plain"; } }), {}), { ok: false, error: "plain" });
  assert.deepEqual(await attemptPermissionLoad(api({ get: async () => { throw new Error("gone"); } })), { ok: false, error: "gone" });
  assert.deepEqual(await attemptPermissionLoad(api({})), { ok: true, settings: EMPTY_PERMISSIONS });
});
