import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostEnvironment, PluginDefinition } from "@deyin/extension-api";
import { PluginKernel } from "@deyin/kernel";
import type { ToolDefinition } from "@deyin/agent-core";
import { buildToolRegistry, createToolCatalog, Tools, toolCatalogPlugin } from "../src/index.js";

const env: HostEnvironment = { app: "desktop", platform: "linux", userDataPath: "/tmp" };

function fakeTool(name: string): ToolDefinition {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: "object", properties: {} },
    tier: "read",
    summarize: () => name,
    execute: async () => `${name} ran`,
  } as unknown as ToolDefinition;
}

test("catalog plugin provides the seam; families add tools, duplicates ignored", async () => {
  const family: PluginDefinition = {
    name: "@deyin/plugin-test-family",
    inject: ["tools"],
    apply: (ctx) => {
      const catalog = ctx.get(Tools);
      catalog.add(fakeTool("alpha"));
      catalog.add([fakeTool("beta"), fakeTool("alpha")]);
    },
  };
  const kernel = new PluginKernel({ env, logLevel: "silent" });
  kernel.register(toolCatalogPlugin).register(family);
  await kernel.start([
    { name: "test", rows: [{ id: "catalog", plugin: toolCatalogPlugin.name }, { id: "family", plugin: family.name }] },
  ]);
  assert.deepEqual(kernel.get(Tools).names(), ["alpha", "beta"]);
});

test("family without the catalog fails in isolation with a clear error", async () => {
  const kernel = new PluginKernel({ env, logLevel: "silent" });
  const orphan: PluginDefinition = {
    name: "@deyin/plugin-orphan-family",
    inject: ["tools"],
    apply: (ctx) => {
      void ctx.get(Tools).names();
    },
  };
  kernel.register(orphan);
  const statuses = await kernel.start([{ name: "test", rows: [{ id: "orphan", plugin: orphan.name }] }]);
  const status = statuses.find((s) => s.name === orphan.name);
  assert.equal(status?.state, "failed");
  assert.match(status?.error ?? "", /tools/);
});

test("buildToolRegistry carries catalog plus run-specific extras", () => {
  const catalog = createToolCatalog();
  catalog.add([fakeTool("one"), fakeTool("two")]);
  const registry = buildToolRegistry(catalog, [fakeTool("task")]);
  assert.deepEqual(
    registry.list().map((t) => t.name),
    ["one", "two", "task"],
  );
});
