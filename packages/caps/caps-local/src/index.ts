/**
 * @deyin/plugin-caps-local — the capabilities loader plugin. Wraps
 * agent-core's directory scan (skills, commands, subagents, hooks, MCP,
 * installed plugins) as a kernel service. On multi-tenant hosts (web), pass
 * a sandbox-scoped `userDir`/`pluginsDir` so a session never scans the
 * server's real home.
 */
import { defineService, type PluginDefinition } from "@deyin/extension-api";
import { scanCapabilities, type CapabilitySnapshot } from "@deyin/agent-core";

export interface CapsLocalConfig {
  /** Workspace root; null scans user-level capabilities only. */
  cwd: string | null;
  /** Home-equivalent root (default: the real homedir — override for sandboxes). */
  userDir?: string;
  /** Installed-plugins dir, e.g. `<userData>/plugins` or `<sandbox>/plugins`. */
  pluginsDir?: string;
  /** Materialized built-in skills dir (see materializeBuiltinSkills). */
  builtinSkillsDir?: string;
  /** Extra built-in MCP servers the host injects (browser, search). */
  builtinMcpServers?: CapabilitySnapshot["mcpServers"];
  /** Workspace trust decision (gates env interpolation in workspace mcp.json). */
  trustedWorkspace?: boolean;
  /** Scan once at activation (default true). Set false to defer to first read. */
  eager?: boolean;
}

export interface CapabilityScanner {
  refresh(): Promise<CapabilitySnapshot>;
  snapshot(): CapabilitySnapshot | undefined;
}

export function createCapabilityScanner(config: CapsLocalConfig): CapabilityScanner {
  let current: CapabilitySnapshot | undefined;
  return {
    async refresh() {
      current = await scanCapabilities({
        cwd: config.cwd,
        userDir: config.userDir,
        pluginsDir: config.pluginsDir,
        builtinSkillsDir: config.builtinSkillsDir,
        builtinMcpServers: config.builtinMcpServers,
        trustedWorkspace: config.trustedWorkspace,
      });
      return current;
    },
    snapshot() {
      return current;
    },
  };
}

export const Capabilities = defineService<CapabilityScanner>(
  "capabilities",
  "scanned skills/commands/subagents/hooks/mcp/plugins",
);

export const capsLocalPlugin: PluginDefinition<CapsLocalConfig> = {
  name: "@deyin/plugin-caps-local",
  provides: ["capabilities"],
  apply: async (ctx, config) => {
    if (!config) throw new Error("caps-local plugin requires config: { cwd: string | null, ... }");
    const scanner = createCapabilityScanner(config);
    ctx.provide(Capabilities, scanner);
    if (config.eager !== false) await scanner.refresh();
  },
};
