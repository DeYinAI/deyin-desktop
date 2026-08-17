import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { HostEnvironment } from "@deyin/extension-api";
import { PluginKernel } from "@deyin/kernel";
import { bundleBase, registerBasePlugins } from "@deyin/bundle-base";
import { capsLocalPlugin, Capabilities } from "@deyin/plugin-caps-local";
import { createWebProfile } from "../src/index.js";

const env: HostEnvironment = { app: "web", platform: process.platform, userDataPath: tmpdir() };
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("web profile composes over base and scans sandbox capabilities", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "deyin-web-"));
  dirs.push(sandbox);
  mkdirSync(join(sandbox, ".deyin", "skills", "release"), { recursive: true });
  writeFileSync(
    join(sandbox, ".deyin", "skills", "release", "SKILL.md"),
    "---\nname: release\ndescription: Release checklist\n---\nCut a release.\n",
  );

  const kernel = registerBasePlugins(new PluginKernel({ env, logLevel: "silent" }));
  kernel.register(capsLocalPlugin);
  const statuses = await kernel.start([bundleBase, createWebProfile({ sandboxRoot: sandbox })]);
  const failed = statuses.filter((s) => s.state === "failed");
  assert.deepEqual(failed, [], JSON.stringify(failed));
  const snapshot = kernel.get(Capabilities).snapshot();
  assert.ok(snapshot?.skills.some((s) => s.name === "release"), "sandbox skill must be scanned");
});
