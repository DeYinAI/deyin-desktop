import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeBundledPlugins } from "../src/capabilities/bundled-plugins.js";
import { discoverPlugins } from "../src/capabilities/plugins.js";

test("materializeBundledPlugins copies bundled plugins and stamps install meta", async () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-bundled-"));
  const src = join(root, "src");
  const dest = join(root, "dest");
  mkdirSync(join(src, "demo", ".deyin-plugin"), { recursive: true });
  writeFileSync(
    join(src, "demo", ".deyin-plugin", "plugin.json"),
    JSON.stringify({ name: "demo", version: "1.0.0", bundled: true, hostModule: "browser" }),
  );
  mkdirSync(join(src, "demo", "skills", "demo"), { recursive: true });
  writeFileSync(join(src, "demo", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");

  const n = materializeBundledPlugins(src, dest);
  assert.equal(n, 1);
  const meta = JSON.parse(readFileSync(join(dest, "bundled-demo", ".deyin-install.json"), "utf8")) as { source: string };
  assert.equal(meta.source, "bundled");

  const plugins = await discoverPlugins(dest);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0]?.hostModule, "browser");

  rmSync(root, { recursive: true, force: true });
});
