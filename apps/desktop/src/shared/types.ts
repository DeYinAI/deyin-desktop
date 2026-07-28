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
  DeyinSettings,
  CapabilityKind,
  CapabilityItem,
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
} from "@deyin/host-core/shared";
