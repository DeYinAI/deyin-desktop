import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { HostEnvironment } from "@deyin/extension-api";
import { PluginKernel } from "@deyin/kernel";
import { Capabilities, capsLocalPlugin } from "../src/index.js";

const env: HostEnvironment = { app: "web", platform: process.platform, userDataPath: tmpdir() };
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("caps-local scans a sandbox-scoped workspace without touching the real home", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "deyin-caps-"));
  dirs.push(sandbox);
  // One workspace skill inside the sandbox.
  mkdirSync(join(sandbox, ".deyin", "skills", "deploy"), { recursive: true });
  writeFileSync(
    join(sandbox, ".deyin", "skills", "deploy", "SKILL.md"),
    "---\nname: deploy\ndescription: How to deploy this sandbox app\n---\nRun the deploy script.\n",
  );

  const kernel = new PluginKernel({ env, logLevel: "silent" });
  kernel.register(capsLocalPlugin);
  const statuses = await kernel.start([
    {
      name: "test",
      rows: [
        {
          id: "caps",
          plugin: capsLocalPlugin.name,
          // Sandbox-scoped: userDir points into the sandbox, never homedir().
          config: { cwd: sandbox, userDir: sandbox, eager: true },
        },
      ],
    },
  ]);
  assert.equal(statuses.find((s) => s.name === capsLocalPlugin.name)?.state, "active");
  const snapshot = kernel.get(Capabilities).snapshot();
  assert.ok(snapshot, "eager scan should populate the snapshot");
  assert.ok(
    snapshot!.skills.some((s) => s.name === "deploy"),
    `expected the sandbox skill, got: ${snapshot!.skills.map((s) => s.name).join(", ")}`,
  );
});

test("missing config fails the plugin in isolation", async () => {
  const kernel = new PluginKernel({ env, logLevel: "silent" });
  kernel.register(capsLocalPlugin);
  const statuses = await kernel.start([
    { name: "test", rows: [{ id: "caps", plugin: capsLocalPlugin.name }] },
  ]);
  const status = statuses.find((s) => s.name === capsLocalPlugin.name);
  assert.equal(status?.state, "failed");
  assert.match(status?.error ?? "", /requires config/);
});
