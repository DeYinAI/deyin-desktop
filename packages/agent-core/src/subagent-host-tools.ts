import type { ToolDefinition } from "./types.js";

export interface HostToolSource {
  tools(): ToolDefinition[];
}

/** Host-registered tools a subagent allowlist may reference (browser_*, computer_*). */
export function hostToolsForSubagent(
  def: { tools?: string[] },
  services: { browser: HostToolSource; computerUse: HostToolSource },
  opts: { browserEnabled: boolean; computerUseEnabled: boolean },
): ToolDefinition[] {
  if (!def.tools?.length) return [];
  const allow = new Set(def.tools);
  const out: ToolDefinition[] = [];
  if (opts.browserEnabled) {
    for (const tool of services.browser.tools()) {
      if (allow.has(tool.name)) out.push(tool);
    }
  }
  if (opts.computerUseEnabled) {
    for (const tool of services.computerUse.tools()) {
      if (allow.has(tool.name)) out.push(tool);
    }
  }
  return out;
}
