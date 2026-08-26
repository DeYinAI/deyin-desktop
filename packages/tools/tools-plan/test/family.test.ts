import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostEnvironment } from "@deyin/extension-api";
import { PluginKernel } from "@deyin/kernel";
import { toolCatalogPlugin, Tools } from "@deyin/tools";
import { toolsPlanPlugin } from "../src/index.js";

const env: HostEnvironment = { app: "desktop", platform: "linux", userDataPath: "/tmp" };

test("@deyin/plugin-tools-plan registers its family into the catalog", async () => {
  const kernel = new PluginKernel({ env, logLevel: "silent" });
  kernel.register(toolCatalogPlugin).register(toolsPlanPlugin);
  await kernel.start([
    { name: "test", rows: [{ id: "catalog", plugin: toolCatalogPlugin.name }, { id: "family", plugin: "@deyin/plugin-tools-plan" }] },
  ]);
  assert.deepEqual(
    [...kernel.get(Tools).names()].sort(),
    ["todo_read","todo_write","create_plan","enter_plan_mode","exit_plan_mode","switch_mode","report_goal_met","complete_step"].sort(),
  );
});
