import type { CapabilityItem, DeyinSettings, ProviderInfo } from "./types.js";

export const DEFAULT_SETTINGS: DeyinSettings = {
  theme: "dark",
  language: "en",
  fontSize: 14,
  autoUpdate: true,
  telemetry: false,
  browserControlEnabled: true,
  defaultModel: null,
  approvalMode: "full-access",
  thinking: true,
  welcomeDismissed: false,
  codeThemeLight: "GitHub Light",
  codeThemeDark: "GitHub Dark",
  showLineNumbers: true,
  wrapLongLines: false,
  codeFontSize: 12,
};

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
  // Skills
  {
    id: "review-code",
    kind: "skill",
    name: "review-code",
    description: "Structured review pass over a diff: correctness, security, style.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "generate-tests",
    kind: "skill",
    name: "generate-tests",
    description: "Write unit tests for the selected file or the latest change set.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "refactor",
    kind: "skill",
    name: "refactor",
    description: "Apply a named refactoring across the workspace with a preview diff.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "control-browser",
    kind: "skill",
    name: "browser-use:control-browser",
    description: "Drive the built-in browser: navigate, click, type, screenshot.",
    enabled: true,
    source: "plugin:browser-use",
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
