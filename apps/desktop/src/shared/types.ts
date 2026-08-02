/**
 * Domain types now live in @deyin/host-core (shared by desktop, web and CLI). This
 * module re-exports them so the renderer and main process keep their stable
 * `shared/types.js` import path.
 */
export type {
  UserProfile,
  ModelInfo,
  FileNode,
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
  Automation,
  AutomationInfo,
  AutomationRun,
  AutomationTarget,
  AutomationTrigger,
  SshHostInfo,
  SshHostInput,
  SshHostCredentials,
  SshTestResult,
  SshAuthMethod,
  ContextAttachment,
  LinkedThreadRef,
  ContextSearchHit,
  ContextRef,
  ResolvedContextFile,
  PendingChange,
  ReviewMode,
  ThreadGoal,
  GitStatus,
  GitFileStatus,
  GitBranch,
  GitLogEntry,
  McpAuthMode,
  McpAuthResult,
  McpAuthStatus,
  McpCatalogCategory,
  McpCatalogEntry,
  McpCatalogInstallInput,
  McpCatalogSecret,
  McpModuleManifest,
  ReasonixMetricsSnapshot,
  ReasonixWeeklyReport,
  ReasonixDiagnostics,
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

/** Keep the last `cap` characters so streaming and tool-end stay consistent. */
export function truncateToolResultUi(text: string, cap = TOOL_RESULT_UI_CAP): string {
  if (text.length <= cap) return text;
  return `… (truncated)\n${text.slice(-cap)}`;
}
