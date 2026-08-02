import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isHostModuleEnabled } from "../src/main/host-module-gating.js";

function writePlugin(dir: string, name: string, hostModule: string): void {
  const pluginDir = join(dir, name);
  mkdirSync(join(pluginDir, ".deyin-plugin"), { recursive: true });
  writeFileSync(
    join(pluginDir, ".deyin-plugin", "plugin.json"),
    JSON.stringify({ name, hostModule, bundled: true }),
  );
  writeFileSync(join(pluginDir, ".deyin-install.json"), JSON.stringify({ source: "bundled" }));
}

test("isHostModuleEnabled defaults browser on when plugin dir is empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-ph-"));
  try {
    assert.equal(await isHostModuleEnabled(dir, "browser", new Set()), true);
    assert.equal(await isHostModuleEnabled(dir, "chrome", new Set()), false);
    assert.equal(await isHostModuleEnabled(dir, "computer-use", new Set()), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isHostModuleEnabled respects discovered hostModule plugins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-ph-"));
  try {
    writePlugin(dir, "bundled-chrome", "chrome");
    writePlugin(dir, "bundled-computer-use", "computer-use");

    assert.equal(await isHostModuleEnabled(dir, "chrome", new Set()), true);
    assert.equal(await isHostModuleEnabled(dir, "computer-use", new Set()), true);
    assert.equal(await isHostModuleEnabled(dir, "visualize", new Set()), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isHostModuleEnabled returns false when capability is disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-ph-"));
  try {
    writePlugin(dir, "bundled-browser", "browser");
    writePlugin(dir, "bundled-visualize", "visualize");

    const disabled = new Set(["plugin:bundled-browser", "plugin:bundled-visualize"]);
    assert.equal(await isHostModuleEnabled(dir, "browser", disabled), false);
    assert.equal(await isHostModuleEnabled(dir, "visualize", disabled), false);
    assert.equal(await isHostModuleEnabled(dir, "chrome", disabled), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
