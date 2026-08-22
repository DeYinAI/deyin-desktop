import assert from "node:assert/strict";
import { test } from "node:test";
import { hostToolsForSubagent } from "../src/subagent-host-tools.js";
import type { ToolDefinition } from "../src/types.js";

function stubTool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    tier: "execute",
    parameters: { type: "object", properties: {} },
    summarize: () => name,
    execute: async () => "ok",
  };
}

const stubServices = {
  browser: { tools: () => [stubTool("browser_navigate"), stubTool("browser_snapshot")] },
  computerUse: { tools: () => [stubTool("computer_click")] },
};

test("hostToolsForSubagent filters browser tools when enabled and allowlisted", () => {
  const tools = hostToolsForSubagent(
    { tools: ["browser_navigate", "read"] },
    stubServices,
    { browserEnabled: true, computerUseEnabled: false },
  );
  assert.deepEqual(
    tools.map((t) => t.name),
    ["browser_navigate"],
  );
});

test("hostToolsForSubagent skips browser tools when browser control is disabled", () => {
  const tools = hostToolsForSubagent(
    { tools: ["browser_navigate"] },
    stubServices,
    { browserEnabled: false, computerUseEnabled: true },
  );
  assert.equal(tools.length, 0);
});

test("hostToolsForSubagent includes computer tools when enabled and allowlisted", () => {
  const tools = hostToolsForSubagent(
    { tools: ["computer_click"] },
    stubServices,
    { browserEnabled: false, computerUseEnabled: true },
  );
  assert.deepEqual(
    tools.map((t) => t.name),
    ["computer_click"],
  );
});
