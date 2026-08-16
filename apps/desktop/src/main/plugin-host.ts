import { join } from "node:path";
import { app } from "electron";
import { computerUsePermissionRules, discoverPlugins, type PermissionRule, type ToolDefinition } from "@deyin/agent-core";
import type { AgentsStore, SettingsStore } from "@deyin/host-core";
import type { ToolRegistry } from "@deyin/agent-core";
import type { BrowserControlService } from "./browser.js";
import type { ChromeDebugService } from "./chrome-debug.js";
import type { ComputerUseService } from "./computer-use.js";
import type { VisualizeService } from "./visualize.js";
import { createVisualizeWriteTool } from "./visualize-tools.js";
import { isHostModuleEnabledFor } from "./host-module-gating.js";

export { isHostModuleEnabled, isHostModuleEnabledFor } from "./host-module-gating.js";

export function pluginsDir(): string {
  return join(app.getPath("userData"), "plugins");
}

export interface HostToolServices {
  browser: BrowserControlService;
  chrome?: ChromeDebugService;
  computerUse?: ComputerUseService;
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

  // One plugin scan per run, shared by all module gates (each gate would
  // otherwise re-walk the plugins directory and re-read every manifest).
  const plugins = await discoverPlugins(dir).catch(() => []);
  const enabled = (hostModule: Parameters<typeof isHostModuleEnabledFor>[1]) =>
    isHostModuleEnabledFor(plugins, hostModule, disabled);

  if (settings.get().browserControlEnabled && enabled("browser")) {
    for (const tool of services.browser.tools()) registry.register(tool);
  }
  if (services.chrome && settings.get().chromeDebugEnabled && enabled("chrome")) {
    for (const tool of services.chrome.tools()) registry.register(tool);
  }
  if (services.computerUse && settings.get().computerUseEnabled && enabled("computer-use")) {
    for (const tool of services.computerUse.tools()) registry.register(tool);
    extraRules.push(...computerUsePermissionRules().map((r) => ({ tool: r.tool, action: r.action as "ask" | "allow" })));
  }
  if (services.visualize && enabled("visualize")) {
    registry.register(createVisualizeWriteTool(services.visualize));
  }
  return extraRules;
}

export function collectHostTools(services: HostToolServices): ToolDefinition[] {
  return [
    ...services.browser.tools(),
    ...(services.chrome?.tools() ?? []),
    ...(services.computerUse?.tools() ?? []),
  ];
}
