import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostEnvironment } from "@deyin/extension-api";
import { PluginKernel } from "@deyin/kernel";
import { llmPlugin, Llm } from "@deyin/llm";
import { llmAnthropicPlugin as plugin } from "../src/index.js";

const env: HostEnvironment = { app: "desktop", platform: "linux", userDataPath: "/tmp" };

test("adapter registers its format on the llm seam", async () => {
  const kernel = new PluginKernel({ env, logLevel: "silent" });
  kernel.register(llmPlugin).register(plugin);
  const statuses = await kernel.start([
    { name: "test", rows: [{ id: "llm", plugin: llmPlugin.name }, { id: "adapter", plugin: plugin.name }] },
  ]);
  assert.ok(statuses.every((s) => s.state === "active"), JSON.stringify(statuses));
  assert.equal(kernel.get(Llm).formats().length, 1);
  assert.equal(typeof kernel.get(Llm).resolve(kernel.get(Llm).formats()[0]!), "function");
});
