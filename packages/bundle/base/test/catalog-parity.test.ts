import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostEnvironment } from "@deyin/extension-api";
import { PluginKernel } from "@deyin/kernel";
import { bundleBase, registerBasePlugins } from "../src/index.js";
import { Tools } from "@deyin/tools";

const env: HostEnvironment = { app: "desktop", platform: "linux", userDataPath: "/tmp" };

/** Core tools every desktop/web host must expose after bundle:base activation. */
const CORE_TOOL_NAMES = [
  // fs + shell
  "read",
  "write",
  "edit",
  "grep",
  "bash",
  // plan + delivery
  "todo_write",
  "todo_read",
  "create_plan",
  "create_page",
  "enter_plan_mode",
  "exit_plan_mode",
  "switch_mode",
  "complete_step",
  // agent state
  "ask_question",
  "skill",
  "await",
  "wait",
] as const;

test("bundle:base catalog exposes core chat and tool names", async () => {
  const kernel = registerBasePlugins(new PluginKernel({ env, logLevel: "silent" }));
  const statuses = await kernel.start([bundleBase]);
  assert.deepEqual(statuses.filter((s) => s.state === "failed"), []);
  const names = new Set(kernel.get(Tools).names());
  for (const tool of CORE_TOOL_NAMES) {
    assert.ok(names.has(tool), `missing core tool: ${tool}`);
  }
});
