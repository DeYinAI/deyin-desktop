import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PluginKernel } from "@deyin/kernel";
import type { HostEnvironment } from "@deyin/extension-api";
import { Optimization, optimizationPluginDef } from "../src/kernel-plugin.js";

const env: HostEnvironment = { app: "desktop", platform: process.platform, userDataPath: tmpdir() };
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("optimization plugin activates via the kernel and provides the seam", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "deyin-opt-"));
  dirs.push(dataDir);
  const kernel = new PluginKernel({ env, logLevel: "silent" });
  kernel.register(optimizationPluginDef);
  const statuses = await kernel.start([
    { name: "test", rows: [{ id: "opt", plugin: "@deyin/plugin-optimization", config: { dataDir } }] },
  ]);
  // The plugin is lazy by definition: dormant until activated.
  assert.equal(statuses.find((s) => s.name === "@deyin/plugin-optimization")?.state, "lazy");
  assert.equal(kernel.tryGet(Optimization), undefined);
  const activation = await kernel.activatePlugin("@deyin/plugin-optimization");
  assert.equal(activation.state, "active");
  const opt = kernel.get(Optimization);
  assert.equal(typeof opt.beforeToolExecution, "function");
  const stats = opt.stats();
  assert.ok(stats.tool && stats.response);
  await kernel.dispose();
  // After dispose the service must be gone.
  assert.equal(kernel.tryGet(Optimization), undefined);
});

test("missing dataDir fails the plugin in isolation with a clear error", async () => {
  const kernel = new PluginKernel({ env, logLevel: "silent" });
  kernel.register(optimizationPluginDef);
  await kernel.start([
    { name: "test", rows: [{ id: "opt", plugin: "@deyin/plugin-optimization", config: {} }] },
  ]);
  const status = await kernel.activatePlugin("@deyin/plugin-optimization");
  assert.equal(status.state, "failed");
  assert.match(status.error ?? "", /dataDir/);
});

test("disabled row leaves the plugin dormant", async () => {
  const kernel = new PluginKernel({ env, logLevel: "silent" });
  kernel.register(optimizationPluginDef);
  const statuses = await kernel.start([
    { name: "test", rows: [{ id: "opt", plugin: "@deyin/plugin-optimization", enabled: false }] },
  ]);
  assert.equal(statuses.find((s) => s.name === "@deyin/plugin-optimization")?.state, "registered");
  assert.equal(kernel.tryGet(Optimization), undefined);
});
