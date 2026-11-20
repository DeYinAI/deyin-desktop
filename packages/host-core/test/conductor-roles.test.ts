import test from "node:test";
import assert from "node:assert/strict";
import {
  CONDUCTOR_PREFERENCE_ROLES,
  CONDUCTOR_ROLES,
  CONDUCTOR_ROLE_INFO,
  DEFAULT_SETTINGS,
  isConductorRole,
  migrateSettings,
  resolveConductorRoleAgent,
  resolveConductorRoles,
  sanitizeConductorRolePreferences,
  type ConductorRoleAgentFacts,
} from "../src/index.js";

const ALL: ConductorRoleAgentFacts[] = [
  { id: "claude", installed: true },
  { id: "codex", installed: true },
  { id: "opencode", installed: true },
  { id: "zcode", installed: true },
  { id: "cursor", installed: true },
];

function without(...ids: string[]): ConductorRoleAgentFacts[] {
  return ALL.map((agent) => (ids.includes(agent.id) ? { ...agent, installed: false } : agent));
}

test("defaults: plan is Claude, code is ZCode, review is Codex", () => {
  assert.deepEqual(resolveConductorRoleAgent("plan", {}, ALL), { role: "plan", agentId: "claude", source: "default" });
  assert.deepEqual(resolveConductorRoleAgent("code", {}, ALL), { role: "code", agentId: "zcode", source: "default" });
  assert.deepEqual(resolveConductorRoleAgent("review", {}, ALL), { role: "review", agentId: "codex", source: "default" });
});

test("an installed preference beats the default", () => {
  const resolved = resolveConductorRoleAgent("code", { code: "cursor" }, ALL);
  assert.deepEqual(resolved, { role: "code", agentId: "cursor", source: "preference" });
});

test("a preference for an agent that is not installed is ignored", () => {
  const resolved = resolveConductorRoleAgent("code", { code: "cursor" }, without("cursor"));
  assert.deepEqual(resolved, { role: "code", agentId: "zcode", source: "default" });
});

test("with the default missing too, the first installed agent is the fallback", () => {
  const resolved = resolveConductorRoleAgent("plan", {}, without("claude"));
  assert.deepEqual(resolved, { role: "plan", agentId: "codex", source: "fallback" });
});

test("roles without a default fall back to the first installed agent", () => {
  for (const role of ["test", "design", "docs", "custom"] as const) {
    assert.deepEqual(resolveConductorRoleAgent(role, {}, ALL), { role, agentId: "claude", source: "fallback" }, role);
  }
});

test("nothing installed resolves to null, and resolveConductorRoles to an empty list", () => {
  const none = ALL.map((agent) => ({ ...agent, installed: false }));
  assert.equal(resolveConductorRoleAgent("plan", { plan: "claude" }, none), null);
  assert.deepEqual(resolveConductorRoles({}, none), []);
});

test("custom never reads a preference", () => {
  const resolved = resolveConductorRoleAgent("custom", { custom: "cursor" } as never, ALL);
  assert.equal(resolved?.agentId, "claude");
  assert.equal(resolved?.source, "fallback");
});

test("resolveConductorRoles covers every preferable role and skips custom", () => {
  const roles = resolveConductorRoles({}, ALL).map((entry) => entry.role);
  assert.deepEqual(roles, [...CONDUCTOR_PREFERENCE_ROLES]);
  assert.ok(!roles.includes("custom"));
});

test("every role is described, and CONDUCTOR_ROLES matches the descriptions", () => {
  assert.deepEqual([...CONDUCTOR_ROLES].sort(), Object.keys(CONDUCTOR_ROLE_INFO).sort());
  for (const role of CONDUCTOR_ROLES) {
    assert.ok(CONDUCTOR_ROLE_INFO[role].label.length > 0, role);
    assert.ok(CONDUCTOR_ROLE_INFO[role].description.length > 0, role);
  }
});

test("isConductorRole accepts only known role names", () => {
  assert.equal(isConductorRole("plan"), true);
  assert.equal(isConductorRole("custom"), true);
  assert.equal(isConductorRole("manager"), false);
  assert.equal(isConductorRole(undefined), false);
});

test("sanitizeConductorRolePreferences keeps known roles with non-blank agent ids only", () => {
  assert.deepEqual(
    sanitizeConductorRolePreferences({ plan: " claude ", code: "", review: 3, custom: "codex", manager: "zcode" }),
    { plan: "claude" },
  );
  assert.deepEqual(sanitizeConductorRolePreferences(null), {});
  assert.deepEqual(sanitizeConductorRolePreferences(["claude"]), {});
  assert.deepEqual(sanitizeConductorRolePreferences("claude"), {});
});

test("settings: the preference map defaults to empty and is cleaned on load", () => {
  assert.deepEqual(DEFAULT_SETTINGS.conductorRolePreferences, {});
  assert.deepEqual(migrateSettings({}).conductorRolePreferences, {});
  const migrated = migrateSettings({ conductorRolePreferences: { plan: "claude", bogus: "x", code: 7 } });
  assert.deepEqual(migrated.conductorRolePreferences, { plan: "claude" });
});
