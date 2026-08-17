import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostEnvironment } from "@deyin/extension-api";
import { PluginKernel } from "@deyin/kernel";
import { bundleBase, registerBasePlugins } from "@deyin/bundle-base";
import { headlessProfile } from "../src/index.js";

const env: HostEnvironment = { app: "cli", platform: "linux", userDataPath: "/tmp" };

test("headless profile disables optimization entirely", async () => {
  const kernel = registerBasePlugins(new PluginKernel({ env, logLevel: "silent" }));
  const statuses = await kernel.start([bundleBase, headlessProfile]);
  assert.deepEqual(statuses.filter((s) => s.state === "failed"), []);
  assert.equal(statuses.find((s) => s.name === "@deyin/plugin-optimization")?.state, "registered");
});
