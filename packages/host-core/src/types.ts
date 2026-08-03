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

/* Projects & threads --------------------------------------------------------
 * The renderer's session model: a project is a workspace folder holding chat
 * threads; each thread is a timeline of structured events. Persisted per
 * profile via ProjectsStore (desktop: projects.json, web: localStorage). */

/** Composer interaction mode (Cursor-style), independent of the access ApprovalMode. */
export type ChatMode = "agent" | "plan" | "ask";

export type AgentTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** One checklist entry of the in-chat todo card (status added later; `done` kept
 *  so timelines persisted by older builds still render). */
export interface PlanStep {
  text: string;
  done: boolean;
  status?: AgentTodoStatus;
}

/** One rendered line of a chat file-card diff snippet (persisted with the thread). */
export interface DiffSnippetLine {
  type: "context" | "add" | "del";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export type ThreadEvent =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "reasoning"; text: string; seconds?: number }
  | { kind: "plan"; steps: PlanStep[]; badge?: string }
  /** Compact plan artifact in chat; full markdown lives in the Plan tab. */
  | { kind: "plan-ready"; title?: string; fileName?: string }
  | {
      kind: "file";
      name: string;
      subtitle: string;
      adds: number;
      dels: number;
      /** Capped color-coded diff excerpt rendered inside the chat card. */
      snippet?: DiffSnippetLine[];
      /** Changed lines beyond the snippet cap ("… N more"). */
      snippetMore?: number;
    }
  | { kind: "model-switch"; from: string; to: string }
  | { kind: "skill"; name: string }
  | { kind: "thought"; label: string }
  | { kind: "worked"; seconds: number }
  | { kind: "tool"; name: string; summary: string; result?: string; ok?: boolean; denied?: boolean }
  /** Per-run token-optimization summary card (compression + cache savings). */
  | {
      kind: "optimization";
      originalInputTokens: number;
      compressedInputTokens: number;
      compressionRatio: number;
      cachedPromptTokens: number;
      toolCacheHits: number;
      toolCacheMisses: number;
      responseCacheHits: number;
      responseCacheMisses: number;
      estimatedCostSavingsUsd: number;
    }
  | { kind: "error"; text: string };

export interface Thread {
  id: string;
  title: string;
  /** Epoch ms of the last activity; the sidebar renders it as a relative age. */
  updatedAt: number;
  events: ThreadEvent[];
  /** Composer mode this thread runs in; defaults to "agent". */
  mode?: ChatMode;
  /** Mode before entering plan mode; used by ExitPlanMode. */
  previousMode?: ChatMode;
  /** Whether the user approved the latest plan via ExitPlanMode. */
  planApproved?: boolean;
  /** Markdown produced by the latest plan-mode run; feeds the Plan tab. */
  planMarkdown?: string;
  /** Path to the latest plan artifact on disk. */
  planFilePath?: string;
  /** Latest agent todo list; feeds the pinned task list above the composer. */
  todos?: AgentTodoItem[];
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
}

export interface Project {
  id: string;
  /** Display name — the folder basename for folder-backed projects. */
  name: string;
  /** Absolute path of the workspace folder; null for the default chat-only project. */
  root: string | null;
  threads: Thread[];
}

/** The persistable slice of the renderer's project/session state. */
export interface ProjectsState {
  projects: Project[];
  activeProjectId: string | null;
  activeThreadId: string | null;
  /** Mirrors the active project's root; owned by the host (terminal/files cwd). */
  workspaceRoot: string | null;
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

/** Persisted per-step onboarding progress (account state is derived live). */
export interface OnboardProgress {
  workspaceOpened: boolean;
  terminalUsed: boolean;
  taskRun: boolean;
}

export interface DeyinSettings {
  /** Bumped when the settings shape changes; SettingsStore migrates on load. */
  schemaVersion: number;
  theme: "dark" | "light" | "system";
  language: string;
  fontSize: number;
  autoUpdate: boolean;
  telemetry: boolean;
  browserControlEnabled: boolean;
  defaultModel: string | null;
  /** Per-subagent model overrides: subagent name -> "providerId::modelId". */
  subagentModels: Record<string, string>;
  /** Per-subagent reasoning-effort overrides: name -> "low" | "medium" | "high". */
  subagentEfforts: Record<string, string>;
  /** Default step cap for subagent runs (frontmatter max_steps overrides). */
  subagentMaxSteps: number;
  /** Max subagent runs executing in parallel (1-32). */
  subagentConcurrency: number;
  approvalMode: ApprovalMode;
  /** Reasoning ("thinking") requested from models that support it. */
  thinking: boolean;
  /** Set when the user skips Openference sign-in ("Use API key"); signing out resets it. */
  welcomeDismissed: boolean;
  codeThemeLight: string;
  codeThemeDark: string;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  codeFontSize: number;
  /** "agent" runs the tool-calling loop; "chat" is the plain text stream fallback. */
  agentMode: "agent" | "chat";
  /** Shell id from EnvInfo.shells new terminals default to; null = host default. */
  defaultShell: string | null;
  terminalFontSize: number;
  terminalScrollback: number;
  /** Open the terminal panel when the agent first runs a shell command. */
  revealTerminalOnAgentCommand: boolean;
  /** Live local semantic indexing of the workspace. */
  indexingEnabled: boolean;
  onboard: OnboardProgress;
  /** Run missed cron automations once on app startup. */
  automationsCatchUp: boolean;
  /** Keep scheduler alive in the tray when all windows are closed. */
  keepRunningInBackground: boolean;
  /** Tier-1: compress tool/user payloads before sending to the LLM. */
  optimizationCompression: boolean;
  /** Tier-1 compression aggressiveness. */
  optimizationCompressionMode: "aggressive" | "balanced" | "conservative";
  /** Tier-1: send provider prompt-cache keys / markers. */
  optimizationPromptCaching: boolean;
  /** Tier-2: load semantic optimization plugin. */
  optimizationPluginEnabled: boolean;
  /** Tier-2: semantic tool-result cache. */
  optimizationToolCache: boolean;
  /** Tier-2: semantic response cache. */
  optimizationResponseCache: boolean;
  /** Cosine similarity threshold for semantic cache hits (0.80–0.98). */
  optimizationSimilarityThreshold: number;
  /** Background memory (remember/forget + automatic recall). */
  memoryEnabled: boolean;
}

/* Automations ------------------------------------------------------------- */

export type AutomationTarget =
  | { kind: "local"; workspacePath: string }
  | { kind: "ssh"; hostId: string; workspacePath: string };

export type AutomationTrigger =
  | { kind: "cron"; expression: string }
  | { kind: "manual" };

export interface Automation {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  prompt: string;
  trigger: AutomationTrigger;
  target: AutomationTarget;
  model: string;
  providerId: string;
  createdAt: number;
  updatedAt: number;
  /** Unix ms of last successful scheduled slot (for catch-up). */
  lastScheduledAt?: number;
}

export type AutomationRunStatus = "queued" | "running" | "completed" | "failed" | "aborted";

export interface AutomationRun {
  id: string;
  automationId: string;
  status: AutomationRunStatus;
  startedAt: number;
  finishedAt?: number;
  reason?: string;
  finalText?: string;
  events: AgentUiEvent[];
}

export type SshAuthMethod = "privateKey" | "password";

/** Persisted SSH host metadata; secrets stored as cipher fields. */
export interface StoredSshHost {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  keyCipher?: string;
  passphraseCipher?: string;
  passwordCipher?: string;
  knownHostFingerprint?: string;
}

/** SSH host as exposed to the renderer (no secret values). */
export interface SshHostInfo {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  hasKey: boolean;
  hasPassword: boolean;
  knownHostFingerprint?: string;
}

export interface SshHostInput {
  label: string;
  host: string;
  port?: number;
  username: string;
  authMethod: SshAuthMethod;
}

export interface SshHostCredentials {
  privateKey?: string;
  passphrase?: string;
  password?: string;
}

export interface SshTestResult {
  ok: boolean;
  message: string;
  nodeVersion?: string;
  deyinVersion?: string;
  /** Set on first connect when no fingerprint is pinned yet. */
  hostFingerprint?: string;
}

export interface AutomationInfo extends Automation {
  lastRun?: AutomationRun;
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
  /** Where it comes from: "built-in", "user", "workspace", or "plugin:<name>". */
  source?: string;
  /** Definition file on disk, when the capability is file-backed. */
  path?: string;
  /** Extra transport/command detail (MCP servers, hook commands). */
  detail?: string;
  /** Subagents: settings override "providerId::modelId" (undefined = inherit). */
  model?: string;
  /** Subagents: the model actually used (override ?? frontmatter ?? inherit). */
  effectiveModel?: string;
}

/* MCP servers ---------------------------------------------------------------- */

export type McpTransport = "stdio" | "sse" | "http";

/** One MCP server as shown in settings (merged from config files and built-ins). */
export interface McpServerEntry {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  /** "built-in", "user", "workspace" or "plugin:<name>". */
  source: string;
  /** Config file that defines the server, when file-backed. */
  path?: string;
}

export interface McpTestResult {
  ok: boolean;
  toolCount?: number;
  tools?: string[];
  message?: string;
}

/** User-supplied definition for a custom MCP server (written to ~/.deyin/mcp.json). */
export interface McpServerInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/* Plugins -------------------------------------------------------------------- */

/** An installed plugin (unpacked under <userData>/plugins/<name>). */
export interface PluginInfo {
  name: string;
  description?: string;
  version?: string;
  /** Install origin, e.g. "github:owner/repo" or "local". */
  source: string;
  enabled: boolean;
  installedAt?: string;
  /** Count of each component kind the plugin contributes. */
  components: { skills: number; commands: number; subagents: number; mcpServers: number; hooks: number };
  /** Secret variable names the plugin declares (values stored encrypted). */
  variables?: string[];
}

/** One entry of the DeYinAI/registry catalog. */
export interface PluginCatalogEntry {
  name: string;
  description: string;
  /** "owner/repo" or a full GitHub URL. */
  repo: string;
  version?: string;
  kind?: "plugin" | "skill" | "mcp";
}

/* Indexing ------------------------------------------------------------------- */

export interface IndexStatus {
  state: "disabled" | "no-workspace" | "scanning" | "indexing" | "ready" | "error";
  root: string | null;
  files: number;
  chunks: number;
  /** ISO timestamp of the last completed sync. */
  lastSync: string | null;
  progress?: { done: number; total: number };
  /** Embedding backend in use, e.g. "hash-v1" or an ONNX model id. */
  model: string;
  watching: boolean;
  error?: string;
}

export interface IndexSearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  preview: string;
}

/* Agent sessions (desktop runtime) -------------------------------------------- */

export interface AgentTodoItem {
  id: string;
  content: string;
  status: AgentTodoStatus;
}

/** Context Usage category ids (mirrors agent-core context-usage). */
export type ContextCategoryId =
  | "system"
  | "tools"
  | "rules"
  | "skills"
  | "mcp"
  | "subagents"
  | "conversation";

export interface ContextUsageCategory {
  id: ContextCategoryId;
  label: string;
  tokens: number;
}

/** Live context-window fill estimate for the active thread. */
export interface ContextUsageSnapshot {
  contextLength: number;
  usedTokens: number;
  percent: number;
  categories: ContextUsageCategory[];
  wire?: { originalTokens: number; compressedTokens: number };
  cached?: boolean;
}

/** Renderer-facing events streamed from the main-process agent runtime. */
export type AgentUiEvent =
 | { type: "text-delta"; delta: string }
 | { type: "reasoning-delta"; delta: string }
 | { type: "tool-start"; callId: string; name: string; summary: string }
 | { type: "tool-delta"; callId: string; delta: string }
 | { type: "tool-end"; callId: string; name: string; summary: string; result: string; ok: boolean; denied?: boolean }
 | { type: "file-change"; path: string; before: string; after: string }
 | { type: "todos"; todos: AgentTodoItem[] }
 | { type: "usage"; totalTokens: number }
 | { type: "context-snapshot"; snapshot: ContextUsageSnapshot }
 | { type: "optimization"; originalInputTokens: number; compressedInputTokens: number; compressionRatio: number; cachedPromptTokens: number; toolCacheHits: number; toolCacheMisses: number; responseCacheHits: number; responseCacheMisses: number; estimatedCostSavingsUsd: number }
 | { type: "permission-request"; requestId: string; toolName: string; summary: string }
 | {
     type: "question-request";
     requestId: string;
     title?: string;
     questions: Array<{
       id: string;
       prompt: string;
       allow_multiple?: boolean;
       options: Array<{ id: string; label: string }>;
     }>;
   }
 | {
     type: "plan-created";
     name: string;
     overview?: string;
     plan: string;
     filePath?: string;
   }
 | { type: "mode-changed"; mode: ChatMode; previousMode?: ChatMode; reminder?: string }
 | { type: "subagent-start"; name: string; prompt: string }
 | { type: "subagent-end"; name: string; ok: boolean }
 /** Announces the persistent agent PTY so the renderer can attach an Agent tab. */
 | { type: "shell-session"; terminalId: string; label: string }
 | { type: "done"; reason: "completed" | "max-steps" | "aborted"; finalText: string }
 | { type: "error"; message: string };

export interface AgentEventEnvelope {
  threadId: string;
  event: AgentUiEvent;
}

export interface AgentStartOptions {
  threadId: string;
  prompt: string;
  providerId: string;
  model: string;
  thinking: boolean;
  approvalMode: ApprovalMode;
  /** Composer mode: agent (build), plan (read-only research) or ask (read-only Q&A). */
  mode: ChatMode;
  /** Prior plain-text turns used to rebuild context after a restart. */
  history: { role: "user" | "assistant"; content: string }[];
  /** Seed the agent loop's todo list (e.g. plan todos handed to Build). */
  initialTodos?: AgentTodoItem[];
}

/* Model providers ---------------------------------------------------------- */

export interface ProviderModel {
  id: string;
  name: string;
  contextLength?: number;
}

export type ProviderApiFormat = "chat-completions" | "responses" | "anthropic";

export interface ProviderInfo {
  id: string;
  name: string;
  kind: "primary" | "custom";
  status: "connected" | "not-connected";
  enabled: boolean;
  baseUrl?: string;
  apiFormat: ProviderApiFormat;
  /**
   * Anthropic-compatible gateways that authenticate with `Authorization: Bearer`
   * instead of `x-api-key` (MiniMax Global, Vercel AI Gateway, ...). Ignored for
   * non-anthropic formats.
   */
  authHeader?: boolean;
  /** True when an API key is stored for this provider (the key itself is never listed). */
  hasKey: boolean;
  connectionModes: string[];
  activeMode: string;
  /** Model list: fetched from the provider's /models endpoint, or user-managed for custom providers. */
  models: ProviderModel[];
  /** Model ids the user switched off; they stay hidden from pickers but re-fetch keeps them. */
  disabledModels: string[];
  /** Epoch ms of the last successful /models fetch; drives the 1-week cache. */
  modelsFetchedAt?: number;
}

export interface ProviderPatch {
  name?: string;
  baseUrl?: string;
  apiFormat?: ProviderApiFormat;
  authHeader?: boolean;
  enabled?: boolean;
  activeMode?: string;
  models?: ProviderModel[];
  disabledModels?: string[];
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

/** Server-side account usage reported by Openference (GET {issuer}/api/user/me). */
export interface AccountUsage {
  planName: string | null;
  todayRequests: number;
  weekRequests: number;
  weekTokens: number;
  totalRequests: number;
  totalTokens: number;
  /** Weekly plan limits; null when the plan does not define them. */
  requestsPerWeek: number | null;
  tokensPerWeek: number | null;
  /** ISO timestamp of the next weekly quota reset, when reported. */
  weeklyResetAt: string | null;
  /** Prepaid credit balance in USD, when reported. */
  creditsUsd: number | null;
  /** Identity context, present only when the server reports it. */
  identity?: ServerIdentity | null;
}

/* Identity & access --------------------------------------------------------- */

/** Identity context reported by the Openference account API. Every field is
 *  server-owned; clients must display "not reported" states rather than
 *  inventing values when this is absent. */
export interface ServerIdentity {
  tenant: string | null;
  org: string | null;
  role: string | null;
  policies: string[];
}

/** Everything the Identity & Access page renders, assembled by the host from
 *  live sources (OAuth session, environment, account API, local stores). */
export interface IdentityInfo {
  /** Signed-in Openference profile; null when signed out. */
  member: UserProfile | null;
  /** Plan name from the account snapshot, when reported. */
  plan: string | null;
  /** Active workspace folder name; null for the default chat-only project. */
  workspaceName: string | null;
  workspaceRoot: string | null;
  /** This workstation's hostname. */
  device: string;
  platform: string;
  arch: string;
  version: string;
  /** Stable workspace fingerprint, truncated for display ("d4e9…c731"). */
  fingerprint: string;
  /** Full fingerprint hex; used for sync/diagnostics, not display. */
  fingerprintFull: string;
  oauthIssuer: string;
  apiBaseUrl: string;
  /** ISO timestamp of the last successful identity sync; null when never. */
  lastSyncedAt: string | null;
  /** Server-reported identity context; null when the server does not send one. */
  server: ServerIdentity | null;
  /** Count of secret values stored locally (provider keys + plugin variables). */
  localSecrets: number;
}

export interface IdentitySyncResult {
  ok: boolean;
  /** ISO timestamp persisted locally after a successful sync. */
  syncedAt: string | null;
  message?: string;
}

/* Diagnostics ---------------------------------------------------------------- */

/** What the client POSTs to {issuer}/api/diagnostics. Everything sensitive is
 *  stripped or hashed before upload — see redact.ts. */
export interface DiagnosticsPayload {
  reportId: string;
  createdAt: string;
  appVersion: string;
  platform: string;
  arch: string;
  /** Workspace fingerprint (pseudonymous; no paths or hostnames). */
  fingerprintFull: string;
  /** Anonymous install id shared with telemetry. */
  installId: string;
  env: { platform: string; arch: string; wsl2: boolean; defaultShell: string };
  /** Redacted settings snapshot (no secret material by construction). */
  settings: Record<string, unknown>;
  /** Tail of the app log, secret-scrubbed. */
  logTail: string;
  /** Anonymous usage counters; included only when telemetry is enabled. */
  usageStats?: { totalTokens: number; sessions: number; messages: number; activeDays: number };
  /** Free-text note from the user describing the problem. */
  note?: string;
}

export interface DiagnosticsResult {
  ok: boolean;
  /** Server-echoed (or locally assigned) report id the user can reference. */
  reportId?: string;
  sentAt?: string;
  message?: string;
}

/* Git ------------------------------------------------------------------------ */

/** Per-file change kind, derived from porcelain-v2 XY codes. */
export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted" | "typechange";

/** One changed path in the working tree or index. */
export interface GitFileEntry {
  path: string;
  /** Previous path for renames/copies. */
  orig?: string;
  status: GitFileStatus;
  /** True when the change is in the index (staged side of the XY code). */
  staged: boolean;
}

/** Parsed `git status --porcelain=v2 --branch`. */
export interface GitStatus {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
  conflicts: GitFileEntry[];
}

export interface GitBranch {
  /** Short name, e.g. "main" or "origin/main". */
  name: string;
  current: boolean;
  /** True for refs under refs/remotes. */
  remote: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

export interface GitRepoInfo {
  isRepo: boolean;
  /** Workspace root the info is for (null when not a repo). */
  root: string | null;
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  remotes: string[];
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authorEmail: string;
  /** ISO 8601 author date. */
  date: string;
  parents: string[];
}

/** A commit plus the files it changed (for the history viewer). */
export interface GitCommitDetail {
  commit: GitCommit;
  files: GitFileEntry[];
}

/** Before/after blobs for a single file, fed to the LCS diff renderer. */
export interface GitFileDiff {
  path: string;
  orig?: string;
  before: string;
  after: string;
  binary: boolean;
}

export interface GitStash {
  index: number;
  message: string;
  branch?: string;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitBlameLine {
  line: number;
  hash: string;
  author: string;
  date: string;
  summary: string;
  content: string;
}

/** Lightweight result for mutating git ops (toast-friendly, no raw stderr structure). */
export interface GitResultLite {
  ok: boolean;
  message: string;
}

/** Context attachment types for @ mentions */
export interface ContextRef {
  path: string;
  kind: "file" | "folder";
}

export interface ContextSearchHit {
  path: string;
  kind: "file" | "folder";
  label: string;
}

export interface ResolvedContextFile {
  path: string;
  kind: "file" | "folder";
  content: string;
  truncated?: boolean;
}
