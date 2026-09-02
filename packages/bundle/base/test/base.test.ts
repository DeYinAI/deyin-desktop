import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostEnvironment } from "@deyin/extension-api";
import { PluginKernel } from "@deyin/kernel";
import { bundleBase, registerBasePlugins } from "../src/index.js";
import { Tools } from "@deyin/tools";
import { Llm } from "@deyin/llm";
import { BUILTIN_TOOLS } from "@deyin/agent-core";

const env: HostEnvironment = { app: "desktop", platform: "linux", userDataPath: "/tmp" };

test("bundle:base activates every row and fills the tool catalog", async () => {
  const kernel = registerBasePlugins(new PluginKernel({ env, logLevel: "silent" }));
  const statuses = await kernel.start([bundleBase]);
  const failed = statuses.filter((s) => s.state === "failed");
  assert.deepEqual(failed, [], `no plugin may fail: ${JSON.stringify(failed)}`);
  // Optimization is intentionally lazy.
  assert.equal(statuses.find((s) => s.name === "@deyin/plugin-optimization")?.state, "lazy");

  const names = kernel.get(Tools).names().sort();
  // Every builtin tool family present: fs + shell + git + web + plan + agent.
  // Note git is read-tier only — the mutating git tools go through bash.
  for (const expected of ["bash", "read", "write", "edit", "grep", "git_status", "git_diff", "websearch", "web_fetch", "todo_write", "report_goal_met", "skill", "ask_question"]) {
    assert.ok(names.includes(expected), `catalog must contain "${expected}"; got ${names.join(", ")}`);
  }
  // Catalog covers exactly the BUILTIN_TOOLS set — no drift allowed between
  // the family plugins and the agent-core builtin list.
  const builtin = BUILTIN_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, builtin);

  const llm = kernel.get(Llm);
  assert.equal(llm.formats().length, 3);
  assert.equal(typeof llm.resolve("anthropic"), "function");
});

test("a user layer can disable a whole tool family by row id", async () => {
  const kernel = registerBasePlugins(new PluginKernel({ env, logLevel: "silent" }));
  await kernel.start([
    bundleBase,
    { name: "user", rows: [{ id: "tools-git", plugin: "@deyin/plugin-tools-git", enabled: false }] },
  ]);
  const names = kernel.get(Tools).names();
  assert.ok(!names.includes("git_status"), "disabling the family row removes its tools");
  assert.ok(names.includes("bash"), "other families stay");
});
