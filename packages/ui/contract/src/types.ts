/**
 * Domain types now live in @deyin/host-core (shared by desktop, web and CLI). This
 * module re-exports them so the renderer and main process keep their stable
 * `shared/types.js` import path.
 */
export type {
  Automation,
  AutomationInfo,
  AutomationPayload,
  AutomationRun,
  AutomationRunStatus,
  AutomationTarget,
  AutomationTrigger,
  SshAuthMethod,
  SshHostCredentials,
  SshHostInfo,
  SshHostInput,
  SshTestResult,
  UserProfile,
  ModelInfo,
  FileNode,
  GitStatus,
  GitFileEntry,
  GitFileStatus,
  GitBranch,
  GitRepoInfo,
  GitCommit,
  GitCommitDetail,
  GitFileDiff,
  GitStash,
  GitRemote,
  GitBlameLine,
  GitResultLite,
  Bootstrap,
  TerminalCreateOptions,
  TerminalDataEvent,
  TerminalExitEvent,
  ChatMessage,
  ShellInfo,
  EnvInfo,
  ApprovalMode,
  ChatMode,
  DeyinSettings,
  OnboardProgress,
  CapabilityKind,
  CapabilityItem,
  McpTransport,
  McpServerEntry,
  McpServerInput,
  McpTestResult,
  PluginInfo,
  PluginCatalogEntry,
  IndexStatus,
  IndexSearchHit,
  AgentTodoItem,
  AgentTodoStatus,
  AgentImageInput,
  LocalVisionDescribeResult,
  LocalVisionStatus,
  PlanStep,
  DiffSnippetLine,
  AgentUiEvent,
  AgentEventEnvelope,
  AgentStartOptions,
  ContextUsageSnapshot,
  ContextUsageCategory,
  ContextCategoryId,
  ProviderModel,
  ProviderApiFormat,
  ProviderInfo,
  ProviderPatch,
  ProviderTestResult,
  SearchResult,
  UsageEvent,
  UsageDay,
  UsageStats,
  AccountUsage,
  PublicPlan,
  SelectPlanOptions,
  SelectPlanResponse,
  BillingOverview,
  Upgrade3dsResult,
  LocalizedPrice,
  ServerIdentity,
  IdentityInfo,
  IdentitySyncResult,
  DiagnosticsPayload,
  DiagnosticsResult,
  ThreadEvent,
  Thread,
  Project,
  ProjectsState,
  WorkspaceLocation,
  WorkspaceState,
  DirectoryEntry,
  ContextAttachment,
  LinkedThreadRef,
  ContextSearchHit,
  ContextRef,
  ResolvedContextFile,
  PendingChange,
  ReviewMode,
  ThreadGoal,
  GitLogEntry,
  McpAuthMode,
  McpAuthResult,
  McpAuthStatus,
  McpCatalogCategory,
  McpCatalogEntry,
  McpCatalogInstallInput,
  McpCatalogSecret,
  McpModuleManifest,
} from "@deyin/host-core/shared";

/** Desktop-only: lifecycle state of the in-app updater (main -> renderer). */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error"
  | "unsupported";

export interface UpdatesState {
 status: UpdateStatus;
 currentVersion: string;
 availableVersion?: string;
 /** 0-100 while status is "downloading". */
 progressPercent?: number;
 error?: string;
}

export type SecuritySeverity = "critical" | "high" | "medium" | "low" | "info";
export type SecurityFindingSource = "semgrep" | "regex" | "npm-audit";

export interface SecurityFindingLocation {
  file: string;
  line?: number;
  column?: number;
}

export interface SecurityFinding {
  id: string;
  ruleId: string;
  severity: SecuritySeverity;
  message: string;
  source: SecurityFindingSource;
  location?: SecurityFindingLocation;
}

export interface SecurityFindingsReport {
  version: "1";
  scannedAt: string;
  root?: string;
  scanned?: number;
  sources?: SecurityFindingSource[];
  findings: SecurityFinding[];
}

/** UI cap for tool result content (both streaming tail and final tool-end result). */
export const TOOL_RESULT_UI_CAP = 64_000;

/* Web repo workflow (connect a git repo → work branch → ship) ----------------- */

export interface RepoConnectRequest {
  url: string;
  /** Optional access token for private repos; kept in the session, never persisted. */
  token?: string;
  /** Existing branch to resume (reconnect); omit to create a fresh work branch. */
  branch?: string;
}

export interface RepoStateResult {
  connected: boolean;
  url: string | null;
  branch: string | null;
  defaultBranch: string | null;
}

export interface RepoShipResult {
  ok: boolean;
  /** True when the work branch was merged into the default branch and pushed. */
  merged: boolean;
  branch: string;
  defaultBranch: string;
  /** Commit subjects shipped with this merge (base..branch). */
  commits: string[];
  message: string;
  /** Compare URL offered when direct push/merge is not possible. */
  prUrl: string | null;
}

export type RepoProgressStage = "clone" | "connect" | "ship";

export interface RepoProgressEvent {
  stage: RepoProgressStage;
  line: string;
}

/** GitHub repo entry for the in-app browser. */
export interface GitHubRepoEntry {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  cloneUrl: string;
  defaultBranch: string;
  description: string | null;
}

export interface GitHubAuthState {
  connected: boolean;
  login: string | null;
}

/** One text-to-image run requested from the chat or the agent. */
export interface ImageGenerateRequest {
  threadId: string;
  prompt: string;
  /** Text-to-image model id (from the model catalog). */
  model: string;
  /** Provider routing: omit for the primary (Openference) provider. */
  providerId?: string;
  size?: string;
  n?: number;
  negativePrompt?: string;
}

export interface GeneratedImageInfo {
  /** Stored file name, embedded as ::deyin-inline-image{file="..."}. */
  file: string;
  mediaType: string;
  /** Provider-rewritten prompt, when the endpoint reports one. */
  revisedPrompt?: string;
}

export interface ImageGenerateResult {
  images: GeneratedImageInfo[];
  model: string;
}

/** Keep the last `cap` characters so streaming and tool-end stay consistent. */
export function truncateToolResultUi(text: string, cap = TOOL_RESULT_UI_CAP): string {
  if (text.length <= cap) return text;
  return `… (truncated)\n${text.slice(-cap)}`;
}
