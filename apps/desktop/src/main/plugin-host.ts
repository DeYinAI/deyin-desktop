import { join } from "node:path";
import { app } from "electron";
import { computerUsePermissionRules, type PermissionRule, type ToolDefinition } from "@deyin/agent-core";
import type { AgentsStore, SettingsStore } from "@deyin/host-core";
import type { ToolRegistry } from "@deyin/agent-core";
import type { BrowserControlService } from "./browser.js";
import type { ChromeDebugService } from "./chrome-debug.js";
import type { ComputerUseService } from "./computer-use.js";
import type { VisualizeService } from "./visualize.js";
import { createVisualizeWriteTool } from "./visualize-tools.js";
import { isHostModuleEnabled } from "./host-module-gating.js";

export { isHostModuleEnabled } from "./host-module-gating.js";

export function pluginsDir(): string {
  return join(app.getPath("userData"), "plugins");
}

export interface HostToolServices {
  browser: BrowserControlService;
  chrome: ChromeDebugService;
  computerUse: ComputerUseService;
  visualize?: VisualizeService;
}

/** Register tools from enabled bundled host modules (browser, chrome, computer-use). */
export async function registerBundledHostTools(
  registry: ToolRegistry,
  agents: AgentsStore,
  settings: SettingsStore,
  services: HostToolServices,
): Promise<PermissionRule[]> {
  const dir = pluginsDir();
  const disabled = agents.disabledCaps();
  const extraRules: PermissionRule[] = [];

  if (settings.get().browserControlEnabled && (await isHostModuleEnabled(dir, "browser", disabled))) {
    for (const tool of services.browser.tools()) registry.register(tool);
  }
  if (settings.get().chromeDebugEnabled && (await isHostModuleEnabled(dir, "chrome", disabled))) {
    for (const tool of services.chrome.tools()) registry.register(tool);
  }
  if (settings.get().computerUseEnabled && (await isHostModuleEnabled(dir, "computer-use", disabled))) {
    for (const tool of services.computerUse.tools()) registry.register(tool);
    extraRules.push(...computerUsePermissionRules().map((r) => ({ tool: r.tool, action: r.action as "ask" | "allow" })));
  }
  if (services.visualize && (await isHostModuleEnabled(dir, "visualize", disabled))) {
    registry.register(createVisualizeWriteTool(services.visualize));
  }
  return extraRules;
}

export function collectHostTools(services: HostToolServices): ToolDefinition[] {
  return [...services.browser.tools(), ...services.chrome.tools(), ...services.computerUse.tools()];
}
