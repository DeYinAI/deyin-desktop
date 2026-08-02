import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlannerRegistry, PLANNER_ALLOWED_TOOLS } from "../src/coordinator/planner-agent.js";
import { createBuiltinRegistry } from "../src/tools/index.js";
import { createUseCapabilityTool } from "../src/tools/use-capability.js";

test("planner registry excludes write tools", () => {
  const source = createBuiltinRegistry();
  source.register(
    createUseCapabilityTool({
      invokeMcp: async () => "ok",
    }),
  );
  const planner = createPlannerRegistry({
    source,
    invokeMcp: async () => "ok",
  });

  for (const name of planner.names()) {
    assert.ok(PLANNER_ALLOWED_TOOLS.has(name), `unexpected planner tool: ${name}`);
  }
  assert.equal(planner.get("write"), undefined);
  assert.equal(planner.get("edit"), undefined);
  assert.equal(planner.get("bash"), undefined);
  assert.equal(planner.get("task"), undefined);
  assert.ok(planner.get("read"));
  assert.ok(planner.get("use_capability"));
});

test("planner tool schema hash stable when executor adds write tools", () => {
  const source = createBuiltinRegistry();
  const planner1 = createPlannerRegistry({ source, invokeMcp: async () => "" });
  const hash1 = JSON.stringify(planner1.toWire());

  source.register({
    name: "extra_write",
    description: "test",
    tier: "write",
    parameters: { type: "object", properties: {} },
    summarize: () => "x",
    execute: async () => "x",
  });

  const planner2 = createPlannerRegistry({ source, invokeMcp: async () => "" });
  const hash2 = JSON.stringify(planner2.toWire());
  assert.equal(hash1, hash2);
});
