import type { DeyinConfig } from "./config.js";

export interface UserProfile {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  plan?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  maxOutputTokens?: number;
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

export interface Bootstrap {
  config: Pick<DeyinConfig, "oauthIssuer" | "apiBaseUrl" | "clientId">;
  user: UserProfile | null;
  workspaceRoot: string | null;
  version: string;
  /** Which runtime hosts the renderer: the Electron shell or a browser tab. */
  platform: "desktop" | "web";
}

export interface TerminalCreateOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  /** A shell id from EnvInfo.shells (e.g. "wsl:Ubuntu-22.04"), or an executable path. */
  shell?: string;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
  exitCode: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/* Environment ------------------------------------------------------------- */

export interface ShellInfo {
  /** Stable id used by TerminalCreateOptions.shell. */
  id: string;
  /** Human label, e.g. "WSL2 · Ubuntu-22.04". */
  label: string;
  path: string;
  args?: string[];
  kind: "wsl" | "posix" | "windows";
}

export interface EnvInfo {
  /** "win32" | "linux" | "darwin" | "web" */
  platform: string;
  arch: string;
  /** True when WSL2 is available (Windows host) or we are running inside WSL2. */
  wsl2: boolean;
  wslDistros: string[];
  shells: ShellInfo[];
  /** Id of the shell terminals default to. */
  defaultShell: string;
  hostname: string;
}

/* Settings ---------------------------------------------------------------- */

export type ApprovalMode = "full-access" | "ask-first" | "read-only";

export interface DeyinSettings {
  theme: "dark" | "light" | "system";
  language: string;
  fontSize: number;
  autoUpdate: boolean;
  telemetry: boolean;
  browserControlEnabled: boolean;
  defaultModel: string | null;
  approvalMode: ApprovalMode;
  /** Reasoning ("thinking") requested from models that support it. */
  thinking: boolean;
  codeThemeLight: string;
  codeThemeDark: string;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  codeFontSize: number;
}

/* Capabilities (plugins / skills / subagents / MCP / commands / hooks) ----- */

export type CapabilityKind = "plugin" | "skill" | "subagent" | "mcp" | "command" | "hook";

export interface CapabilityItem {
  id: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  enabled: boolean;
  version?: string;
  /** Where it comes from: "built-in", "workspace", or a command string for MCP servers. */
  source?: string;
}

/* Model providers ---------------------------------------------------------- */

export interface ProviderPlan {
  id: string;
  name: string;
  headline: string;
  detail: string;
  tone: "green" | "blue";
}

export interface ProviderModel {
  id: string;
  name: string;
  contextLength?: number;
}

export type ProviderApiFormat = "chat-completions" | "responses";

export interface ProviderInfo {
  id: string;
  name: string;
  kind: "primary" | "custom";
  status: "connected" | "not-connected";
  enabled: boolean;
  baseUrl?: string;
  apiFormat: ProviderApiFormat;
  /** True when an API key is stored for this provider (the key itself is never listed). */
  hasKey: boolean;
  connectionModes: string[];
  activeMode: string;
  quotaNote?: string;
  plans: ProviderPlan[];
  /** User-managed model list for custom providers; primary lists live from /v1/models. */
  models: ProviderModel[];
}

export interface ProviderPatch {
  name?: string;
  baseUrl?: string;
  apiFormat?: ProviderApiFormat;
  enabled?: boolean;
  activeMode?: string;
  models?: ProviderModel[];
}

export interface ProviderTestResult {
  ok: boolean;
  status?: number;
  modelCount?: number;
  message?: string;
}

/* Search -------------------------------------------------------------------- */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/* Usage statistics ---------------------------------------------------------- */

export interface UsageEvent {
  model: string;
  tokens: number;
  /** Marks the first message of a fresh session. */
  newSession?: boolean;
}

export interface UsageDay {
  /** YYYY-MM-DD */
  date: string;
  byModel: Record<string, number>;
  messages: number;
  sessions: number;
}

export interface UsageStats {
  totalTokens: number;
  sessions: number;
  messages: number;
  activeDays: number;
  currentStreak: number;
  favoriteModel: { id: string; share: number } | null;
  /** Ascending by date; at most the trailing ~180 days. */
  days: UsageDay[];
}
