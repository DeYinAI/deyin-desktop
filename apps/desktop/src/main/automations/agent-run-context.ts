import { app } from "electron";
import type { AgentsStore, SettingsStore } from "@deyin/host-core";
import {
  BUILD_AGENT,
  PermissionEngine,
  ToolRegistry,
  buildSystemPrompt,
  connectMcpDefinitions,
  createBuiltinRegistry,
  createCodebaseSearchTool,
  createTaskTool,
  loadContextFiles,
  runHooks,
  Semaphore,
  runSubagent,
  subagentReadonlyRules,
  type AgentDefinition,
  type LoadedHook,
  type McpConnection,
  type PermissionRule,
  type SubagentDefinition,
  subagentEffort,
} from "@deyin/agent-core";
import type { ApprovalMode, IndexSearchHit } from "../../shared/types.js";
import type { DeyinConfig } from "../../shared/config.js";
import type { AuthManager } from "../auth.js";
import type { BrowserControlService } from "../browser.js";
import type { CapabilityService } from "../capabilities.js";

const READONLY_RULES: PermissionRule[] = [
  { tool: "*", action: "deny" },
  { tool: "read", action: "allow" },
  { tool: "grep", action: "allow" },
  { tool: "glob", action: "allow" },
  { tool: "ls", action: "allow" },
  { tool: "websearch", action: "allow" },
  { tool: "todo_write", action: "allow" },
  { tool: "codebase_search", action: "allow" },
  { tool: "browser_snapshot", action: "allow" },
  { tool: "browser_screenshot", action: "allow" },
  { tool: "browser_console", action: "allow" },
  { tool: "browser_network", action: "allow" },
];

/** Caps concurrent subagent runs inside automation agent runs (settings.subagentConcurrency). */
let automationSubagentLimit = 6;
const automationSubagentLimiter = new Semaphore(() => automationSubagentLimit);

export interface AgentRunContextDeps {
  config: DeyinConfig;
  auth: AuthManager;
  agents: AgentsStore;
  settings: SettingsStore;
  capabilities: CapabilityService;
  browser: BrowserControlService;
  memory: import("@deyin/host-core").MemoryStore;
  getWorkspaceRoot: () => string | null;
  searchIndex: (query: string, topK: number) => Promise<IndexSearchHit[]>;
  getContextLength: (providerId: string, modelId: string) => number | undefined;
}

export interface ProviderRouting {
  apiBaseUrl: string;
  getToken: () => Promise<string | null>;
}

export interface BuiltRunEnvironment {
  cwd: string;
  registry: ToolRegistry;
  mcpConnections: McpConnection[];
  hooks: LoadedHook[];
  provider: ProviderRouting;
}

export function resolveProviderRouting(
  deps: AgentRunContextDeps,
  providerId: string,
): ProviderRouting {
  let apiBaseUrl = deps.config.apiBaseUrl;
  let getToken: () => Promise<string | null> = () => deps.auth.getAccessToken();
  const provider = deps.agents.listProviders(true).find((p) => p.id === providerId);
  if (provider && provider.kind === "custom") {
    apiBaseUrl = provider.baseUrl ?? apiBaseUrl;
    getToken = () => Promise.resolve(deps.agents.getKey(provider.id));
  }
  return { apiBaseUrl, getToken };
}

export async function buildRunEnvironment(
  deps: AgentRunContextDeps,
  cwd: string,
  opts?: { includeSubagents?: boolean; includeBrowser?: boolean },
): Promise<BuiltRunEnvironment> {
  const settings = deps.settings.get();
  const caps = await deps.capabilities.enabledForRun();
  const registry = createBuiltinRegistry();

  if (settings.indexingEnabled) {
    registry.register(createCodebaseSearchTool((query, topK) => deps.searchIndex(query, topK)));
  }
  if (opts?.includeBrowser !== false && settings.browserControlEnabled && caps.browserEnabled) {
    for (const tool of deps.browser.tools()) registry.register(tool);
  }
  if (opts?.includeSubagents) {
    const subagents = caps.subagents;
    if (subagents.length > 0) {
      registry.register(
        createTaskTool({
          subagents,
          runSubagent: (def, subPrompt, subSignal) =>
            runSubagentInline(deps, cwd, def, subPrompt, subSignal),
          onBackgroundDone: () => undefined,
        }),
      );
    }
  }

  const mcpConnections = await connectMcpDefinitions(
    caps.mcpServers.map((def) => deps.capabilities.resolvePluginVariables(def)),
    registry,
    { onError: () => undefined },
  );

  return {
    cwd,
    registry,
    mcpConnections,
    hooks: caps.hooks,
    provider: resolveProviderRouting(deps, "openference"),
  };
}

export async function buildAutomationEnvironment(
  deps: AgentRunContextDeps,
  cwd: string,
  providerId: string,
): Promise<BuiltRunEnvironment> {
  const settings = deps.settings.get();
  const caps = await deps.capabilities.enabledForRun();
  const registry = createBuiltinRegistry();

  if (settings.indexingEnabled) {
    registry.register(createCodebaseSearchTool((query, topK) => deps.searchIndex(query, topK)));
  }
  if (settings.browserControlEnabled && caps.browserEnabled) {
    for (const tool of deps.browser.tools()) registry.register(tool);
  }

  const mcpConnections = await connectMcpDefinitions(
    caps.mcpServers.map((def) => deps.capabilities.resolvePluginVariables(def)),
    registry,
    { onError: () => undefined },
  );

  return {
    cwd,
    registry,
    mcpConnections,
    hooks: caps.hooks,
    provider: resolveProviderRouting(deps, providerId),
  };
}

export async function buildAutomationSystemPrompt(
  deps: AgentRunContextDeps,
  cwd: string,
  registry: ToolRegistry,
): Promise<string> {
  const caps = await deps.capabilities.enabledForRun();
  const agent = BUILD_AGENT;
  const contextFiles = await loadContextFiles(cwd).catch(() => []);
  let system = buildSystemPrompt({
    cwd,
    agent: {
      ...agent,
      prompt:
        agent.prompt +
        " You are running as an unattended automation in Deyin. Complete the task without asking the user questions.",
    },
    toolNames: registry.names(),
    contextFiles,
    skills: caps.skills.length > 0 ? caps.skills : undefined,
  });
  const startHooks = await runHooks(caps.hooks, "sessionStart", "sessionStart", { cwd });
  if (startHooks.additionalContext && startHooks.additionalContext.length > 0) {
    system += `\n\n# Hook context\n${startHooks.additionalContext.join("\n")}`;
  }
  return system;
}

export function automationPermissions(): PermissionEngine {
  return new PermissionEngine({
    agentRules: [],
    configRules: [],
    skipAll: true,
  });
}

export function rulesForApprovalMode(mode: ApprovalMode): PermissionRule[] {
  switch (mode) {
    case "full-access":
      return [];
    case "ask-first":
      return [];
    case "read-only":
      return READONLY_RULES;
  }
}

export async function closeMcp(connections: McpConnection[]): Promise<void> {
  await Promise.allSettled(connections.map((c) => c.close()));
}

async function runSubagentInline(
  deps: AgentRunContextDeps,
  cwd: string,
  def: SubagentDefinition,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; report: string }> {
  automationSubagentLimit = deps.settings.get().subagentConcurrency;
  return automationSubagentLimiter.run(() => runSubagentInlineUncapped(deps, cwd, def, prompt, signal));
}

async function runSubagentInlineUncapped(
  deps: AgentRunContextDeps,
  cwd: string,
  def: SubagentDefinition,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; report: string }> {
  const permissions = new PermissionEngine({
    agentRules: [],
    configRules: subagentReadonlyRules(def),
    skipAll: !def.readonly,
  });
  // Resolve provider + model for this subagent. Settings store "providerId::modelId"
  // (same format as defaultModel): split and route to that provider, send the bare id.
  const override = deps.settings.get().subagentModels[def.name];
  const dm = deps.settings.get().defaultModel;
  let providerId = "openference";
  let model: string | undefined;
  if (override) {
    const sep = override.indexOf("::");
    providerId = sep >= 0 ? override.slice(0, sep) : "openference";
    model = sep >= 0 ? override.slice(sep + 2) : override;
  } else if (def.model) {
    model = def.model;
  } else if (dm && dm.includes("::")) {
    [providerId, model] = dm.split("::") as [string, string];
  } else {
    model = dm ?? "GLM-5.2";
  }
  const routing = resolveProviderRouting(deps, providerId);
  return runSubagent(def, prompt, {
    cwd,
    parent: { model: model ?? "GLM-5.2", providerId, thinking: undefined },
    modelOverride: override,
    effortOverride: subagentEffort(deps.settings.get().subagentEfforts[def.name], def.effort),
    maxStepsDefault: deps.settings.get().subagentMaxSteps,
    parentRouting: routing,
    resolveProvider: (id) => resolveProviderRouting(deps, id),
    permissionEngine: permissions,
    resolvePermission: async () => "deny",
    extraTools: deps.settings.get().indexingEnabled
      ? [createCodebaseSearchTool((query, topK) => deps.searchIndex(query, topK))]
      : [],
    signal,
  });
}

export function defaultAutomationCwd(deps: AgentRunContextDeps): string {
  return deps.getWorkspaceRoot() ?? app.getPath("home") ?? process.cwd();
}

export function agentForAutomation(): AgentDefinition {
  return BUILD_AGENT;
}
