import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostEnvironment } from "@deyin/extension-api";
import { PluginKernel } from "@deyin/kernel";
import { toolCatalogPlugin, Tools } from "@deyin/tools";
import { toolsWebPlugin } from "../src/index.js";

const env: HostEnvironment = { app: "desktop", platform: "linux", userDataPath: "/tmp" };

test("@deyin/plugin-tools-web registers its family into the catalog", async () => {
  const kernel = new PluginKernel({ env, logLevel: "silent" });
  kernel.register(toolCatalogPlugin).register(toolsWebPlugin);
  await kernel.start([
    { name: "test", rows: [{ id: "catalog", plugin: toolCatalogPlugin.name }, { id: "family", plugin: "@deyin/plugin-tools-web" }] },
  ]);
  assert.deepEqual(
    [...kernel.get(Tools).names()].sort(),
    ["websearch","web_fetch"].sort(),
  );
});
