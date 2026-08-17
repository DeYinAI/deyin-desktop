import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostEnvironment } from "@deyin/extension-api";
import { PluginKernel } from "@deyin/kernel";
import { bundleBase, registerBasePlugins } from "@deyin/bundle-base";
import { createDesktopProfile } from "../src/index.js";

const env: HostEnvironment = { app: "desktop", platform: "linux", userDataPath: "/tmp" };

test("desktop profile patches optimization config; stays lazy until activated", async () => {
  const kernel = registerBasePlugins(new PluginKernel({ env, logLevel: "silent" }));
  const statuses = await kernel.start([bundleBase, createDesktopProfile({ userDataPath: "/tmp/deyin-desktop-test" })]);
  assert.deepEqual(statuses.filter((s) => s.state === "failed"), []);
  const opt = statuses.find((s) => s.name === "@deyin/plugin-optimization");
  assert.equal(opt?.state, "lazy");
  assert.equal(opt?.source, "profile:desktop", "provenance shows the last layer to touch the row");
});
