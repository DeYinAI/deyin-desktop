import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentsStore } from "@deyin/host-core";
import {
  connectMcpServer,
  materializeBuiltinSkills,
  scanCapabilities,
  userDeyinDir,
  type CapabilitySnapshot,
  type McpServerDefinition,
  type OAuthClientProvider,
} from "@deyin/agent-core";
import type { CapabilityItem, CapabilityKind, McpServerEntry, McpServerInput, McpTestResult } from "../shared/types.js";
import type { McpModuleService } from "./mcp-modules.js";
import type { McpOAuthService } from "./mcp-oauth.js";

const SCAN_TTL_MS = 4_000;

/** Built-in MCP-style servers the desktop host provides in-process. */
export const BUILTIN_MCP_NAMES = { browser: "deyin-browser", search: "deyin-search" } as const;

/**
 * The desktop's live capability registry: filesystem scan (workspace + user +
 * plugins) merged with the persisted disabled set from agents.json. Also owns
 * the user-level mcp.json that "Add custom server" writes to.
 */
export class CapabilityService {
  private cache: CapabilitySnapshot | null = null;
  private cacheKey = "";
  private cacheAt = 0;
  private mcpModules: McpModuleService | null = null;
  private mcpOAuth: McpOAuthService | null = null;

  constructor(
    private readonly agents: AgentsStore,
    private readonly getWorkspaceRoot: () => string | null,
    private readonly pluginsDir: string,
    private readonly builtinSkillsDir: string,
  ) {
    // Ship the default skills as real files so they read/override like any other.
    try {
      materializeBuiltinSkills(builtinSkillsDir);
    } catch {
      // A read-only data dir must not break startup; built-ins just stay absent.
    }
  }

  invalidate(): void {
    this.cache = null;
  }

  setMcpModules(modules: McpModuleService): void {
    this.mcpModules = modules;
  }

  setMcpOAuth(oauth: McpOAuthService): void {
    this.mcpOAuth = oauth;
  }

  /** OAuth provider for a catalog module installed with native OAuth. */
  getAuthProvider(serverName: string): OAuthClientProvider | undefined {
    if (!this.mcpOAuth || !this.mcpModules) return undefined;
    if (!this.moduleUsesNativeOAuth(serverName)) return undefined;
    return this.mcpOAuth.getProvider(serverName);
  }

  moduleUsesNativeOAuth(serverName: string): boolean {
    const manifest = this.mcpModules?.get(serverName);
    if (!manifest) return false;
    return manifest.authMode === "oauth" || Boolean(manifest.usesNativeOAuth);
  }

  async snapshot(): Promise<CapabilitySnapshot> {
    const key = this.getWorkspaceRoot() ?? "";
    if (this.cache && this.cacheKey === key && Date.now() - this.cacheAt < SCAN_TTL_MS) return this.cache;
    this.cache = await scanCapabilities({
      cwd: this.getWorkspaceRoot(),
      pluginsDir: this.pluginsDir,
      builtinSkillsDir: this.builtinSkillsDir,
      builtinMcpServers: [
        {
          name: BUILTIN_MCP_NAMES.browser,
          transport: "stdio",
          enabled: true,
          source: "built-in",
        },
        {
          name: BUILTIN_MCP_NAMES.search,
          transport: "stdio",
          enabled: true,
          source: "built-in",
        },
      ],
    });
    this.cacheKey = key;
    this.cacheAt = Date.now();
    return this.cache;
  }

  enabled(id: string): boolean {
    return !this.agents.disabledCaps().has(id);
  }

  toggle(id: string, enabled: boolean): void {
    this.agents.setCapEnabled(id, enabled);
  }

  /** Flat CapabilityItem list for the settings pages. */
  async listItems(kind?: CapabilityKind): Promise<CapabilityItem[]> {
    const snap = await this.snapshot();
    const disabled = this.agents.disabledCaps();
    const items: CapabilityItem[] = [];

    for (const plugin of snap.plugins) {
      items.push({
        id: `plugin:${plugin.name}`,
        kind: "plugin",
        name: plugin.name,
        description: plugin.description ?? "Installed plugin.",
        enabled: !disabled.has(`plugin:${plugin.name}`),
        version: plugin.version,
        source: plugin.source,
        path: plugin.dir,
      });
    }
    for (const skill of snap.skills) {
      items.push({
        id: `skill:${skill.name}`,
        kind: "skill",
        name: skill.name,
        description: skill.description,
        enabled: !disabled.has(`skill:${skill.name}`),
        source: skill.source,
        path: skill.path,
      });
    }
    for (const command of snap.commands) {
      items.push({
        id: `command:${command.name}`,
        kind: "command",
        name: `/${command.name}`,
        description: command.description,
        enabled: !disabled.has(`command:${command.name}`),
        source: command.source,
        path: command.path,
      });
    }
    for (const subagent of snap.subagents) {
      items.push({
        id: `subagent:${subagent.name}`,
        kind: "subagent",
        name: subagent.name,
        description: subagent.description,
        enabled: !disabled.has(`subagent:${subagent.name}`),
        source: subagent.source,
        path: subagent.path,
      });
    }
    for (const server of snap.mcpServers) {
      items.push({
        id: `mcp:${server.name}`,
        kind: "mcp",
        name: server.name,
        description: describeMcp(server),
        enabled: !disabled.has(`mcp:${server.name}`) && server.enabled,
        source: server.source,
        path: server.path,
        detail: server.transport === "stdio" ? [server.command, ...(server.args ?? [])].join(" ") : server.url,
      });
    }
    for (const hook of snap.hooks) {
      const id = `hook:${hook.source}:${hook.event}:${shortHash(hook.command)}`;
      items.push({
        id,
        kind: "hook",
        name: hook.event,
        description: `Runs \`${hook.command}\`${hook.matcher ? ` when /${hook.matcher}/ matches` : ""}.`,
        enabled: !disabled.has(id),
        source: hook.source,
        path: hook.path,
        detail: hook.command,
      });
    }

    return kind ? items.filter((i) => i.kind === kind) : items;
  }

  /** Enabled skills/commands/subagents/hooks/servers for an agent run. */
  async enabledForRun() {
    const snap = await this.snapshot();
    const disabled = this.agents.disabledCaps();
    const pluginEnabled = (source: string) =>
      !source.startsWith("plugin:") || !disabled.has(`plugin:${source.slice("plugin:".length)}`);
    return {
      skills: snap.skills.filter((s) => !disabled.has(`skill:${s.name}`) && pluginEnabled(s.source)),
      commands: snap.commands.filter((c) => !disabled.has(`command:${c.name}`) && pluginEnabled(c.source)),
      subagents: snap.subagents.filter((s) => !disabled.has(`subagent:${s.name}`) && pluginEnabled(s.source)),
      hooks: snap.hooks.filter((h) => !disabled.has(`hook:${h.source}:${h.event}:${shortHash(h.command)}`)),
      mcpServers: snap.mcpServers.filter(
        (s) =>
          s.enabled &&
          !disabled.has(`mcp:${s.name}`) &&
          pluginEnabled(s.source) &&
          s.name !== BUILTIN_MCP_NAMES.browser &&
          s.name !== BUILTIN_MCP_NAMES.search,
      ),
      browserEnabled: !disabled.has(`mcp:${BUILTIN_MCP_NAMES.browser}`),
      searchEnabled: !disabled.has(`mcp:${BUILTIN_MCP_NAMES.search}`),
    };
  }

  /** Substitute ${VAR} plugin secrets into a plugin-bundled server definition. */
  resolvePluginVariables(def: McpServerDefinition): McpServerDefinition {
    if (!def.source.startsWith("plugin:")) return def;
    const secrets = this.agents.getPluginSecrets(def.source.slice("plugin:".length));
    if (Object.keys(secrets).length === 0) return def;
    const apply = (value: string) =>
      value.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, name: string) => secrets[name] ?? all);
    const applyRecord = (record?: Record<string, string>) =>
      record ? Object.fromEntries(Object.entries(record).map(([k, v]) => [k, apply(v)])) : undefined;
    return {
      ...def,
      command: def.command ? apply(def.command) : undefined,
      args: def.args?.map(apply),
      env: applyRecord(def.env),
      url: def.url ? apply(def.url) : undefined,
      headers: applyRecord(def.headers),
    };
  }

  /* MCP settings surface --------------------------------------------------- */

  async listMcpServers(): Promise<McpServerEntry[]> {
    const snap = await this.snapshot();
    const disabled = this.agents.disabledCaps();
    return snap.mcpServers.map((server) => ({
      id: `mcp:${server.name}`,
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      enabled: !disabled.has(`mcp:${server.name}`) && server.enabled,
      source: server.source,
      path: server.path,
    }));
  }

  private userMcpFile(): string {
    return join(userDeyinDir(homedir()), "mcp.json");
  }

  /** Add a custom MCP server as an installable module under ~/.deyin/mcp-modules/<id>/. */
  addMcpServer(input: McpServerInput): void {
    if (!this.mcpModules) throw new Error("MCP module service is not initialized.");
    this.mcpModules.installCustom(input);
    this.invalidate();
  }

  /** Remove a user MCP module or legacy flat mcp.json entry. */
  removeMcpServer(name: string): void {
    if (this.mcpModules?.has(name)) {
      this.mcpModules.uninstall(name);
      this.invalidate();
      return;
    }
    const file = this.userMcpFile();
    let parsed: { mcpServers?: Record<string, unknown> } = {};
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.mcpServers && name in parsed.mcpServers) {
      delete parsed.mcpServers[name];
      writeFileSync(file, JSON.stringify(parsed, null, 2), { encoding: "utf8", mode: 0o600 });
      this.invalidate();
    }
  }

  /** Connect to a server, list its tools, disconnect. */
  async testMcpServer(name: string): Promise<McpTestResult> {
    const snap = await this.snapshot();
    const def = snap.mcpServers.find((s) => s.name === name);
    if (!def) return { ok: false, message: `Unknown server "${name}".` };
    if (def.name === BUILTIN_MCP_NAMES.browser) return { ok: true, toolCount: 8, message: "Built-in browser control (in-process)." };
    if (def.name === BUILTIN_MCP_NAMES.search) return { ok: true, toolCount: 1, message: "Built-in web search (in-process)." };
    if (this.moduleUsesNativeOAuth(name) && !this.mcpOAuth?.isAuthenticated(name)) {
      return { ok: false, message: "Not authenticated — click Authenticate in Settings." };
    }
    try {
      const resolved = this.resolvePluginVariables(def);
      const { tools, close } = await connectMcpServer(resolved, { authProvider: this.getAuthProvider(name) });
      await close();
      return { ok: true, toolCount: tools.length, tools: tools.map((t) => t.name).slice(0, 40) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}

function describeMcp(server: McpServerDefinition): string {
  if (server.name === BUILTIN_MCP_NAMES.browser) return "Built-in browser control: navigate, click, type, screenshot the workspace Browser tab.";
  if (server.name === BUILTIN_MCP_NAMES.search) return "Built-in free web search exposed to agent sessions.";
  return server.transport === "stdio"
    ? `Local MCP server (stdio).`
    : `Remote MCP server (${server.transport.toUpperCase()}).`;
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}
