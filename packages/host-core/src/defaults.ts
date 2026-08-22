import type { CapabilityItem, DeyinSettings, ProviderApiFormat, ProviderInfo } from "./types.js";

/** Bump when DeyinSettings changes shape; migrateSettings upgrades older files. */
export const SETTINGS_SCHEMA_VERSION = 15;

export const DEFAULT_SETTINGS: DeyinSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  theme: "dark",
  themeAccent: "blue",
  language: "en",
  fontSize: 14,
  autoUpdate: true,
  telemetry: false,
  browserControlEnabled: true,
  /** OS-level computer use (Windows); opt-in for safety. */
  computerUseEnabled: false,
  computerUseScreenshotRetentionDays: 7,
  defaultModel: null,
  roleModels: {},
  subagentModels: {},
  subagentEfforts: {},
  modelEfforts: {},
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
  terminalCursorStyle: "bar",
  terminalCopyOnSelect: true,
  revealTerminalOnAgentCommand: true,
  indexingEnabled: true,
  onboard: { workspaceOpened: false, terminalUsed: false, taskRun: false },
  keepRunningInBackground: false,
  automationsCatchUp: true,
  optimizationPluginEnabled: false,
  memoryEnabled: true,
  reviewMode: "off",
  whatsNewSeenVersion: null,
};

/**
 * Upgrade a settings object read from disk to the current schema. Unknown keys
 * are dropped, missing keys get defaults, and out-of-range values are clamped,
 * so renamed/new fields never leave the app with an inconsistent state.
 */
export function migrateSettings(raw: unknown): DeyinSettings {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // Pick only known keys: legacy Advanced agent knobs and removed fields drop out here.
  const merged: DeyinSettings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof DeyinSettings>) {
    if (key === "schemaVersion") continue;
    if (key in input) {
      (merged as unknown as Record<string, unknown>)[key] = input[key];
    }
  }
  merged.onboard = { ...DEFAULT_SETTINGS.onboard, ...(typeof input.onboard === "object" && input.onboard ? input.onboard : {}) };

  // Numeric ranges and enum guards; every value coming from disk is untrusted.
  merged.fontSize = clamp(merged.fontSize, 12, 18, DEFAULT_SETTINGS.fontSize);
  merged.codeFontSize = clamp(merged.codeFontSize, 10, 20, DEFAULT_SETTINGS.codeFontSize);
  merged.terminalFontSize = clamp(merged.terminalFontSize, 10, 20, DEFAULT_SETTINGS.terminalFontSize);
  merged.terminalScrollback = clamp(merged.terminalScrollback, 200, 100_000, DEFAULT_SETTINGS.terminalScrollback);
  merged.subagentMaxSteps = clamp(merged.subagentMaxSteps, 1, 200, DEFAULT_SETTINGS.subagentMaxSteps);
  merged.subagentConcurrency = clamp(merged.subagentConcurrency, 1, 32, DEFAULT_SETTINGS.subagentConcurrency);
  merged.roleModels = pickRoleRecord(merged.roleModels);
  merged.subagentModels = pickStringRecord(merged.subagentModels);
  merged.subagentEfforts = pickStringRecord(
    merged.subagentEfforts,
    (v): v is string => v === "low" || v === "medium" || v === "high",
  );
  merged.modelEfforts = pickStringRecord(
    merged.modelEfforts,
    (v): v is string => v === "off" || v === "low" || v === "medium" || v === "high",
  );
  if (typeof merged.browserControlEnabled !== "boolean") {
    merged.browserControlEnabled = DEFAULT_SETTINGS.browserControlEnabled;
  }
  if (typeof merged.computerUseEnabled !== "boolean") {
    merged.computerUseEnabled = DEFAULT_SETTINGS.computerUseEnabled;
  }
  merged.computerUseScreenshotRetentionDays = clamp(
    merged.computerUseScreenshotRetentionDays,
    1,
    90,
    DEFAULT_SETTINGS.computerUseScreenshotRetentionDays,
  );
  if (typeof merged.revealTerminalOnAgentCommand !== "boolean") {
    merged.revealTerminalOnAgentCommand = DEFAULT_SETTINGS.revealTerminalOnAgentCommand;
  }
  if (!["bar", "block", "underline"].includes(merged.terminalCursorStyle)) {
    merged.terminalCursorStyle = DEFAULT_SETTINGS.terminalCursorStyle;
  }
  if (typeof merged.terminalCopyOnSelect !== "boolean") {
    merged.terminalCopyOnSelect = DEFAULT_SETTINGS.terminalCopyOnSelect;
  }
  if (typeof merged.optimizationPluginEnabled !== "boolean") {
    merged.optimizationPluginEnabled = DEFAULT_SETTINGS.optimizationPluginEnabled;
  }
  if (typeof merged.automationsCatchUp !== "boolean") {
    merged.automationsCatchUp = DEFAULT_SETTINGS.automationsCatchUp;
  }
  if (typeof merged.memoryEnabled !== "boolean") merged.memoryEnabled = DEFAULT_SETTINGS.memoryEnabled;
  if (merged.reviewMode !== "on" && merged.reviewMode !== "off") merged.reviewMode = DEFAULT_SETTINGS.reviewMode;
  if (merged.agentMode !== "agent" && merged.agentMode !== "chat") merged.agentMode = "agent";
  if (typeof merged.whatsNewSeenVersion !== "string") merged.whatsNewSeenVersion = DEFAULT_SETTINGS.whatsNewSeenVersion;
  if (!["dark", "light", "system", "warm"].includes(merged.theme)) merged.theme = "dark";
  if (typeof merged.themeAccent !== "string" || !merged.themeAccent.trim()) {
    merged.themeAccent = DEFAULT_SETTINGS.themeAccent;
  }
  if (!["full-access", "ask-first", "read-only"].includes(merged.approvalMode)) merged.approvalMode = "full-access";
  return merged;
}

/** Roles a model override may target; keys outside this set are dropped. */
const MODEL_ROLE_KEYS = ["implement", "plan", "ask", "delivery", "tool"];

/** Role -> model map from disk, keeping only known roles with non-blank values. */
function pickRoleRecord(value: unknown): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [role, ref] of Object.entries(pickStringRecord(value))) {
    if (MODEL_ROLE_KEYS.includes(role)) clean[role] = ref;
  }
  return clean;
}

function pickStringRecord(
  value: unknown,
  valid?: (v: unknown) => boolean,
): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const clean: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && entry.trim().length > 0 && (!valid || valid(entry))) {
      clean[key] = entry.trim();
    }
  }
  return clean;
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
  {
    id: "skill:review-bugbot",
    kind: "skill",
    name: "review-bugbot",
    description: "Run the Bugbot subagent over the current changes and report its findings.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "skill:review-security",
    kind: "skill",
    name: "review-security",
    description: "Run the Security Review subagent over the current changes and report its findings.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "skill:review",
    kind: "skill",
    name: "review",
    description: "Pick between Bugbot and Security Review, then run that review (/review).",
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
    id: "bugbot",
    kind: "subagent",
    name: "Bugbot",
    description: "Adversarial bug hunt over a diff: correctness, state, contract breaks and edge cases.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "security-review",
    kind: "subagent",
    name: "Security Review",
    description: "Audits a diff for exploitable vulnerabilities: injection, authz gaps, secrets, SSRF.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "test-runner",
    kind: "subagent",
    name: "Test Runner",
    description: "Runs the test suite and reports failures back to the main agent.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "shell",
    kind: "subagent",
    name: "Shell",
    description: "Run shell command sequences and return trimmed output for long builds and installs.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "browser",
    kind: "subagent",
    name: "Browser",
    description: "Browser automation for UI verification with DOM noise kept out of main chat.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "docs-researcher",
    kind: "subagent",
    name: "Docs Researcher",
    description: "Fetch current library documentation and API references.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "ci-investigator",
    kind: "subagent",
    name: "CI Investigator",
    description: "Diagnose a failing CI check and recommend a fix.",
    enabled: true,
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

/**
 * Bump when DEFAULT_PROVIDERS gains entries; existing agents.json / web
 * localStorage records merge in preset providers they are missing, once.
 */
export const PROVIDER_SEED_VERSION = 3;

function preset(
  id: string,
  name: string,
  baseUrl: string,
  apiFormat: ProviderApiFormat,
  extra: Partial<StoredProviderBase> = {},
): StoredProviderBase {
  return {
    id,
    name,
    kind: "custom",
    preset: true,
    enabled: false,
    baseUrl,
    apiFormat,
    connectionModes: ["API key"],
    activeMode: "API key",
    models: [],
    disabledModels: [],
    ...extra,
  };
}

/** Curated provider catalog shared by desktop, web and CLI (pi-ai-style presets). */
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
  preset("deepseek", "DeepSeek", "https://api.deepseek.com", "chat-completions"),
  preset("openai", "OpenAI", "https://api.openai.com/v1", "chat-completions"),
  preset("anthropic", "Anthropic", "https://api.anthropic.com", "anthropic"),
  preset("google", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "chat-completions"),
  preset("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "chat-completions"),
  preset("groq", "Groq", "https://api.groq.com/openai/v1", "chat-completions"),
  preset("xai", "xAI", "https://api.x.ai/v1", "chat-completions"),
  preset("mistral", "Mistral", "https://api.mistral.ai/v1", "chat-completions"),
  preset("ollama", "Ollama (local)", "http://localhost:11434/v1", "chat-completions", { local: true }),
];

/** Merge preset providers missing from an existing persisted list (once per seed version). */
export function mergePresetProviders(
  existing: StoredProviderBase[],
  seededVersion?: number,
): { providers: StoredProviderBase[]; seedVersion: number } {
  if (seededVersion !== undefined && seededVersion >= PROVIDER_SEED_VERSION) {
    return { providers: existing, seedVersion: seededVersion };
  }
  const have = new Set(existing.map((p) => p.id));
  const missing = DEFAULT_PROVIDERS.filter((p) => !have.has(p.id) && p.kind === "custom");
  if (missing.length === 0) {
    return { providers: existing, seedVersion: PROVIDER_SEED_VERSION };
  }
  return {
    providers: [...existing, ...missing],
    seedVersion: PROVIDER_SEED_VERSION,
  };
}
