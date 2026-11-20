import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_PERMISSIONS,
  PERMISSION_LIMITS,
  isReadOnlyTool,
  normalizePermissions,
  rememberAlwaysAllow,
  resolveToolPermission,
  serverRuleConflict,
  splitToolName,
  toolPermissionFor,
  updatePermissions,
} from "../src/bots/permissions.js";
import type { BotPermissionSettings } from "../src/bots/permissions.js";
import { BotError } from "../src/bots/types.js";

const refused = (fn: () => unknown, code: string): void =>
  assert.throws(fn, (error: unknown) => error instanceof BotError && error.code === code);

test("an MCP server's tools share a scope; everything else is local", () => {
  assert.deepEqual(splitToolName("mcp__gmail__read_email"), { scope: "gmail", tool: "read_email" });
  assert.deepEqual(splitToolName("mcp__my-server__do__thing"), { scope: "my-server", tool: "do__thing" });
  assert.deepEqual(splitToolName("write_file"), { scope: "local", tool: "write_file" });
  // Malformed MCP names are not split into an empty scope or tool.
  assert.deepEqual(splitToolName("mcp____x"), { scope: "local", tool: "mcp____x" });
  assert.deepEqual(splitToolName("mcp__gmail__"), { scope: "local", tool: "mcp__gmail__" });
});

test("built-in tools read-only by tier; connector tools by the recovered lists", () => {
  assert.equal(isReadOnlyTool({ name: "read_file", tier: "read" }), true);
  assert.equal(isReadOnlyTool({ name: "ask_user", tier: "interaction" }), true);
  assert.equal(isReadOnlyTool({ name: "write_file", tier: "write" }), false);
  assert.equal(isReadOnlyTool({ name: "bash", tier: "execute" }), false);
  assert.equal(isReadOnlyTool({ name: "mystery" }), false, "no tier means it can change things");

  assert.equal(isReadOnlyTool({ name: "mcp__gmail__read_email", tier: "execute" }), true);
  assert.equal(isReadOnlyTool({ name: "mcp__gmail__send_email", tier: "execute" }), false);
  assert.equal(isReadOnlyTool({ name: "mcp__google-calendar__list_events" }), true);
  assert.equal(isReadOnlyTool({ name: "mcp__google-calendar__create_event" }), false);
  assert.equal(isReadOnlyTool({ name: "mcp__google-drive__read_file" }), true);
  assert.equal(isReadOnlyTool({ name: "mcp__google-drive__delete_file" }), false);
  // A read-only name on some other server proves nothing.
  assert.equal(isReadOnlyTool({ name: "mcp__acme__read_email" }), false);
  assert.equal(isReadOnlyTool({ name: "mcp__acme__search" }), false);
});

test("defaults: reads are allowed, writes need approval, and neither is explicit", () => {
  assert.deepEqual(resolveToolPermission(EMPTY_PERMISSIONS, { name: "read_file", tier: "read" }), { permission: "always_allow", explicit: false });
  assert.deepEqual(resolveToolPermission(EMPTY_PERMISSIONS, { name: "bash", tier: "execute" }), { permission: "needs_approval", explicit: false });
});

test("a tool's own entry beats its scope's default, which beats the built-in one", () => {
  let settings = updatePermissions(EMPTY_PERMISSIONS, { defaults: { scope: "acme", writes: "blocked", reads: "needs_approval" } });
  assert.deepEqual(resolveToolPermission(settings, { name: "mcp__acme__do_it" }), { permission: "blocked", explicit: true });
  settings = updatePermissions(settings, { tool: { scope: "acme", tool: "do_it", permission: "always_allow" } });
  assert.deepEqual(resolveToolPermission(settings, { name: "mcp__acme__do_it" }), { permission: "always_allow", explicit: true });
  // Another tool in the scope still gets the default; another scope is untouched.
  assert.equal(toolPermissionFor(settings, { name: "mcp__acme__other" }), "blocked");
  assert.equal(toolPermissionFor(settings, { name: "mcp__other__other" }), "needs_approval");
  // The reads default applies to a read-only tool of that scope.
  const gmail = updatePermissions(EMPTY_PERMISSIONS, { defaults: { scope: "gmail", reads: "needs_approval" } });
  assert.deepEqual(resolveToolPermission(gmail, { name: "mcp__gmail__read_email" }), { permission: "needs_approval", explicit: true });
});

test("instructions are trimmed, tidied and de-duplicated", () => {
  const settings = updatePermissions(EMPTY_PERMISSIONS, {
    autoReview: { allowInstructions: ["  Reply to   my team  ", "", "Reply to my team", "Archive newsletters"] },
  });
  assert.deepEqual(settings.autoReview.allowInstructions, ["Reply to my team", "Archive newsletters"]);
  assert.deepEqual(settings.autoReview.blockInstructions, [], "the other list is untouched");
});

test("instruction limits refuse, with a reason, rather than cutting silently", () => {
  const many = Array.from({ length: PERMISSION_LIMITS.instructions + 1 }, (_, i) => `rule ${i}`);
  refused(() => updatePermissions(EMPTY_PERMISSIONS, { autoReview: { blockInstructions: many } }), "limit");
  const ok = many.slice(0, PERMISSION_LIMITS.instructions);
  assert.equal(updatePermissions(EMPTY_PERMISSIONS, { autoReview: { blockInstructions: ok } }).autoReview.blockInstructions.length, 20);
  refused(() => updatePermissions(EMPTY_PERMISSIONS, { autoReview: { allowInstructions: ["x".repeat(PERMISSION_LIMITS.instructionLength + 1)] } }), "invalid");
  const exact = "x".repeat(PERMISSION_LIMITS.instructionLength);
  assert.equal(updatePermissions(EMPTY_PERMISSIONS, { autoReview: { allowInstructions: [exact] } }).autoReview.allowInstructions[0], exact);
  refused(() => updatePermissions(EMPTY_PERMISSIONS, { autoReview: { allowInstructions: [1] } }), "invalid");
  refused(() => updatePermissions(EMPTY_PERMISSIONS, { autoReview: { allowInstructions: "all" } }), "invalid");
});

test("malformed patches are refused", () => {
  refused(() => updatePermissions(EMPTY_PERMISSIONS, null), "invalid");
  refused(() => updatePermissions(EMPTY_PERMISSIONS, []), "invalid");
  refused(() => updatePermissions(EMPTY_PERMISSIONS, { autoReview: "on" }), "invalid");
  refused(() => updatePermissions(EMPTY_PERMISSIONS, { autoReview: { enabled: "yes" } }), "invalid");
  refused(() => updatePermissions(EMPTY_PERMISSIONS, { tool: { scope: "a", tool: "b", permission: "sometimes" } }), "invalid");
  refused(() => updatePermissions(EMPTY_PERMISSIONS, { tool: { scope: "", tool: "b", permission: "blocked" } }), "invalid");
  refused(() => updatePermissions(EMPTY_PERMISSIONS, { tool: { scope: "a", tool: 5, permission: "blocked" } }), "invalid");
  refused(() => updatePermissions(EMPTY_PERMISSIONS, { tool: { scope: "a\nb", tool: "b", permission: "blocked" } }), "invalid");
  refused(() => updatePermissions(EMPTY_PERMISSIONS, { tool: { scope: "a", tool: "x".repeat(PERMISSION_LIMITS.nameLength + 1), permission: "blocked" } }), "invalid");
  refused(() => updatePermissions(EMPTY_PERMISSIONS, { defaults: { scope: "a", reads: "never" } }), "invalid");
});

test("record keys that could poison an object are refused", () => {
  for (const name of ["__proto__", "constructor", "prototype"]) {
    refused(() => updatePermissions(EMPTY_PERMISSIONS, { tool: { scope: name, tool: "x", permission: "blocked" } }), "invalid");
    refused(() => updatePermissions(EMPTY_PERMISSIONS, { tool: { scope: "a", tool: name, permission: "blocked" } }), "invalid");
    refused(() => updatePermissions(EMPTY_PERMISSIONS, { defaults: { scope: name, reads: "blocked" } }), "invalid");
  }
  assert.equal(({} as Record<string, unknown>).blocked, undefined, "nothing leaked onto Object.prototype");
});

test("removing the last permission in a scope removes the scope", () => {
  let settings = updatePermissions(EMPTY_PERMISSIONS, { tool: { scope: "acme", tool: "x", permission: "blocked" } });
  assert.deepEqual(Object.keys(settings.scopes), ["acme"]);
  settings = updatePermissions(settings, { tool: { scope: "acme", tool: "x", permission: null } });
  assert.deepEqual(settings.scopes, {});
  settings = updatePermissions(EMPTY_PERMISSIONS, { defaults: { scope: "acme", writes: "blocked" } });
  settings = updatePermissions(settings, { defaults: { scope: "acme", writes: null } });
  assert.deepEqual(settings.scopes, {});
  // Clearing something that was never set is not an error and does not create a scope.
  assert.deepEqual(updatePermissions(EMPTY_PERMISSIONS, { tool: { scope: "acme", tool: "x", permission: null } }).scopes, {});
});

test("scope and tool counts are capped", () => {
  let settings = EMPTY_PERMISSIONS;
  for (let i = 0; i < PERMISSION_LIMITS.scopes; i++) {
    settings = updatePermissions(settings, { tool: { scope: `s${i}`, tool: "t", permission: "blocked" } });
  }
  refused(() => updatePermissions(settings, { tool: { scope: "one-more", tool: "t", permission: "blocked" } }), "limit");
  refused(() => updatePermissions(settings, { defaults: { scope: "one-more", reads: "blocked" } }), "limit");
  // An existing scope can still change.
  settings = updatePermissions(settings, { tool: { scope: "s0", tool: "u", permission: "blocked" } });
  assert.equal(settings.scopes.s0?.tools.u, "blocked");

  let one = EMPTY_PERMISSIONS;
  for (let i = 0; i < PERMISSION_LIMITS.toolsPerScope; i++) {
    one = updatePermissions(one, { tool: { scope: "big", tool: `t${i}`, permission: "blocked" } });
  }
  refused(() => updatePermissions(one, { tool: { scope: "big", tool: "extra", permission: "blocked" } }), "limit");
  assert.equal(updatePermissions(one, { tool: { scope: "big", tool: "t0", permission: "always_allow" } }).scopes.big?.tools.t0, "always_allow");
});

test("updating never changes the settings it was given", () => {
  const before = updatePermissions(EMPTY_PERMISSIONS, {
    autoReview: { allowInstructions: ["a"] },
    tool: { scope: "acme", tool: "x", permission: "blocked" },
  });
  const snapshot = JSON.stringify(before);
  updatePermissions(before, { autoReview: { allowInstructions: ["b"], enabled: false }, tool: { scope: "acme", tool: "y", permission: "always_allow" } });
  rememberAlwaysAllow(before, "mcp__acme__z");
  assert.equal(JSON.stringify(before), snapshot);
  assert.ok(Object.isFrozen(EMPTY_PERMISSIONS) && Object.isFrozen(EMPTY_PERMISSIONS.scopes));
});

test("always allow saves the tool under its own scope, local or connector", () => {
  let settings = rememberAlwaysAllow(EMPTY_PERMISSIONS, "mcp__gmail__send_email");
  settings = rememberAlwaysAllow(settings, "write_file");
  assert.equal(settings.scopes.gmail?.tools.send_email, "always_allow");
  assert.equal(settings.scopes.local?.tools.write_file, "always_allow");
  assert.equal(toolPermissionFor(settings, { name: "mcp__gmail__send_email" }), "always_allow");
  assert.equal(toolPermissionFor(settings, { name: "mcp__gmail__delete_email" }), "needs_approval", "only that tool");
});

test("stored settings are read leniently: bad parts are dropped, the rest kept", () => {
  const settings = normalizePermissions({
    autoReview: { enabled: false, allowInstructions: ["ok", 5, ""], blockInstructions: "nope" },
    // JSON.parse makes `__proto__` a real own key, which an object literal would not.
    scopes: JSON.parse(
      `{"acme":{"tools":{"good":"blocked","bad":"maybe","__proto__":"blocked"},"reads":"always_allow","writes":"weird"},` +
        `"":{"tools":{"x":"blocked"}},"__proto__":{"tools":{"x":"blocked"}},"${"x".repeat(PERMISSION_LIMITS.nameLength + 1)}":{"tools":{}}}`,
    ),
  });
  assert.equal(settings.autoReview.enabled, false);
  assert.deepEqual(settings.autoReview.allowInstructions, ["ok"]);
  assert.deepEqual(settings.autoReview.blockInstructions, []);
  assert.deepEqual(Object.keys(settings.scopes), ["acme"]);
  assert.equal(Object.getPrototypeOf(settings.scopes), Object.prototype, "a stored `__proto__` did not replace the prototype");
  assert.equal(Object.getPrototypeOf(settings.scopes.acme?.tools), Object.prototype);
  assert.deepEqual(settings.scopes.acme, { tools: { good: "blocked" }, reads: "always_allow" });
});

test("nothing stored means the defaults", () => {
  for (const raw of [undefined, null, 5, "x", [], {}]) {
    assert.deepEqual(normalizePermissions(raw), { autoReview: { enabled: true, allowInstructions: [], blockInstructions: [] }, scopes: {} });
  }
  // Round trip.
  const set = updatePermissions(EMPTY_PERMISSIONS, { autoReview: { allowInstructions: ["a"] }, tool: { scope: "s", tool: "t", permission: "blocked" } });
  assert.deepEqual(normalizePermissions(JSON.parse(JSON.stringify(set))), set);
});

test("a server holds a Bot to its mode only, so rules it cannot enforce stop a run-everything Bot", () => {
  const rules = (patch: Partial<BotPermissionSettings["autoReview"]> = {}, scopes: BotPermissionSettings["scopes"] = {}): BotPermissionSettings => ({
    autoReview: { enabled: true, allowInstructions: [], blockInstructions: [], ...patch },
    scopes,
  });
  assert.equal(serverRuleConflict(EMPTY_PERMISSIONS, "run_everything"), null);
  assert.equal(serverRuleConflict(rules({}, { local: { tools: { write_file: "always_allow" }, reads: "always_allow", writes: "always_allow" } }), "run_everything"), null);
  // Allow instructions only widen what is allowed; they are not a restriction.
  assert.equal(serverRuleConflict(rules({ allowInstructions: ["Send mail to me"] }), "run_everything"), null);
  const conflict = /Read only/;
  assert.match(serverRuleConflict(rules({ blockInstructions: ["Never email my boss"] }), "run_everything") ?? "", conflict);
  assert.match(serverRuleConflict(rules({}, { local: { tools: { shell: "blocked" } } }), "run_everything") ?? "", conflict);
  assert.match(serverRuleConflict(rules({}, { gmail: { tools: { send_email: "needs_approval" } } }), "run_everything") ?? "", conflict);
  assert.match(serverRuleConflict(rules({}, { local: { tools: {}, writes: "needs_approval" } }), "run_everything") ?? "", conflict);
  assert.match(serverRuleConflict(rules({}, { local: { tools: {}, reads: "blocked" } }), "run_everything") ?? "", conflict);
  // Read-only and Auto Review both run read-only on a server, which is stricter than any rule, so nothing is lost.
  for (const mode of ["read_only", "auto_review"] as const) {
    assert.equal(serverRuleConflict(rules({ blockInstructions: ["x"] }, { local: { tools: { shell: "blocked" } } }), mode), null);
  }
});
