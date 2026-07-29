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
