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

test("skipAll (--yes) allows everything, even explicit denies", () => {
  const engine = new PermissionEngine({ agentRules: [{ tool: "*", action: "deny" }], skipAll: true });
  assert.equal(engine.actionFor(bash), "allow");
  assert.equal(engine.actionFor(edit), "allow");
});
