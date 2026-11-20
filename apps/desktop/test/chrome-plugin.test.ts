import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { discoverPlugins } from "@deyin/agent-core";
import { ChromeBridge } from "../bundled-plugins/chrome/host/chrome-bridge.js";
import { ChromeControl } from "../bundled-plugins/chrome/host/chrome-control.js";
import { createChromeTools } from "../bundled-plugins/chrome/host/chrome-tools.js";
import { isHostModuleEnabledFor } from "../src/main/host-module-gating.js";

const bundledDir = join(dirname(fileURLToPath(import.meta.url)), "..", "bundled-plugins");
const pluginDir = join(bundledDir, "chrome");

function toolNames(): string[] {
  const dir = mkdtempSync(join(tmpdir(), "deyin-chrome-plugin-"));
  try {
    const bridge = new ChromeBridge({ dataDir: dir, ports: [0] });
    const control = new ChromeControl({
      bridge,
      approvedOriginsFile: join(dir, "approved.json"),
      strategy: () => "group",
      requestOriginApproval: async () => "deny",
    });
    return createChromeTools(control).map((t) => t.name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the chrome plugin is discovered as an enabled-by-default bundled host module on every platform", async () => {
  const plugins = await discoverPlugins(bundledDir);
  const chrome = plugins.find((p) => p.name === "chrome");
  assert.ok(chrome, "chrome plugin not discovered");
  assert.equal(chrome.hostModule, "chrome");
  assert.equal(chrome.bundled, true);
  assert.equal(chrome.platform, "all");
  assert.equal(isHostModuleEnabledFor(plugins, "chrome", new Set()), true);
  assert.equal(isHostModuleEnabledFor(plugins, "chrome", new Set(["plugin:chrome"])), false, "the user can switch the plugin off");
  assert.ok(existsSync(join(pluginDir, "logo.svg")));
});

test("every chrome tool is documented in the SKILL, and the SKILL names no tool that does not exist", () => {
  const skill = readFileSync(join(pluginDir, "skills", "chrome", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: chrome\n/);
  const documented = new Set(skill.match(/\bchrome_[a-z]+\b/g) ?? []);
  const real = new Set(toolNames());
  assert.deepEqual([...real].filter((n) => !documented.has(n)).sort(), [], "tools missing from the SKILL");
  assert.deepEqual([...documented].filter((n) => !real.has(n)).sort(), [], "SKILL mentions unknown tools");
});

test("chrome tool names are unique and share one prefix, so automation policy can match them", () => {
  const names = toolNames();
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((n) => n.startsWith("chrome_")));
});

test("the shipped extension carries its pinned key and no site access of its own", () => {
  const manifest = JSON.parse(readFileSync(join(pluginDir, "extension", "manifest.json"), "utf8")) as {
    key?: string;
    permissions?: string[];
    host_permissions?: string[];
    content_scripts?: unknown;
  };
  assert.ok(manifest.key, "a pinned key keeps the extension id the relay accepts");
  assert.equal(manifest.host_permissions, undefined, "no ambient host access");
  assert.equal(manifest.content_scripts, undefined, "nothing is injected into pages");
  assert.deepEqual([...(manifest.permissions ?? [])].sort(), ["alarms", "debugger", "storage", "tabGroups", "tabs"]);
});
