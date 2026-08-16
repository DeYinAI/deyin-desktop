import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { discoverCommands, type CommandDefinition } from "./commands.js";
import { loadHooks, type LoadedHook } from "./hooks.js";
import { interpolate, loadMcpServers, type McpServerDefinition } from "./mcp-config.js";
import { commandRoots, skillRoots, subagentRoots, type CapabilityRoot } from "./paths.js";
import { discoverPlugins, type InstalledPlugin } from "./plugins.js";
import { discoverSkills, loadSkill, type SkillDefinition } from "./skills.js";
import { discoverSubagents, type SubagentDefinition } from "./subagents.js";

/**
 * The live capability registry: one scan that merges workspace + user + plugin
 * definitions of every kind. Precedence on name collisions is scan order —
 * workspace > user > plugins > built-ins. Enable/disable state is *not* stored
 * here; hosts keep a disabled-id set and filter the snapshot.
 */

export interface CapabilitySnapshot {
  skills: SkillDefinition[];
  commands: CommandDefinition[];
  subagents: SubagentDefinition[];
  hooks: LoadedHook[];
  mcpServers: McpServerDefinition[];
  plugins: InstalledPlugin[];
  scannedAt: number;
}

export interface ScanOptions {
  cwd: string | null;
  /** Home override (tests). */
  userDir?: string;
  /** Directory of installed plugins, e.g. `<userData>/plugins`. */
  pluginsDir?: string;
  /** Directory of materialized built-in skills (see materializeBuiltinSkills). */
  builtinSkillsDir?: string;
  /** Extra built-in MCP servers the host injects (browser, search). */
  builtinMcpServers?: McpServerDefinition[];
  /** Workspace trust decision (gates env interpolation in workspace mcp.json). */
  trustedWorkspace?: boolean;
}

export async function scanCapabilities(opts: ScanOptions): Promise<CapabilitySnapshot> {
  const userDir = opts.userDir ?? homedir();
  const plugins = opts.pluginsDir ? await discoverPlugins(opts.pluginsDir) : [];

  const pluginSkillRoots: CapabilityRoot[] = plugins
    .filter((p) => p.skillsDir)
    .map((p) => ({ dir: p.skillsDir!, source: `plugin:${p.name}` }));
  const pluginCommandRoots: CapabilityRoot[] = plugins
    .filter((p) => p.commandsDir)
    .map((p) => ({ dir: p.commandsDir!, source: `plugin:${p.name}` }));
  const pluginAgentRoots: CapabilityRoot[] = plugins
    .filter((p) => p.agentsDir)
    .map((p) => ({ dir: p.agentsDir!, source: `plugin:${p.name}` }));

  // Built-ins scan last so workspace/user/plugin skills of the same name win.
  const builtinSkillRoots: CapabilityRoot[] = opts.builtinSkillsDir
    ? [{ dir: opts.builtinSkillsDir, source: "built-in" }]
    : [];

  // Plugin-bundled hooks.json files load alongside workspace/user hooks.
  const pluginHookFiles = plugins
    .filter((plugin) => plugin.hooksFile)
    .map((plugin) => ({ path: plugin.hooksFile!, source: `plugin:${plugin.name}` }));

  const [skills, commands, subagents, hooks, mcpServers] = await Promise.all([
    discoverSkills([...skillRoots(opts.cwd, userDir), ...pluginSkillRoots, ...builtinSkillRoots]),
    discoverCommands([...commandRoots(opts.cwd, userDir), ...pluginCommandRoots]),
    discoverSubagents([...subagentRoots(opts.cwd, userDir), ...pluginAgentRoots]),
    loadHooks(opts.cwd, userDir, pluginHookFiles),
    loadMcpServers(opts.cwd, { trustedWorkspace: opts.trustedWorkspace === true }, userDir),
  ]);

  // Single-skill plugins: a root SKILL.md acts as the plugin's one skill.
  for (const plugin of plugins) {
    if (!plugin.rootSkill) continue;
    const skill = await loadSkill(plugin.rootSkill, `plugin:${plugin.name}`);
    if (skill && !skills.some((s) => s.name === skill.name)) skills.push(skill);
  }

  // Plugin-bundled MCP servers (workspace/user files win on name conflicts).
  const pluginMcp = await loadPluginMcpServers(plugins, opts.cwd);
  for (const server of pluginMcp) {
    if (!mcpServers.some((s) => s.name === server.name)) mcpServers.push(server);
  }

  for (const server of opts.builtinMcpServers ?? []) {
    if (!mcpServers.some((s) => s.name === server.name)) mcpServers.push(server);
  }

  return { skills, commands, subagents, hooks, mcpServers, plugins, scannedAt: Date.now() };
}

async function loadPluginMcpServers(plugins: InstalledPlugin[], cwd: string | null): Promise<McpServerDefinition[]> {
  const out: McpServerDefinition[] = [];
  for (const plugin of plugins) {
    if (!plugin.mcpFile) continue;
    try {
      const parsed = JSON.parse(await readFile(plugin.mcpFile, "utf8")) as {
        mcpServers?: Record<string, { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }>;
      };
      for (const [name, raw] of Object.entries(parsed.mcpServers ?? {})) {
        const ctx = { workspaceFolder: cwd, pluginDir: plugin.dir };
        const apply = (v: string) => interpolate(v, ctx);
        const applyRecord = (record?: Record<string, string>) =>
          record ? Object.fromEntries(Object.entries(record).map(([k, v]) => [k, apply(v)])) : undefined;
        if (raw.url) {
          out.push({
            name,
            transport: raw.type === "sse" || raw.url.endsWith("/sse") ? "sse" : "http",
            url: apply(raw.url),
            headers: applyRecord(raw.headers),
            enabled: true,
            source: `plugin:${plugin.name}`,
            path: plugin.mcpFile,
          });
        } else if (raw.command) {
          out.push({
            name,
            transport: "stdio",
            command: apply(raw.command),
            args: (raw.args ?? []).map(apply),
            env: applyRecord(raw.env),
            enabled: true,
            source: `plugin:${plugin.name}`,
            path: plugin.mcpFile,
          });
        }
      }
    } catch {
      // Malformed plugin mcp.json is skipped, never fatal.
    }
  }
  return out;
}
