import type { CapabilityItem, DeyinSettings, ProviderInfo } from "./types.js";

/** Bump when DeyinSettings changes shape; migrateSettings upgrades older files. */
export const SETTINGS_SCHEMA_VERSION = 10;

export const DEFAULT_SETTINGS: DeyinSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  theme: "dark",
  language: "en",
  fontSize: 14,
  autoUpdate: true,
  telemetry: false,
  browserControlEnabled: true,
  defaultModel: null,
  subagentModels: {},
  subagentEfforts: {},
  subagentMaxSteps: 20,
  subagentConcurrency: 6,
  approvalMode: "full-access",
  thinking: true,
  welcomeDismissed: false,
  codeThemeLight: "GitHub Light",
  codeThemeDark: "GitHub Dark",
  showLineNumbers: true,
  wrapLongLines: false,
  codeFontSize: 12,
  agentMode: "agent",
  defaultShell: null,
  terminalFontSize: 12,
  terminalScrollback: 5000,
  revealTerminalOnAgentCommand: true,
  indexingEnabled: true,
  onboard: { workspaceOpened: false, terminalUsed: false, taskRun: false },
  automationsCatchUp: true,
  keepRunningInBackground: false,
  optimizationCompression: true,
  optimizationCompressionMode: "balanced",
  optimizationPromptCaching: true,
  optimizationPluginEnabled: false,
  optimizationToolCache: true,
  optimizationResponseCache: true,
  optimizationSimilarityThreshold: 0.93,
  memoryEnabled: true,
  reviewMode: "off",
  enableDeliveryMode: false,
  whatsNewSeenVersion: null,
  reasonixOnboardComplete: false,
  cacheHitRateTarget: 0.8,
  cacheHitRateWarningThreshold: 0.6,
  enableCacheOptimizations: true,
  enableCoordinator: false,
  plannerModel: null,
  coordinatorRoutingPolicy: "balanced",
  enableFleet: false,
  chromeDebugEnabled: false,
  computerUseEnabled: false,
  computerUseScreenshotRetentionDays: 7,
  computerUseConfirmationRequired: true,
  evidenceRequireAcceptanceCriteria: true,
  evidenceStrictFinalization: true,
  maxParallelWriters: 2,
  schedulerWritePathValidation: true,
};

/**
 * Upgrade a settings object read from disk to the current schema. Unknown keys
 * are dropped, missing keys get defaults, and out-of-range values are clamped,
 * so renamed/new fields never leave the app with an inconsistent state.
 */
export function migrateSettings(raw: unknown): DeyinSettings {
  const input = (raw && typeof raw === "object" ? raw : {}) as Partial<DeyinSettings> & Record<string, unknown>;
  const merged: DeyinSettings = {
    ...DEFAULT_SETTINGS,
    ...input,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    onboard: { ...DEFAULT_SETTINGS.onboard, ...(typeof input.onboard === "object" && input.onboard ? input.onboard : {}) },
  };
  // v1 -> v2: clamp numeric ranges introduced with the terminal/appearance work.
  merged.fontSize = clamp(merged.fontSize, 12, 18, DEFAULT_SETTINGS.fontSize);
  merged.codeFontSize = clamp(merged.codeFontSize, 10, 20, DEFAULT_SETTINGS.codeFontSize);
  merged.terminalFontSize = clamp(merged.terminalFontSize, 10, 20, DEFAULT_SETTINGS.terminalFontSize);
  merged.terminalScrollback = clamp(merged.terminalScrollback, 200, 100_000, DEFAULT_SETTINGS.terminalScrollback);
  if (typeof merged.revealTerminalOnAgentCommand !== "boolean") {
    merged.revealTerminalOnAgentCommand = DEFAULT_SETTINGS.revealTerminalOnAgentCommand;
  }
  if (typeof merged.optimizationCompression !== "boolean") {
    merged.optimizationCompression = DEFAULT_SETTINGS.optimizationCompression;
  }
  if (!["aggressive", "balanced", "conservative"].includes(merged.optimizationCompressionMode)) {
    merged.optimizationCompressionMode = DEFAULT_SETTINGS.optimizationCompressionMode;
  }
  if (typeof merged.optimizationPromptCaching !== "boolean") {
    merged.optimizationPromptCaching = DEFAULT_SETTINGS.optimizationPromptCaching;
  }
  if (typeof merged.optimizationPluginEnabled !== "boolean") {
    merged.optimizationPluginEnabled = DEFAULT_SETTINGS.optimizationPluginEnabled;
  }
  if (typeof merged.optimizationToolCache !== "boolean") {
    merged.optimizationToolCache = DEFAULT_SETTINGS.optimizationToolCache;
  }
  if (typeof merged.optimizationResponseCache !== "boolean") {
    merged.optimizationResponseCache = DEFAULT_SETTINGS.optimizationResponseCache;
  }
  merged.optimizationSimilarityThreshold = clamp(
    merged.optimizationSimilarityThreshold,
    0.8,
    0.98,
    DEFAULT_SETTINGS.optimizationSimilarityThreshold,
  );
  if (merged.agentMode !== "agent" && merged.agentMode !== "chat") merged.agentMode = "agent";
  // v6 -> v7: subagent run limits.
  merged.subagentMaxSteps = clamp(merged.subagentMaxSteps, 1, 200, DEFAULT_SETTINGS.subagentMaxSteps);
  merged.subagentConcurrency = clamp(merged.subagentConcurrency, 1, 32, DEFAULT_SETTINGS.subagentConcurrency);
  // v7 -> v8: subagentEfforts must be a record of valid effort levels.
  if (typeof merged.subagentEfforts !== "object" || merged.subagentEfforts === null || Array.isArray(merged.subagentEfforts)) {
    merged.subagentEfforts = {};
  } else {
    const clean: Record<string, string> = {};
    for (const [name, effort] of Object.entries(merged.subagentEfforts)) {
      if (effort === "low" || effort === "medium" || effort === "high") clean[name] = effort;
    }
    merged.subagentEfforts = clean;
  }
  // v8 -> v9: memoryEnabled boolean.
  if (typeof merged.memoryEnabled !== "boolean") merged.memoryEnabled = DEFAULT_SETTINGS.memoryEnabled;
  // v9 -> v10: review/delivery/coordinator/computer-use/chrome settings.
  if (merged.reviewMode !== "on" && merged.reviewMode !== "off") merged.reviewMode = DEFAULT_SETTINGS.reviewMode;
  if (typeof merged.enableDeliveryMode !== "boolean") merged.enableDeliveryMode = DEFAULT_SETTINGS.enableDeliveryMode;
  if (typeof merged.whatsNewSeenVersion !== "string") merged.whatsNewSeenVersion = DEFAULT_SETTINGS.whatsNewSeenVersion;
  if (typeof merged.reasonixOnboardComplete !== "boolean") {
    merged.reasonixOnboardComplete = DEFAULT_SETTINGS.reasonixOnboardComplete;
  }
  merged.cacheHitRateTarget = clamp(merged.cacheHitRateTarget, 0.5, 0.95, DEFAULT_SETTINGS.cacheHitRateTarget);
  merged.cacheHitRateWarningThreshold = clamp(
    merged.cacheHitRateWarningThreshold,
    0.2,
    0.95,
    DEFAULT_SETTINGS.cacheHitRateWarningThreshold,
  );
  if (typeof merged.enableCacheOptimizations !== "boolean") {
    merged.enableCacheOptimizations = DEFAULT_SETTINGS.enableCacheOptimizations;
  }
  if (typeof merged.enableCoordinator !== "boolean") merged.enableCoordinator = DEFAULT_SETTINGS.enableCoordinator;
  if (typeof merged.plannerModel !== "string") merged.plannerModel = DEFAULT_SETTINGS.plannerModel;
  if (!["balanced", "conservative", "aggressive"].includes(merged.coordinatorRoutingPolicy)) {
    merged.coordinatorRoutingPolicy = DEFAULT_SETTINGS.coordinatorRoutingPolicy;
  }
  if (typeof merged.enableFleet !== "boolean") merged.enableFleet = DEFAULT_SETTINGS.enableFleet;
  if (typeof merged.chromeDebugEnabled !== "boolean") merged.chromeDebugEnabled = DEFAULT_SETTINGS.chromeDebugEnabled;
  if (typeof merged.computerUseEnabled !== "boolean") merged.computerUseEnabled = DEFAULT_SETTINGS.computerUseEnabled;
  merged.computerUseScreenshotRetentionDays = clamp(
    merged.computerUseScreenshotRetentionDays,
    1,
    90,
    DEFAULT_SETTINGS.computerUseScreenshotRetentionDays,
  );
  if (typeof merged.computerUseConfirmationRequired !== "boolean") {
    merged.computerUseConfirmationRequired = DEFAULT_SETTINGS.computerUseConfirmationRequired;
  }
  if (typeof merged.evidenceRequireAcceptanceCriteria !== "boolean") {
    merged.evidenceRequireAcceptanceCriteria = DEFAULT_SETTINGS.evidenceRequireAcceptanceCriteria;
  }
  if (typeof merged.evidenceStrictFinalization !== "boolean") {
    merged.evidenceStrictFinalization = DEFAULT_SETTINGS.evidenceStrictFinalization;
  }
  merged.maxParallelWriters = clamp(merged.maxParallelWriters, 1, 8, DEFAULT_SETTINGS.maxParallelWriters);
  if (typeof merged.schedulerWritePathValidation !== "boolean") {
    merged.schedulerWritePathValidation = DEFAULT_SETTINGS.schedulerWritePathValidation;
  }
  // v5 -> v6: subagentModels must be a plain record of non-empty strings; drop anything else.
  if (typeof merged.subagentModels !== "object" || merged.subagentModels === null || Array.isArray(merged.subagentModels)) {
    merged.subagentModels = {};
  } else {
    const clean: Record<string, string> = {};
    for (const [name, model] of Object.entries(merged.subagentModels)) {
      if (typeof model === "string" && model.trim().length > 0) clean[name] = model.trim();
    }
    merged.subagentModels = clean;
  }
  if (!["dark", "light", "system"].includes(merged.theme)) merged.theme = "dark";
  if (!["full-access", "ask-first", "read-only"].includes(merged.approvalMode)) merged.approvalMode = "full-access";
  return merged;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Default capability registry. Original seed data; toggles persist across restarts. */
export const DEFAULT_CAPABILITIES: CapabilityItem[] = [
  // Plugins
  {
    id: "browser-use",
    kind: "plugin",
    name: "Browser Use",
    description: "Let agent sessions open, inspect and control pages in the built-in browser.",
    enabled: true,
    version: "0.3.0",
    source: "built-in",
  },
  {
    id: "git-tools",
    kind: "plugin",
    name: "Git Tools",
    description: "Stage, diff, commit and inspect history from agent runs.",
    enabled: true,
    version: "0.2.1",
    source: "built-in",
  },
  {
    id: "web-search",
    kind: "plugin",
    name: "Web Search",
    description: "Give the agent real-time web lookups through the built-in search engine.",
    enabled: true,
    version: "0.2.0",
    source: "built-in",
  },
  // Skills — mirrors the built-in skill set the desktop materializes
  // (agent-core BUILTIN_SKILLS); this seed is display-only on the web.
  {
    id: "skill:create-skill",
    kind: "skill",
    name: "create-skill",
    description: "Author a new agent skill (SKILL.md) from the current conversation.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "skill:create-rule",
    kind: "skill",
    name: "create-rule",
    description: "Create project rules in .deyin/rules that steer every agent session.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "skill:create-hook",
    kind: "skill",
    name: "create-hook",
    description: "Create or edit lifecycle hooks in .deyin/hooks.json.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "skill:create-subagent",
    kind: "skill",
    name: "create-subagent",
    description: "Create a custom subagent definition in .deyin/agents.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "skill:review-code",
    kind: "skill",
    name: "review-code",
    description: "Structured review of a diff: correctness, security, edge cases, style.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "skill:generate-tests",
    kind: "skill",
    name: "generate-tests",
    description: "Write tests with the project's own framework, then run them.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "skill:refactor",
    kind: "skill",
    name: "refactor",
    description: "Apply a named refactoring in small verifiable steps.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "skill:debug-issue",
    kind: "skill",
    name: "debug-issue",
    description: "Systematic debugging: reproduce, isolate, fix the root cause, verify.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "skill:verify-in-browser",
    kind: "skill",
    name: "verify-in-browser",
    description: "Verify UI changes end to end in the built-in browser.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "skill:onboard",
    kind: "skill",
    name: "onboard",
    description: "Explore and explain an unfamiliar codebase: structure, stack, conventions.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "skill:split-to-prs",
    kind: "skill",
    name: "split-to-prs",
    description: "Split accumulated changes into small reviewable branches/PRs.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "skill:env-setup",
    kind: "skill",
    name: "env-setup",
    description: "Get a fresh checkout running: toolchain, dependencies, build, tests.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "skill:loop",
    kind: "skill",
    name: "loop",
    description: "Re-run a prompt or check on an interval (/loop 5m <prompt>).",
    enabled: true,
    source: "built-in",
  },
  // Subagents
  {
    id: "explorer",
    kind: "subagent",
    name: "Explorer",
    description: "Fast codebase exploration: find files, symbols and call sites.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "reviewer",
    kind: "subagent",
    name: "Reviewer",
    description: "Independent second pass that critiques the main agent's changes.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "test-runner",
    kind: "subagent",
    name: "Test Runner",
    description: "Runs the test suite and reports failures back to the main agent.",
    enabled: false,
    source: "built-in",
  },
  // MCP servers
  {
    id: "mcp-deyin-search",
    kind: "mcp",
    name: "deyin-search",
    description: "Built-in free web search (DuckDuckGo) exposed to agent sessions as an MCP tool.",
    enabled: true,
    source: "built-in · runs locally",
  },
  {
    id: "mcp-filesystem",
    kind: "mcp",
    name: "filesystem",
    description: "Filesystem MCP server scoped to the current workspace.",
    enabled: true,
    source: "npx @modelcontextprotocol/server-filesystem",
  },
  {
    id: "mcp-github",
    kind: "mcp",
    name: "github",
    description: "GitHub MCP server for issues, PRs and repository metadata.",
    enabled: false,
    source: "npx @modelcontextprotocol/server-github",
  },
  // Commands
  {
    id: "cmd-commit",
    kind: "command",
    name: "/commit",
    description: "Stage everything and write a conventional commit message.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "cmd-explain",
    kind: "command",
    name: "/explain",
    description: "Explain the selected code or the last terminal error.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "cmd-fix",
    kind: "command",
    name: "/fix",
    description: "Propose and apply a fix for the current diagnostics.",
    enabled: true,
    source: "built-in",
  },
  // Hooks
  {
    id: "hook-session-start",
    kind: "hook",
    name: "session-start",
    description: "Runs when a new agent session begins (loads workspace context).",
    enabled: true,
    source: "built-in",
  },
  {
    id: "hook-post-edit",
    kind: "hook",
    name: "post-edit",
    description: "Runs the linter after every file edit the agent makes.",
    enabled: false,
    source: "built-in",
  },
];

/** Provider record as persisted, minus runtime-derived fields and secrets. */
export type StoredProviderBase = Omit<ProviderInfo, "status" | "hasKey">;

export const DEFAULT_PROVIDERS: StoredProviderBase[] = [
  {
    id: "openference",
    name: "Openference",
    kind: "primary",
    enabled: true,
    baseUrl: "https://api.openference.com/v1",
    apiFormat: "chat-completions",
    connectionModes: ["Individual plan", "Team plan", "API key"],
    activeMode: "Individual plan",
    models: [],
    disabledModels: [],
  },
];
