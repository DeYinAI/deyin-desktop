import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostEnvironment } from "@deyin/extension-api";
import { PluginKernel } from "@deyin/kernel";
import { toolCatalogPlugin, Tools } from "@deyin/tools";
import { toolsGitPlugin } from "../src/index.js";

const env: HostEnvironment = { app: "desktop", platform: "linux", userDataPath: "/tmp" };

test("@deyin/plugin-tools-git registers its family into the catalog", async () => {
  const kernel = new PluginKernel({ env, logLevel: "silent" });
  kernel.register(toolCatalogPlugin).register(toolsGitPlugin);
  await kernel.start([
    { name: "test", rows: [{ id: "catalog", plugin: toolCatalogPlugin.name }, { id: "family", plugin: "@deyin/plugin-tools-git" }] },
  ]);
  // Read-tier only. The mutating git tools go through bash: as separate tools
  // they turned one operation into three round trips and competed with the
  // system prompt's own "use bash for git" instruction.
  assert.deepEqual(
    [...kernel.get(Tools).names()].sort(),
    ["git_status", "git_log", "git_diff", "git_blame"].sort(),
  );
});
