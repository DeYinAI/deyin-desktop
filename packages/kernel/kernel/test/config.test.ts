import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/config.js";
import { matchesActivation } from "../src/kernel.js";

test("later layers merge into earlier rows by id", () => {
  const resolved = resolveConfig([
    {
      name: "bundle:base",
      rows: [
        { id: "tools-git", plugin: "@deyin/plugin-tools-git", config: { safe: true } },
        { id: "tools-web", plugin: "@deyin/plugin-tools-web" },
      ],
    },
    {
      name: "profile:desktop",
      rows: [{ id: "tools-git", plugin: "@deyin/plugin-tools-git", config: { safe: false } }],
    },
  ]);
  assert.equal(resolved.rows.length, 2);
  const git = resolved.rows.find((r) => r.id === "tools-git");
  assert.deepEqual(git?.config, { safe: false }, "patched field replaces, others kept");
  assert.equal(resolved.provenance.get("tools-git"), "profile:desktop");
});

test("replace mode swaps the whole row", () => {
  const resolved = resolveConfig([
    { name: "base", rows: [{ id: "llm", plugin: "a", config: { x: 1 } }] },
    { name: "user", mode: "replace", rows: [{ id: "llm", plugin: "b" }] },
  ]);
  const llm = resolved.rows.find((r) => r.id === "llm");
  assert.equal(llm?.plugin, "b");
  assert.equal(llm?.config, undefined);
});

test("disabled rows drop out but keep provenance", () => {
  const resolved = resolveConfig([
    { name: "base", rows: [{ id: "a", plugin: "a" }, { id: "b", plugin: "b" }] },
    { name: "user", rows: [{ id: "b", plugin: "b", enabled: false }] },
  ]);
  assert.deepEqual(resolved.rows.map((r) => r.id), ["a"]);
  assert.equal(resolved.provenance.get("b"), "user");
});

test("activation patterns match exactly or by prefix", () => {
  assert.equal(matchesActivation("onTool:git", "onTool:git"), true);
  assert.equal(matchesActivation("onTool:git", "onTool:git:status"), false);
  assert.equal(matchesActivation("onTool:git*", "onTool:git:status"), true);
  assert.equal(matchesActivation("onTool:git*", "onTool:fs"), false);
  assert.equal(matchesActivation("onStartup", "onStartup"), true);
});
