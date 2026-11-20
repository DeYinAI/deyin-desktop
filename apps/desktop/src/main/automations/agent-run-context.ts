import type { AgentsStore, SettingsStore } from "@deyin/host-core";
import {
  BUILD_AGENT,
  PermissionEngine,
  ToolRegistry,
  buildSystemPrompt,
  connectMcpDefinitions,
  createBuiltinRegistry,
  createCodebaseSearchTool,
  detectProjectToolchain,
  loadContextFiles,
  runHooks,
  type LoadedHook,
  type McpConnection,
  type SkillDefinition,
  type SubagentDefinition,
} from "@deyin/agent-core";
import type { IndexSearchHit } from "@deyin/contract";
import type { DeyinConfig } from "@deyin/contract";
import type { AuthManager } from "../auth.js";
import type { BrowserControlService } from "../browser.js";
import { AUTOMATION_NEVER_SKIP_PREFIXES } from "../permission-policy.js";
import { workspaceHasDeyinArtifacts, type WorkspaceTrust } from "../workspace-trust.js";
import type { CapabilityService } from "../capabilities.js";
import { withoutWorkspaceCaps } from "../bots/run.js";
import { withBotSkills } from "../bots/skills-run.js";
import type { McpAuthBridge } from "../mcp-auth-bridge.js";
import { isMcpUnauthorized, resolveMcpModuleId } from "../mcp-auth-bridge.js";
import type { VaultPageSource } from "../bots/vault-tools.js";
import type { ChromeAutomationPort } from "./consent.js";
import type { PreflightProbes } from "./health.js";
import { MCP_CONNECT_ATTEMPTS, MCP_CONNECT_BACKOFF_MS, connectWithRetry } from "./health.js";
import { sleep as sleepOn, systemClock } from "./watchdog.js";


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
  /** Declared output-token ceiling, when the catalog publishes one. Optional so test hosts stay valid. */
  getMaxOutputTokens?: (providerId: string, modelId: string) => number | undefined;
  mcpAuth?: McpAuthBridge;
  /** Absent in hosts without Chrome control; automations that need it are then blocked, not improvised. */
  chrome?: ChromeAutomationPort;
  /** The user's Chrome as a page a Bot's routine can fill a saved login into. Absent when Chrome is not available. */
  chromePages?: VaultPageSource;
}

export interface ProviderRouting {
  apiBaseUrl: string;
  getToken: () => Promise<string | null>;
}

/** An MCP server that would not connect, for the run to report by name instead of silently lacking its tools. */
export interface McpFailure {
  server: string;
  message: string;
  /** It needs a sign-in; retrying would not help. */
  needsAuth: boolean;
}

/**
 * Tools an unattended run does not get. Memory is the whole app's, and runs nobody watches wrote
 * contradictory notes into it; an automation's own continuity lives in `automation_state`.
 * Reading memory (the `memory` tool and recall) is unaffected.
 */
export const UNATTENDED_REMOVED_TOOLS: readonly string[] = ["remember", "forget"];

export interface BuiltRunEnvironment {
  cwd: string;
  registry: ToolRegistry;
  mcpConnections: McpConnection[];
  mcpFailures: McpFailure[];
  hooks: LoadedHook[];
  /** Enabled skills, for both the system prompt and the skill tool's ctx. */
  skills: SkillDefinition[];
  subagents: SubagentDefinition[];
  provider: ProviderRouting;
}

/** Stands in for a key when a local endpoint takes none; the run itself never sends it. */
export const LOCAL_ENDPOINT_NO_KEY = "no-key-needed";

/**
 * What a run's pre-flight checks for before it starts. A run on this computer with a model from a provider the person
 * added needs that provider's key (a local endpoint that takes none needs nothing): it never uses an Openference
 * sign-in, so asking for one would stop every run for someone who brought their own key. Everything else keeps the
 * sign-in check, because runs on WSL or an SSH host carry the Openference token with them.
 */
export function credentialProbe(
  deps: Pick<AgentRunContextDeps, "agents" | "auth">,
  automation: { target: { kind: string }; providerId: string },
): Pick<PreflightProbes, "token" | "missingCredential"> {
  const provider = deps.agents.listProviders(true).find((p) => p.id === automation.providerId);
  if (automation.target.kind === "local" && provider?.kind === "custom") {
    return {
      token: async () => deps.agents.getKey(provider.id) ?? (provider.local ? LOCAL_ENDPOINT_NO_KEY : null),
      missingCredential: `No API key is saved for ${provider.name}. Add one in Settings, under Models.`,
    };
  }
  return { token: () => deps.auth.getAccessToken() };
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
  options: {
    sleep?: (ms: number) => Promise<void>;
    /** Sites the automation has consent to use in Chrome. Chrome's tools exist in the run only when there are some. */
    browserOrigins?: readonly string[];
    /** A Bot's routine is not working on the open project, so the project's own skills, hooks and MCP servers stay out. */
    excludeWorkspaceCaps?: boolean;
    /** The folder of a Bot's own skills, when a Bot's routine is running. */
    botSkillsDir?: string;
  } = {},
): Promise<BuiltRunEnvironment> {
  const settings = deps.settings.get();
  let caps = await deps.capabilities.enabledForRun();
  if (options.excludeWorkspaceCaps) caps = withoutWorkspaceCaps(caps);
  caps = await withBotSkills(caps, options.botSkillsDir);
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
  for (const name of UNATTENDED_REMOVED_TOOLS) registry.unregister(name);

  if (settings.indexingEnabled) {
    registry.register(createCodebaseSearchTool((query, topK) => deps.searchIndex(query, topK)));
  }
  const browserOrigins = options.browserOrigins ?? [];
  if (browserOrigins.length > 0) {
    // With consent the run drives the user's Chrome, where the signed-in profile lives. The in-app browser is left
    // out so the model has one browser to use, not two to choose between.
    if (deps.chrome && settings.chromeControlEnabled) for (const tool of deps.chrome.tools()) registry.register(tool);
  } else if (settings.browserControlEnabled && caps.browserEnabled) {
    for (const tool of deps.browser.tools()) registry.register(tool);
  }

  const mcpDefs = caps.mcpServers.map((def) => deps.capabilities.resolvePluginVariables(def));
  const mcpAuth = deps.mcpAuth;
  // A server that was briefly unreachable should not cost the run its tools: retry the ones that failed.
  const { connections: mcpConnections, failures } = await connectWithRetry(
    mcpDefs,
    (defs, onFail) =>
      connectMcpDefinitions(defs, registry, {
        onError: (serverName, err) => {
          onFail(serverName, err);
          const def = mcpDefs.find((d) => d.name === serverName);
          const target = def && mcpAuth ? mcpAuth.oauthTargetFor(def) : null;
          if (target && isMcpUnauthorized(err)) {
            console.warn(`[deyin] Automation skipped unauthenticated MCP "${target.displayName}".`);
            return;
          }
          console.warn(`[deyin] MCP server "${serverName}" failed to connect:`, err);
        },
        ...(mcpAuth
          ? {
              getAuthProvider: (name: string) => {
                const def = mcpDefs.find((d) => d.name === name);
                const moduleId = def ? resolveMcpModuleId(def) : undefined;
                return moduleId ? mcpAuth.getProvider(moduleId) : undefined;
              },
            }
          : {}),
      }),
    {
      attempts: MCP_CONNECT_ATTEMPTS,
      backoffMs: MCP_CONNECT_BACKOFF_MS,
      sleep: options.sleep ?? ((ms) => sleepOn(systemClock, ms)),
      retryable: (err) => !isMcpUnauthorized(err),
    },
  );

  return {
    cwd,
    registry,
    mcpConnections,
    mcpFailures: failures.map((f) => ({
      server: f.name,
      message: f.error instanceof Error ? f.error.message : String(f.error),
      needsAuth: isMcpUnauthorized(f.error),
    })),
    hooks: caps.hooks,
    skills: caps.skills,
    subagents: caps.subagents,
    provider: resolveProviderRouting(deps, providerId),
  };
}

export async function buildAutomationSystemPrompt(
  deps: AgentRunContextDeps,
  cwd: string,
  /** The run's own section (clock, how it must end); see run-prompt.ts. */
  runPrompt?: string,
  options: { excludeWorkspaceCaps?: boolean; botSkillsDir?: string } = {},
): Promise<string> {
  const enabled = await deps.capabilities.enabledForRun();
  const caps = await withBotSkills(options.excludeWorkspaceCaps ? withoutWorkspaceCaps(enabled) : enabled, options.botSkillsDir);
  const agent = BUILD_AGENT;
  const [contextFiles, projectToolchain] = await Promise.all([
    loadContextFiles(cwd).catch(() => []),
    detectProjectToolchain(cwd).catch(() => null),
  ]);
  let system = buildSystemPrompt({
    cwd,
    agent: {
      ...agent,
      prompt:
        agent.prompt +
        " You are running as an unattended automation in Deyin. Complete the task without asking the user questions." +
        " Always verify file creations and modifications on disk using read or ls before concluding." +
        " Never report in your final text that a file was created or modified unless the corresponding tool call succeeded and disk verification was completed.",
    },
    contextFiles,
    skills: caps.skills.length > 0 ? caps.skills : undefined,
    projectToolchain,
  });
  if (runPrompt) system += `\n\n${runPrompt}`;
  const startHooks = await runHooks(caps.hooks, "sessionStart", "sessionStart", { cwd });
  if (startHooks.additionalContext && startHooks.additionalContext.length > 0) {
    system += `\n\n# Hook context\n${startHooks.additionalContext.join("\n")}`;
  }
  return system;
}

export function automationPermissions(): PermissionEngine {
  // Unattended runs skip prompts, but computer-use must still route through
  // resolvePermission (which denies it): the never-skip prefixes keep its ask
  // tier alive under skipAll. Chrome is governed by the automation's consent.
  return new PermissionEngine({
    agentRules: [],
    configRules: [],
    skipAll: true,
    neverSkipPrefixes: AUTOMATION_NEVER_SKIP_PREFIXES,
  });
}
export async function closeMcp(connections: McpConnection[]): Promise<void> {
  await Promise.allSettled(connections.map((c) => c.close()));
}
