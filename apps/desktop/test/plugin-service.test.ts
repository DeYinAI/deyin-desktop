import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentsStore, Storage } from "@deyin/host-core";
import { PluginService } from "../src/main/plugins.js";
import type { CapabilityService } from "../src/main/capabilities.js";

/** Just the store surface PluginService touches: the disabled set and plugin secrets. */
function fakeAgents(disabled: string[]) {
  const set = new Set(disabled);
  return {
    disabled: set,
    store: {
      disabledCaps: () => new Set(set),
      setCapEnabled: (id: string, enabled: boolean) => {
        if (enabled) set.delete(id);
        else set.add(id);
      },
      removePluginSecrets: () => undefined,
    } as unknown as AgentsStore,
  };
}

test("uninstalling a switched-off plugin clears its disabled flag so a reinstall comes back on", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-plugin-service-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "toolkit", ".deyin-plugin"), { recursive: true });
  writeFileSync(join(dir, "toolkit", ".deyin-plugin", "plugin.json"), JSON.stringify({ name: "toolkit", version: "1.0.0" }));

  const agents = fakeAgents(["plugin:toolkit", "plugin:other"]);
  const capabilities = { invalidate: () => undefined } as unknown as CapabilityService;
  const service = new PluginService(dir, {} as Storage, agents.store, capabilities);

  const before = await service.list();
  assert.equal(before.find((p) => p.name === "toolkit")?.enabled, false);

  await service.uninstall("toolkit");

  assert.ok(!existsSync(join(dir, "toolkit")));
  assert.equal(agents.disabled.has("plugin:toolkit"), false);
  // Other plugins' switches are untouched.
  assert.equal(agents.disabled.has("plugin:other"), true);
});
