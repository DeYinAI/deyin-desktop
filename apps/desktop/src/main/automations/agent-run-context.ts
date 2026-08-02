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
  runAgent,
  runHooks,
  type AgentDefinition,
  type AgentMessage,
  type LoadedHook,
  type McpConnection,
  type PermissionRule,
  type SubagentDefinition,
} from "@deyin/agent-core";
import type { ApprovalMode, IndexSearchHit } from "../../shared/types.js";
import type { DeyinConfig } from "../../shared/config.js";
import type { AuthManager } from "../auth.js";
import type { BrowserControlService } from "../browser.js";
import type { ChromeDebugService } from "../chrome-debug.js";
import type { ComputerUseService } from "../computer-use.js";
import type { VisualizeService } from "../visualize.js";
import type { CapabilityService } from "../capabilities.js";
import { registerBundledHostTools } from "../plugin-host.js";
import { NEVER_SKIP_PREFIXES, NEVER_SKIP_TOOLS } from "../permission-policy.js";

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

export interface AgentRunContextDeps {
  config: DeyinConfig;
  auth: AuthManager;
  agents: AgentsStore;
  settings: SettingsStore;
  capabilities: CapabilityService;
  browser: BrowserControlService;
  chrome: ChromeDebugService;
  computerUse: ComputerUseService;
  visualize: VisualizeService;
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
  hostRules: PermissionRule[];
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
  let hostRules: PermissionRule[] = [];
  if (opts?.includeBrowser !== false) {
    hostRules = await registerBundledHostTools(registry, deps.agents, deps.settings, {
      browser: deps.browser,
      chrome: deps.chrome,
      computerUse: deps.computerUse,
      visualize: deps.visualize,
    });
  }
  if (opts?.includeSubagents) {
    const subagents = caps.subagents;
    if (subagents.length > 0) {
      registry.register(
        createTaskTool({
          subagents,
          cwd,
          runSubagent: (def, subPrompt, subOpts) =>
            runSubagentInline(deps, cwd, def, subPrompt, subOpts?.signal),
          onBackgroundDone: () => undefined,
        }),
      );
    }
  }

  const mcpConnections = await connectMcpDefinitions(
    caps.mcpServers.map((def) => deps.capabilities.resolvePluginVariables(def)),
    registry,
    {
      onError: () => undefined,
      getAuthProvider: (name) => deps.capabilities.getAuthProvider(name),
    },
  );

  return {
    cwd,
    registry,
    mcpConnections,
    hooks: caps.hooks,
    provider: resolveProviderRouting(deps, "openference"),
    hostRules,
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
  const hostRules = await registerBundledHostTools(registry, deps.agents, deps.settings, {
    browser: deps.browser,
    chrome: deps.chrome,
    computerUse: deps.computerUse,
    visualize: deps.visualize,
  });

  const mcpConnections = await connectMcpDefinitions(
    caps.mcpServers.map((def) => deps.capabilities.resolvePluginVariables(def)),
    registry,
    {
      onError: () => undefined,
      getAuthProvider: (name) => deps.capabilities.getAuthProvider(name),
    },
  );

  return {
    cwd,
    registry,
    mcpConnections,
    hooks: caps.hooks,
    provider: resolveProviderRouting(deps, providerId),
    hostRules,
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

export function automationPermissions(hostRules: PermissionRule[] = []): PermissionEngine {
  return new PermissionEngine({
    agentRules: [],
    configRules: hostRules,
    skipAll: true,
    neverSkipTools: NEVER_SKIP_TOOLS,
    neverSkipPrefixes: NEVER_SKIP_PREFIXES,
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
  const registry = createBuiltinRegistry();
  if (deps.settings.get().indexingEnabled) {
    registry.register(createCodebaseSearchTool((query, topK) => deps.searchIndex(query, topK)));
  }
  const readonlyRules: PermissionRule[] = def.readonly
    ? [
        { tool: "write", action: "deny" },
        { tool: "edit", action: "deny" },
        { tool: "bash", action: "ask" },
      ]
    : [];
  const permissions = new PermissionEngine({
    agentRules: [],
    configRules: readonlyRules,
    skipAll: !def.readonly,
    neverSkipTools: NEVER_SKIP_TOOLS,
    neverSkipPrefixes: NEVER_SKIP_PREFIXES,
  });
  const routing = resolveProviderRouting(deps, "openference");
  const messages: AgentMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        cwd,
        agent: { name: def.name, description: def.description, prompt: def.prompt },
        toolNames: registry.names(),
      }),
    },
    { role: "user", content: prompt },
  ];
  try {
    const result = await runAgent({
      apiBaseUrl: routing.apiBaseUrl,
      getToken: routing.getToken,
      model: def.model ?? deps.settings.get().defaultModel ?? "GLM-5.2",
      messages,
      tools: registry,
      permissions,
      resolvePermission: async () => "deny",
      cwd,
      signal,
    });
    return { ok: true, report: result.finalText || "(subagent returned no text)" };
  } catch (err) {
    return { ok: false, report: err instanceof Error ? err.message : String(err) };
  }
}

export function defaultAutomationCwd(deps: AgentRunContextDeps): string {
  return deps.getWorkspaceRoot() ?? app.getPath("home") ?? process.cwd();
}

export function agentForAutomation(): AgentDefinition {
  return BUILD_AGENT;
}
