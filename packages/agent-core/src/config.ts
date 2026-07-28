import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, DEFAULT_MODELS } from "@deyin/host-core";
import { BUILTIN_AGENTS, type AgentDefinition } from "./agents.js";
import type { PermissionRule } from "./permissions.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface CustomAgentConfig {
  description?: string;
  prompt: string;
  model?: string;
  permissions?: PermissionRule[];
  maxSteps?: number;
}

/** Shape of ~/.deyin/config.json and <project>/deyin.json (all fields optional). */
export interface DeyinCliConfigFile {
  model?: string;
  agent?: string;
  oauthIssuer?: string;
  apiBaseUrl?: string;
  clientId?: string;
  thinking?: boolean;
  maxSteps?: number;
  permissions?: PermissionRule[];
  agents?: Record<string, CustomAgentConfig>;
  mcpServers?: Record<string, McpServerConfig>;
}

export interface ResolvedCliConfig {
  model: string;
  agent: string;
  oauthIssuer: string;
  apiBaseUrl: string;
  clientId: string;
  thinking: boolean;
  maxSteps: number;
  permissions: PermissionRule[];
  agents: Record<string, CustomAgentConfig>;
  mcpServers: Record<string, McpServerConfig>;
  /** Which files/layers contributed, for `deyin config` style debugging. */
  sources: string[];
}

const MAX_PROJECT_WALK = 10;

function readConfigFile(path: string): DeyinCliConfigFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DeyinCliConfigFile;
  } catch {
    return null;
  }
}

/** Project config files from the workspace root upwards, farthest first (nearest wins). */
function projectConfigs(cwd: string): { path: string; config: DeyinCliConfigFile }[] {
  const found: { path: string; config: DeyinCliConfigFile }[] = [];
  let dir = cwd;
  for (let i = 0; i < MAX_PROJECT_WALK; i++) {
    for (const candidate of [join(dir, "deyin.json"), join(dir, ".deyin", "config.json")]) {
      const config = readConfigFile(candidate);
      if (config) {
        found.push({ path: candidate, config });
        break; // one config per directory level
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found.reverse();
}

function mergeLayer(base: ResolvedCliConfig, layer: DeyinCliConfigFile, source: string): void {
  if (layer.model !== undefined) base.model = layer.model;
  if (layer.agent !== undefined) base.agent = layer.agent;
  if (layer.oauthIssuer !== undefined) base.oauthIssuer = layer.oauthIssuer;
  if (layer.apiBaseUrl !== undefined) base.apiBaseUrl = layer.apiBaseUrl;
  if (layer.clientId !== undefined) base.clientId = layer.clientId;
  if (layer.thinking !== undefined) base.thinking = layer.thinking;
  if (layer.maxSteps !== undefined) base.maxSteps = layer.maxSteps;
  if (layer.permissions) base.permissions = [...base.permissions, ...layer.permissions];
  if (layer.agents) base.agents = { ...base.agents, ...layer.agents };
  if (layer.mcpServers) base.mcpServers = { ...base.mcpServers, ...layer.mcpServers };
  base.sources.push(source);
}

/**
 * Layered config resolution, later layers win:
 * defaults -> ~/.deyin/config.json -> project deyin.json / .deyin/config.json (walking
 * up from cwd) -> DEYIN_* env vars -> explicit overrides (CLI flags).
 */
export function loadCliConfig(opts: {
  cwd: string;
  globalDir: string;
  env?: Record<string, string | undefined>;
  overrides?: Partial<DeyinCliConfigFile>;
}): ResolvedCliConfig {
  const env = opts.env ?? process.env;

  const resolved: ResolvedCliConfig = {
    model: DEFAULT_MODELS[0]?.id ?? "GLM-5.2",
    agent: "build",
    oauthIssuer: DEFAULT_CONFIG.oauthIssuer,
    apiBaseUrl: DEFAULT_CONFIG.apiBaseUrl,
    clientId: DEFAULT_CONFIG.clientId,
    thinking: true,
    maxSteps: 40,
    permissions: [],
    agents: {},
    mcpServers: {},
    sources: ["defaults"],
  };

  const globalPath = join(opts.globalDir, "config.json");
  const globalConfig = readConfigFile(globalPath);
  if (globalConfig) mergeLayer(resolved, globalConfig, globalPath);

  for (const { path, config } of projectConfigs(opts.cwd)) {
    mergeLayer(resolved, config, path);
  }

  const envLayer: DeyinCliConfigFile = {};
  if (env.DEYIN_MODEL) envLayer.model = env.DEYIN_MODEL;
  if (env.DEYIN_AGENT) envLayer.agent = env.DEYIN_AGENT;
  if (env.DEYIN_OAUTH_ISSUER) envLayer.oauthIssuer = env.DEYIN_OAUTH_ISSUER;
  if (env.DEYIN_API_BASE_URL) envLayer.apiBaseUrl = env.DEYIN_API_BASE_URL;
  if (env.DEYIN_CLIENT_ID) envLayer.clientId = env.DEYIN_CLIENT_ID;
  if (env.DEYIN_THINKING) envLayer.thinking = env.DEYIN_THINKING !== "false";
  if (env.DEYIN_MAX_STEPS && Number.isFinite(Number(env.DEYIN_MAX_STEPS))) envLayer.maxSteps = Number(env.DEYIN_MAX_STEPS);
  if (Object.keys(envLayer).length > 0) mergeLayer(resolved, envLayer, "env");

  if (opts.overrides && Object.keys(opts.overrides).length > 0) {
    mergeLayer(resolved, opts.overrides, "flags");
  }

  return resolved;
}

/** All selectable agents: built-ins plus custom agents from config (same name overrides). */
export function resolveAgents(config: Pick<ResolvedCliConfig, "agents">): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();
  for (const agent of BUILTIN_AGENTS) byName.set(agent.name, agent);
  for (const [name, custom] of Object.entries(config.agents)) {
    byName.set(name, {
      name,
      description: custom.description ?? "Custom agent from config.",
      prompt: custom.prompt,
      permissions: custom.permissions,
      model: custom.model,
      maxSteps: custom.maxSteps,
    });
  }
  return [...byName.values()];
}

export function resolveAgent(config: Pick<ResolvedCliConfig, "agents">, name: string): AgentDefinition | undefined {
  return resolveAgents(config).find((a) => a.name === name);
}
