import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionEngine } from "../src/permissions.js";

const read = { name: "read", tier: "read" } as const;
const edit = { name: "edit", tier: "write" } as const;
const bash = { name: "bash", tier: "execute" } as const;

test("tier defaults: read allowed, write/execute ask", () => {
  const engine = new PermissionEngine();
  assert.equal(engine.actionFor(read), "allow");
  assert.equal(engine.actionFor(edit), "ask");
  assert.equal(engine.actionFor(bash), "ask");
});

test("agent rules override tier defaults", () => {
  const engine = new PermissionEngine({ agentRules: [{ tool: "edit", action: "deny" }] });
  assert.equal(engine.actionFor(edit), "deny");
  assert.equal(engine.actionFor(bash), "ask");
});

test("config rules override agent rules (last writer wins)", () => {
  const engine = new PermissionEngine({
    agentRules: [{ tool: "bash", action: "deny" }],
    configRules: [{ tool: "bash", action: "allow" }],
  });
  assert.equal(engine.actionFor(bash), "allow");
});

test("wildcard rules apply to every tool, later specific rules win", () => {
  const engine = new PermissionEngine({
    agentRules: [{ tool: "*", action: "deny" }],
    configRules: [{ tool: "read", action: "allow" }],
  });
  assert.equal(engine.actionFor(bash), "deny");
  assert.equal(engine.actionFor(read), "allow");
});

test("session grants allow without prompting until the process ends", () => {
  const engine = new PermissionEngine();
  assert.equal(engine.actionFor(bash), "ask");
  engine.grantForSession("bash");
  assert.equal(engine.actionFor(bash), "allow");
  assert.deepEqual(engine.listSessionGrants(), ["bash"]);
});

test("a shared grant set carries \"allow always\" across runs and reconfigures", () => {
  const grants = new Set<string>();
  const firstRun = new PermissionEngine({ sessionGrants: grants });
  firstRun.grantForSession("bash");
  assert.deepEqual([...grants], ["bash"]);

  // The next message builds a brand-new engine; the grant must still hold.
  const secondRun = new PermissionEngine({ sessionGrants: grants });
  assert.equal(secondRun.actionFor(bash), "allow");

  // And a mid-run mode switch must not revoke it.
  secondRun.reconfigure({ sessionGrants: grants });
  assert.equal(secondRun.actionFor(bash), "allow");
});

test("session grants cannot override deny rules", () => {
  const engine = new PermissionEngine({
    agentRules: [{ tool: "write", action: "deny" }, { tool: "edit", action: "deny" }],
  });
  engine.grantForSession("write");
  engine.grantForSession("edit");
  assert.equal(engine.actionFor({ name: "write", tier: "write" }), "deny");
  assert.equal(engine.actionFor(edit), "deny");
});

test("skipAll (--yes) allows non-denied tools but explicit denies still win", () => {
  const engine = new PermissionEngine({ agentRules: [{ tool: "*", action: "deny" }], skipAll: true });
  assert.equal(engine.actionFor(bash), "deny");
  assert.equal(engine.actionFor(edit), "deny");
});

test("skipAll allows tools without explicit deny rules", () => {
  const engine = new PermissionEngine({ skipAll: true });
  assert.equal(engine.actionFor(bash), "allow");
  assert.equal(engine.actionFor(edit), "allow");
});
