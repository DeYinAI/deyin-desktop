import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionEngine } from "../src/permissions.js";

test("neverSkipTools ignores skipAll for protected tools", () => {
  const engine = new PermissionEngine({
    skipAll: true,
    neverSkipTools: ["computer_launch_app"],
    configRules: [{ tool: "computer_launch_app", action: "ask" }],
  });
  assert.equal(engine.actionFor({ name: "computer_launch_app", tier: "execute" }), "ask");
  assert.equal(engine.actionFor({ name: "read", tier: "read" }), "allow");
});

test("neverSkipPrefixes ignores skipAll for matching tools", () => {
  const engine = new PermissionEngine({
    skipAll: true,
    neverSkipPrefixes: ["computer_"],
    configRules: [{ tool: "computer_click", action: "ask" }],
  });
  assert.equal(engine.actionFor({ name: "computer_click", tier: "execute" }), "ask");
  assert.equal(engine.actionFor({ name: "bash", tier: "execute" }), "allow");
});

test("session grants do not bypass protected tools", () => {
  const engine = new PermissionEngine({
    skipAll: false,
    neverSkipTools: ["computer_launch_app"],
    configRules: [{ tool: "computer_launch_app", action: "ask" }],
  });
  engine.grantForSession("computer_launch_app");
  assert.equal(engine.actionFor({ name: "computer_launch_app", tier: "execute" }), "ask");
});
