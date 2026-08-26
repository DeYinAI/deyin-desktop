import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostEnvironment } from "@deyin/extension-api";
import { PluginKernel } from "@deyin/kernel";
import { toolCatalogPlugin, Tools } from "@deyin/tools";
import { toolsAgentPlugin } from "../src/index.js";

const env: HostEnvironment = { app: "desktop", platform: "linux", userDataPath: "/tmp" };

test("@deyin/plugin-tools-agent registers its family into the catalog", async () => {
  const kernel = new PluginKernel({ env, logLevel: "silent" });
  kernel.register(toolCatalogPlugin).register(toolsAgentPlugin);
  await kernel.start([
    { name: "test", rows: [{ id: "catalog", plugin: toolCatalogPlugin.name }, { id: "family", plugin: "@deyin/plugin-tools-agent" }] },
  ]);
  assert.deepEqual(
    [...kernel.get(Tools).names()].sort(),
    ["remember","forget","memory","skill","read_session_context","send_message","await","wait","enter_worktree","exit_worktree","ask_question"].sort(),
  );
});
