import type { AgentsStore, SettingsStore } from "@deyin/host-core";
import {
  BUILD_AGENT,
  PermissionEngine,
  ToolRegistry,
  buildSystemPrompt,
  connectMcpDefinitions,
  createBuiltinRegistry,
  createCodebaseSearchTool,
  loadContextFiles,
  runHooks,
  type LoadedHook,
  type McpConnection,
} from "@deyin/agent-core";
import type { IndexSearchHit } from "../../shared/types.js";
import type { DeyinConfig } from "../../shared/config.js";
import type { AuthManager } from "../auth.js";
import type { BrowserControlService } from "../browser.js";
import { NEVER_SKIP_PREFIXES, NEVER_SKIP_TOOLS } from "../permission-policy.js";
import { workspaceHasDeyinArtifacts, type WorkspaceTrust } from "../workspace-trust.js";
import type { CapabilityService } from "../capabilities.js";


export interface AgentRunContextDeps {
  config: DeyinConfig;
  auth: AuthManager;
  agents: AgentsStore;
  settings: SettingsStore;
  capabilities: CapabilityService;
  browser: BrowserControlService;
  memory: import("@deyin/host-core").MemoryStore;
  getWorkspaceRoot: () => string | null;
  /** Workspace trust decisions; unattended runs skip untrusted workspace config. */
  trust?: WorkspaceTrust;
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



export async function buildAutomationEnvironment(
  deps: AgentRunContextDeps,
  cwd: string,
  providerId: string,
): Promise<BuiltRunEnvironment> {
  const settings = deps.settings.get();
  let caps = await deps.capabilities.enabledForRun();
  // Unattended automation runs cannot show a trust dialog: default-deny
  // workspace hooks / MCP servers unless the workspace was trusted earlier
  // through the interactive agent path.
  const root = deps.getWorkspaceRoot();
  if (root && workspaceHasDeyinArtifacts(root) && !deps.trust?.isTrusted(root)) {
    caps = {
      ...caps,
      hooks: caps.hooks.filter((h) => h.source !== "workspace"),
      mcpServers: caps.mcpServers.filter((s) => s.source !== "workspace"),
    };
  }
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
  // Unattended runs skip prompts, but computer-use / Chrome navigation must still
  // route through resolvePermission (which denies them) — neverSkip guarantees
  // the ask tier survives skipAll.
  return new PermissionEngine({
    agentRules: [
      { tool: "chrome_navigate", action: "ask" },
    ],
    configRules: [],
    skipAll: true,
    neverSkipTools: NEVER_SKIP_TOOLS,
    neverSkipPrefixes: NEVER_SKIP_PREFIXES,
  });
}
export async function closeMcp(connections: McpConnection[]): Promise<void> {
  await Promise.allSettled(connections.map((c) => c.close()));
}
