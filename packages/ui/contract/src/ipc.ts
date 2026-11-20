import type { Settings as SuperagentSettings, SuperagentView } from "@deyin/superagent/client";
import type {
  AccountUsage,
  AgentEventEnvelope,
  AgentImageInput,
  AgentStartOptions,
  AgentUiEvent,
  Automation,
  AutomationInfo,
  AutomationRun,
  Bootstrap,
  CapabilityItem,
  CapabilityKind,
  SshHostCredentials,
  SshHostInfo,
  SshHostInput,
  SshTestResult,
  DeyinSettings,
  DiagnosticsResult,
  EnvInfo,
  ImageGenerateRequest,
  ImageGenerateResult,
  VideoGenerateRequest,
  VideoGenerateResult,
  LocalVisionDescribeResult,
  LocalVisionStatus,
  FileNode,
  GitBlameLine,
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitFileDiff,
  GitRemote,
  GitRepoInfo,
  GitStash,
  GitStatus,
  GitResultLite,
  IdentityInfo,
  IdentitySyncResult,
  IndexSearchHit,
  IndexStatus,
  McpServerEntry,
  McpServerInput,
  McpTestResult,
  McpCatalogEntry,
  McpCatalogInstallInput,
  McpModuleManifest,
  McpAuthResult,
  McpAuthStatus,
  ModelInfo,
  PluginCatalogEntry,
  PluginInfo,
  ProjectsState,
  ProviderInfo,
  ProviderPatch,
  ProviderTestResult,
  SearchResult,
  TerminalCreateOptions,
  TerminalDataEvent,
  TerminalExitEvent,
  UpdatesState,
  UsageEvent,
  UsageStats,
  UserProfile,
  PublicPlan,
  ReleaseStatus,
  SelectPlanOptions,
  SelectPlanResponse,
  BillingOverview,
  ContextSearchHit,
  ContextRef,
  ResolvedContextFile,
  PendingChange,
  SecurityFindingsReport,
  RevertResult,
  ThreadEvent,
  RepoConnectRequest,
  RepoStateResult,
  RepoShipResult,
  RepoProgressEvent,
  WorkspaceState,
  DirectoryEntry,
  GitHubRepoEntry,
  GitHubAuthState,
  ExternalAgentDescriptor,
  ConductorWorkflowDefinition,
  BotAvatarPicture,
  BotAvatarRequest,
  BotInput,
  BotMemoryFactView,
  BotPatch,
  BotResult,
  BotRosterLayout,
  BotsSnapshot,
  BotPermissionSettings,
  DeyinBot,
  VaultItem,
  VaultSnapshot,
  EngineHostView,
  EngineSetupEvent,
  EngineStatusView,
  RuntimeHealth,
  BotSkill,
  BotSkillInput,
  BotSkillSummary,
  SkillRevision,
  RuntimeFileEntry,
  ExportedTemplate,
  TemplatePreview,
  ImportOptions,
  ImportedBot,
  CatalogListing,
  CatalogCategory,
  FileScope,
  FileContent,
  CopyDirection,
  TeachState,
  TeachDraft,
  BotSurfacesState,
  HubSettings,
  HubStatus,
  OutboxPost,
  SurfaceInput,
  SurfaceKind,
  SurfaceSaved,
  SurfaceView,
} from "./types.js";

/** Decision for an agent permission request (mirrors agent-core). */
export type AgentPermissionDecision = "allow" | "allow-always" | "deny";

/** Result of create/update — includes the mutated automation so UI can select by id. */
export interface AutomationMutationResult {
  automation: Automation;
  list: AutomationInfo[];
}

/** One kernel-hosted plugin's lifecycle state, for the Plugins settings page. */
export interface KernelPluginStatus {
  name: string;
  state: "registered" | "active" | "lazy" | "failed" | "disposed";
  error?: string;
  /** Config layer that pulled the plugin in ("bundle:base", "profile:desktop", ...). */
  source?: string;
}

/** Health check for the Windows computer-use native sidecar. */
export interface ComputerUseHostStatus {
  ok: boolean;
  error?: string;
  hostPath?: string;
  hostExists?: boolean;
}

/**
 * What computer use is doing right now. `background` = acting through UIA/window
 * messages without touching the user's input; `input` = raw mouse/keyboard,
 * which does move the real cursor and briefly takes focus; `paused` = the user
 * grabbed the mouse or keyboard mid-action, so the agent waits for Resume or Stop.
 */
export interface ComputerUseState {
  phase: "idle" | "background" | "input" | "paused";
  /** App (process) being driven, when known. */
  app?: string;
  /** Short human label for the current action, e.g. "click e12". */
  action?: string;
  /** Where raw input is about to land, in physical screen pixels (for the on-screen cue). */
  point?: { x: number; y: number };
}

/** One tab as seen through the Chrome extension. */
export interface ChromeTabInfo {
  id: number;
  title: string;
  url: string;
  /**
   * agent = opened by Deyin; shared = the user shared it from the extension popup.
   * The extension never reports any other tab, so none is ever listed here.
   */
  kind: "agent" | "shared";
  /** Thread that owns an agent tab. */
  owner?: string;
}

/** Live state of the Chrome extension bridge (Settings → Chrome). */
export interface ChromeBridgeStatus {
  enabled: boolean;
  listening: boolean;
  port: number | null;
  /** Extension id the relay accepts connections from. */
  extensionId: string;
  connection: "disconnected" | "pairing" | "connected";
  /** Six-digit code to compare with the extension popup while pairing. */
  pairingCode: string | null;
  /** Epoch ms when the open pairing window closes, if one is open. */
  pairingOpenUntil: number | null;
  /** The user pressed Stop in the extension; commands are refused until resumed. */
  stopped: boolean;
  browser: { label: string; userAgent: string } | null;
  pairedBrowsers: Array<{ browserId: string; label: string; pairedAt: number }>;
  tabs: ChromeTabInfo[];
  /** Folder with the unpacked extension, for "Load unpacked". */
  extensionPath: string | null;
  error?: string;
}

/** Main → renderer command for multi-tab browser control. */
export type BrowserTabCommand =
  | { action: "open"; url: string }
  | { action: "switch"; tabId: number }
  | { action: "close"; tabId: number };

/** IPC channel identifiers, shared by main and preload so they never drift. */
export const CH = {
  bootstrap: "deyin:bootstrap",
  authConnect: "deyin:auth:connect",
  authLogout: "deyin:auth:logout",
  authGetUser: "deyin:auth:getUser",
  authGetToken: "deyin:auth:getToken",
  authChanged: "deyin:auth:changed",
  modelsList: "deyin:models:list",
  modelsRefresh: "deyin:models:refresh",
  filesTree: "deyin:files:tree",
  filesRead: "deyin:files:read",
  filesWrite: "deyin:files:write",
  workspaceOpen: "deyin:workspace:open",
  workspaceSetRoot: "deyin:workspace:setRoot",
  workspaceGetRoot: "deyin:workspace:getRoot",
  workspaceRootChanged: "deyin:workspace:rootChanged",
  workspaceListDirectory: "deyin:workspace:listDirectory",
  workspaceGetLocation: "deyin:workspace:getLocation",
  workspaceConnectRemote: "deyin:workspace:connectRemote",
  workspaceDisconnectRemote: "deyin:workspace:disconnectRemote",
  workspaceLocationChanged: "deyin:workspace:locationChanged",
  sshBrowse: "deyin:ssh:browse",
  repoConnect: "deyin:repo:connect",
  repoState: "deyin:repo:state",
  repoProgress: "deyin:repo:progress",
  githubConnect: "deyin:github:connect",
  githubDisconnect: "deyin:github:disconnect",
  githubAuthState: "deyin:github:authState",
  githubListRepos: "deyin:github:listRepos",
  gitInfo: "deyin:git:info",
  gitStatus: "deyin:git:status",
  gitBranches: "deyin:git:branches",
  gitCheckout: "deyin:git:checkout",
  gitStage: "deyin:git:stage",
  gitUnstage: "deyin:git:unstage",
  gitDiscard: "deyin:git:discard",
  gitCommit: "deyin:git:commit",
  gitFetch: "deyin:git:fetch",
  gitPull: "deyin:git:pull",
  gitPush: "deyin:git:push",
  gitCreateBranch: "deyin:git:createBranch",
  gitDeleteBranch: "deyin:git:deleteBranch",
  gitLog: "deyin:git:log",
  gitShow: "deyin:git:show",
  gitDiffFile: "deyin:git:diffFile",
  gitDiffCommit: "deyin:git:diffCommit",
  gitBlame: "deyin:git:blame",
  gitRemotes: "deyin:git:remotes",
  gitStashList: "deyin:git:stashList",
  gitStashPush: "deyin:git:stashPush",
  gitStashPop: "deyin:git:stashPop",
  gitStashDrop: "deyin:git:stashDrop",
  gitChanged: "deyin:git:changed",
  projectsGet: "deyin:projects:get",
  projectsSet: "deyin:projects:set",
  termCreate: "deyin:term:create",
  termAttach: "deyin:term:attach",
  termWrite: "deyin:term:write",
  termResize: "deyin:term:resize",
  termKill: "deyin:term:kill",
  termData: "deyin:term:data",
  termExit: "deyin:term:exit",
  envDetect: "deyin:env:detect",
  settingsGet: "deyin:settings:get",
  settingsSet: "deyin:settings:set",
  capsList: "deyin:caps:list",
  capsToggle: "deyin:caps:toggle",
  mcpList: "deyin:mcp:list",
  mcpAdd: "deyin:mcp:add",
  mcpRemove: "deyin:mcp:remove",
  mcpTest: "deyin:mcp:test",
  mcpCatalogList: "deyin:mcp:catalog:list",
  mcpCatalogInstall: "deyin:mcp:catalog:install",
  mcpModulesList: "deyin:mcp:modules:list",
  mcpModulesUninstall: "deyin:mcp:modules:uninstall",
  mcpAuthenticate: "deyin:mcp:authenticate",
  mcpAuthRevoke: "deyin:mcp:auth:revoke",
  mcpAuthStatus: "deyin:mcp:auth:status",
  pluginsList: "deyin:plugins:list",
  pluginsCatalog: "deyin:plugins:catalog",
  pluginsInstall: "deyin:plugins:install",
  pluginsUninstall: "deyin:plugins:uninstall",
  pluginsSetVariable: "deyin:plugins:setVariable",
  pluginsVariableState: "deyin:plugins:variableState",
  pluginsKernelStatus: "deyin:plugins:kernelStatus",
  indexStatus: "deyin:index:status",
  indexRebuild: "deyin:index:rebuild",
  indexSearch: "deyin:index:search",
  indexStatusEvent: "deyin:index:statusEvent",
  agentStart: "deyin:agent:start",
  agentStop: "deyin:agent:stop",
  agentResetSession: "deyin:agent:resetSession",
  agentApprove: "deyin:agent:approve",
  agentAnswerQuestion: "deyin:agent:answerQuestion",
  agentAnswerSecureForm: "deyin:agent:answerSecureForm",
  agentDisposeShell: "deyin:agent:disposeShell",
  agentEvent: "deyin:agent:event",
  browserRegister: "deyin:browser:register",
  browserTabSync: "deyin:browser:tabSync",
  browserTabRemove: "deyin:browser:tabRemove",
  browserGetPartition: "deyin:browser:getPartition",
  browserClearProfile: "deyin:browser:clearProfile",
  browserEnsure: "deyin:browser:ensure",
  browserTabCommand: "deyin:browser:tabCommand",
  browserActive: "deyin:browser:active",
  computerUseState: "deyin:computerUse:state",
  computerUseStop: "deyin:computerUse:stop",
  computerUseResume: "deyin:computerUse:resume",
  chromeGetStatus: "deyin:chrome:getStatus",
  chromeStatus: "deyin:chrome:status",
  chromeBeginPairing: "deyin:chrome:beginPairing",
  chromeCancelPairing: "deyin:chrome:cancelPairing",
  chromeForgetBrowser: "deyin:chrome:forgetBrowser",
  chromeStop: "deyin:chrome:stop",
  chromeResume: "deyin:chrome:resume",
  chromeCloseAgentTabs: "deyin:chrome:closeAgentTabs",
  chromeGetApprovedOrigins: "deyin:chrome:getApprovedOrigins",
  chromeSetApprovedOrigins: "deyin:chrome:setApprovedOrigins",
  chromeOpenExtensionFolder: "deyin:chrome:openExtensionFolder",
  chromeOriginApprovalRequest: "deyin:chrome:originApproval-request",
  chromeOriginApprovalRespond: "deyin:chrome:originApproval-respond",
  chromeActive: "deyin:chrome:active",
  computerUseGetAllowlist: "deyin:computerUse:getAllowlist",
  computerUseSetAllowlist: "deyin:computerUse:setAllowlist",
  computerUseListApps: "deyin:computerUse:listApps",
  computerUseGetHostStatus: "deyin:computerUse:getHostStatus",
  computerUseAppApprovalRequest: "deyin:computerUse:appApproval-request",
  computerUseAppApprovalRespond: "deyin:computerUse:appApproval-respond",
  workspaceTrustRequest: "deyin:workspace:trust-request",
  workspaceTrustRespond: "deyin:workspace:trust-respond",
  visualizeRead: "deyin:visualize:read",
  pageRead: "deyin:page:read",
  imagesSave: "deyin:images:save",
  imagesRead: "deyin:images:read",
  imagesGenerate: "deyin:images:generate",
  videosSave: "deyin:videos:save",
  videosRead: "deyin:videos:read",
  videosGenerate: "deyin:videos:generate",
  visionDescribeLocal: "deyin:vision:describeLocal",
  visionLocalStatus: "deyin:vision:localStatus",
  telemetryRecord: "deyin:telemetry:record",
  providersList: "deyin:providers:list",
  providersAdd: "deyin:providers:add",
  providersUpdate: "deyin:providers:update",
  providersRemove: "deyin:providers:remove",
  providersSetKey: "deyin:providers:setKey",
  providersGetKey: "deyin:providers:getKey",
  providersTest: "deyin:providers:test",
  providersFetchModels: "deyin:providers:fetchModels",
  usageGet: "deyin:usage:get",
  usageRecord: "deyin:usage:record",
  usageAccount: "deyin:usage:account",
  plansList: "deyin:plans:list",
  plansReleaseStatus: "deyin:plans:releaseStatus",
  billingSelectPlan: "deyin:billing:selectPlan",
  billingOverview: "deyin:billing:overview",
  billingPublishableKey: "deyin:billing:publishableKey",
  billingCompleteCrossCurrency: "deyin:billing:completeCrossCurrency",
  billingAbortCrossCurrency: "deyin:billing:abortCrossCurrency",
  winMinimize: "deyin:win:minimize",
  winToggleMaximize: "deyin:win:toggleMaximize",
  winClose: "deyin:win:close",
  browserClearCache: "deyin:browser:clearCache",
  browserClearAll: "deyin:browser:clearAll",
  searchQuery: "deyin:search:query",
  shellShowItem: "deyin:shell:showItem",
  shellOpenExternal: "deyin:shell:openExternal",
  clipboardReadText: "deyin:clipboard:readText",
  clipboardWriteText: "deyin:clipboard:writeText",
  contextMenu: "deyin:contextMenu:show",
  pathsGet: "deyin:paths:get",
  updatesGetState: "deyin:updates:getState",
  updatesCheck: "deyin:updates:check",
  updatesDownload: "deyin:updates:download",
  updatesInstall: "deyin:updates:install",
  updatesState: "deyin:updates:state",
  identityGet: "deyin:identity:get",
  identitySync: "deyin:identity:sync",
  diagnosticsSend: "deyin:diagnostics:send",
  logWrite: "deyin:log:write",
  contextSearch: "deyin:context:search",
  contextResolve: "deyin:context:resolve",
  reviewList: "deyin:review:list",
  reviewApprove: "deyin:review:approve",
  reviewReject: "deyin:review:reject",
  reviewApproveAll: "deyin:review:approveAll",
  reviewRejectAll: "deyin:review:rejectAll",
  checkpointsRevertRun: "deyin:checkpoints:revertRun",
  checkpointsRevertFile: "deyin:checkpoints:revertFile",
  checkpointsRevertAfterEvent: "deyin:checkpoints:revertAfterEvent",
  securityListFindings: "deyin:security:listFindings",
  securityClearFindings: "deyin:security:clearFindings",
  securityScanDiff: "deyin:security:scanDiff",
  securityFindingsChanged: "deyin:security:findingsChanged",
  betaFeedbackSubmit: "deyin:beta:feedback",
  automationsList: "deyin:automations:list",
  automationsCreate: "deyin:automations:create",
  automationsUpdate: "deyin:automations:update",
  automationsDelete: "deyin:automations:delete",
  automationsToggle: "deyin:automations:toggle",
  automationsRevertLearned: "deyin:automations:revertLearned",
  automationsRun: "deyin:automations:run",
  automationsStop: "deyin:automations:stop",
  automationsRuns: "deyin:automations:runs",
  automationEvent: "deyin:automations:event",
  automationRunFinished: "deyin:automations:runFinished",
  automationsChanged: "deyin:automations:changed",
  sshHostsList: "deyin:ssh:list",
  sshHostsAdd: "deyin:ssh:add",
  sshHostsUpdate: "deyin:ssh:update",
  sshHostsRemove: "deyin:ssh:remove",
  sshHostsSetCredentials: "deyin:ssh:setCredentials",
  sshHostsTest: "deyin:ssh:test",
  sshHostsPinFingerprint: "deyin:ssh:pinFingerprint",
  sshHostsImportKey: "deyin:ssh:importKey",
  wslTestDistro: "deyin:automations:wslTest",
  externalAgentsList: "deyin:externalAgents:list",
  externalAgentsTest: "deyin:externalAgents:test",
  externalAgentsRun: "deyin:externalAgents:run",
  externalAgentsAbort: "deyin:externalAgents:abort",
  externalAgentsNudge: "deyin:externalAgents:nudge",
  externalAgentsLogs: "deyin:externalAgents:logs",
  conductorWorkflowsList: "deyin:conductorWorkflows:list",
  conductorWorkflowsSave: "deyin:conductorWorkflows:save",
  conductorWorkflowsDelete: "deyin:conductorWorkflows:delete",
  conductorWorkflowsRun: "deyin:conductorWorkflows:run",
  conductorWorkflowsAbort: "deyin:conductorWorkflows:abort",
  conductorWorkflowsMerge: "deyin:conductorWorkflows:merge",
  conductorWorkflowsEvent: "deyin:conductorWorkflows:event",
  botsList: "deyin:bots:list",
  botsCreate: "deyin:bots:create",
  botsUpdate: "deyin:bots:update",
  botsArchive: "deyin:bots:archive",
  botsRestore: "deyin:bots:restore",
  botsDelete: "deyin:bots:delete",
  botsSetPrimary: "deyin:bots:setPrimary",
  botsSetPinned: "deyin:bots:setPinned",
  botsSetHidden: "deyin:bots:setHidden",
  botsAddSection: "deyin:bots:addSection",
  botsRenameSection: "deyin:bots:renameSection",
  botsRemoveSection: "deyin:bots:removeSection",
  botsMoveToSection: "deyin:bots:moveToSection",
  botsMemoryList: "deyin:bots:memoryList",
  botsMemoryForget: "deyin:bots:memoryForget",
  botsMemoryShare: "deyin:bots:memoryShare",
  botsChanged: "deyin:bots:changed",
  botAvatarGenerate: "deyin:botAvatar:generate",
  botSkillsList: "deyin:botSkills:list",
  botSkillsGet: "deyin:botSkills:get",
  botSkillsSave: "deyin:botSkills:save",
  botSkillsRemove: "deyin:botSkills:remove",
  botSkillsRevisions: "deyin:botSkills:revisions",
  botSkillsRevert: "deyin:botSkills:revert",
  botSkillsChanged: "deyin:botSkills:changed",
  botTemplatesExport: "deyin:botTemplates:export",
  botTemplatesPreview: "deyin:botTemplates:preview",
  botTemplatesImport: "deyin:botTemplates:import",
  botTemplatesCatalog: "deyin:botTemplates:catalog",
  botTemplatesImportCatalog: "deyin:botTemplates:importCatalog",
  botTemplatesTakeLink: "deyin:botTemplates:takeLink",
  botTemplatesLink: "deyin:botTemplates:link",
  botFilesList: "deyin:botFiles:list",
  botFilesRead: "deyin:botFiles:read",
  botFilesWrite: "deyin:botFiles:write",
  botFilesRemove: "deyin:botFiles:remove",
  botFilesCopy: "deyin:botFiles:copy",
  botFilesChanged: "deyin:botFiles:changed",
  botTeachState: "deyin:botTeach:state",
  botTeachStart: "deyin:botTeach:start",
  botTeachNote: "deyin:botTeach:note",
  botTeachStop: "deyin:botTeach:stop",
  botTeachCancel: "deyin:botTeach:cancel",
  botTeachSave: "deyin:botTeach:save",
  botTeachChanged: "deyin:botTeach:changed",
  botSurfacesState: "deyin:botSurfaces:state",
  botSurfacesSave: "deyin:botSurfaces:save",
  botSurfacesRemake: "deyin:botSurfaces:remake",
  botSurfacesSetEnabled: "deyin:botSurfaces:setEnabled",
  botSurfacesRemove: "deyin:botSurfaces:remove",
  botSurfacesSetHub: "deyin:botSurfaces:setHub",
  botSurfacesOutboxEdit: "deyin:botSurfaces:outboxEdit",
  botSurfacesOutboxApprove: "deyin:botSurfaces:outboxApprove",
  botSurfacesOutboxDeny: "deyin:botSurfaces:outboxDeny",
  botSurfacesChanged: "deyin:botSurfaces:changed",
  botPermissionsGet: "deyin:botPermissions:get",
  botPermissionsUpdate: "deyin:botPermissions:update",
  botPermissionsChanged: "deyin:botPermissions:changed",
  vaultGet: "deyin:vault:get",
  vaultSave: "deyin:vault:save",
  vaultRemove: "deyin:vault:remove",
  vaultRevoke: "deyin:vault:revoke",
  vaultChanged: "deyin:vault:changed",
  enginesList: "deyin:engines:list",
  enginesStatus: "deyin:engines:status",
  enginesInstall: "deyin:engines:install",
  enginesCancel: "deyin:engines:cancel",
  enginesUninstall: "deyin:engines:uninstall",
  enginesForget: "deyin:engines:forget",
  enginesHealth: "deyin:engines:health",
  enginesChanged: "deyin:engines:changed",
  enginesSetup: "deyin:engines:setup",
  superagentView: "deyin:superagent:view",
  superagentSaveSettings: "deyin:superagent:saveSettings",
  superagentSetToken: "deyin:superagent:setToken",
  superagentClearToken: "deyin:superagent:clearToken",
  superagentVerify: "deyin:superagent:verify",
  superagentStopTicket: "deyin:superagent:stopTicket",
  superagentRetryTicket: "deyin:superagent:retryTicket",
  superagentRequeue: "deyin:superagent:requeue",
  superagentReset: "deyin:superagent:reset",
  superagentChanged: "deyin:superagent:changed",
} as const;

/** A Superagent call's outcome; a failure carries a message meant for the person, not an exception across IPC. */
export type SuperagentReply<T = SuperagentView> = { ok: true; value: T } | { ok: false; error: string };

/** What the agent account's token can do on the watched repository. */
export interface SuperagentVerification {
  login: string;
  canPush: boolean;
  repository: string;
}

/**
 * Where a right-click happened, so the menu can offer the right actions.
 *
 * `text` adds Cut/Copy/Paste to an editable field; `selection` adds Copy for a
 * read-only selection; `terminal` is the xterm canvas, which draws its own
 * selection and needs the host to move text in and out of it.
 */
export interface ContextMenuRequest {
  kind: "text" | "terminal";
  /** Editable field: the menu may replace the selection or the whole field. */
  editable?: boolean;
  /** Non-empty selection, so Copy is worth offering. */
  hasSelection?: boolean;
  /** Viewport position to open at; defaults to the current pointer. */
  x?: number;
  y?: number;
}

/** The action picked from the native context menu; null when dismissed. */
export type ContextMenuCommand = "cut" | "copy" | "paste" | "selectAll";

/** The API the preload script exposes on `window.deyin`. */
export interface DeyinApi {
  bootstrap(): Promise<Bootstrap>;
  auth: {
    /** Begins sign-in. Resolves to the profile (loopback/dev) or null when the
     *  deep-link flow will finish asynchronously — listen via `onChanged`. */
    connect(): Promise<UserProfile | null>;
    logout(): Promise<void>;
    getUser(): Promise<UserProfile | null>;
    getAccessToken(): Promise<string | null>;
    /** Fires after a browser deep-link login (or logout) changes the session. */
    onChanged(cb: () => void): () => void;
  };
  models: {
    /** Cached model catalog (1 week TTL). */
    list(): Promise<ModelInfo[]>;
    /** Force a live /models fetch and refresh the cache. */
    refresh(): Promise<ModelInfo[]>;
  };
  files: {
    tree(dir?: string): Promise<FileNode[]>;
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
  };
  workspace: {
    /**
     * Native folder picker. `startIn` opens it somewhere specific — Windows
     * hosts pass a `\\wsl.localhost\<distro>` root so a WSL project is one
     * click away instead of a path the user has to type.
     */
    openFolder(startIn?: string): Promise<string | null>;
    /** In-app folder browser: list directories at an absolute path. */
    listDirectory(path: string): Promise<DirectoryEntry[]>;
    /** Point the host's workspace cwd at a folder (terminal/files/agent); persisted. */
    setRoot(root: string | null): Promise<void>;
    /** Connect to a remote SSH host and open a folder there. */
    connectRemote(hostId: string, remotePath: string): Promise<WorkspaceState>;
    disconnectRemote(): Promise<WorkspaceState>;
    getLocation(): Promise<WorkspaceState>;
    /** Current workspace / sandbox root (may change after a web host reconnect). */
    getRoot(): Promise<string | null>;
    /** Fires when the host workspace/sandbox root changes (desktop setRoot or web reconnect). */
    onRootChanged(cb: (root: string | null) => void): () => void;
    /** Fires when workspace location or connection state changes. */
    onLocationChanged(cb: (state: WorkspaceState) => void): () => void;
  };
  git: {
    /** Repo detection + branch/ahead/behind for the current workspace root. */
    info(): Promise<GitRepoInfo>;
    /** Full working-tree/index status (staged, unstaged, untracked, conflicts). */
    status(): Promise<GitStatus>;
    /** Local + remote branches. */
    branches(): Promise<GitBranch[]>;
    /** Switch to an existing branch. */
    checkout(name: string): Promise<GitResultLite>;
    /** Stage paths (empty array stages everything). */
    stage(paths: string[]): Promise<GitResultLite>;
    /** Unstage paths (empty array unstages everything). */
    unstage(paths: string[]): Promise<GitResultLite>;
    /** Discard working-tree changes / remove untracked paths. */
    discard(paths: string[]): Promise<GitResultLite>;
    /** Commit the staged index. */
    commit(message: string, opts?: { amend?: boolean }): Promise<GitResultLite>;
    fetch(): Promise<GitResultLite>;
    pull(opts?: { rebase?: boolean }): Promise<GitResultLite>;
    push(opts?: { setUpstream?: boolean }): Promise<GitResultLite>;
    createBranch(name: string, from?: string): Promise<GitResultLite>;
    deleteBranch(name: string, force?: boolean): Promise<GitResultLite>;
    /** Commit history (paginated). */
    log(opts?: { limit?: number; skip?: number; path?: string; ref?: string }): Promise<GitCommit[]>;
    /** A commit's metadata + changed files. */
    show(ref: string): Promise<GitCommitDetail>;
    /** Before/after blobs for a file in the given diff mode. */
    diffFile(path: string, mode: "worktree" | "staged" | "head"): Promise<GitFileDiff>;
    /** Before/after blobs for a file at a commit vs its parent. */
    diffCommit(ref: string, path: string): Promise<GitFileDiff>;
    blame(path: string): Promise<GitBlameLine[]>;
    remotes(): Promise<GitRemote[]>;
    stashList(): Promise<GitStash[]>;
    stashPush(message?: string, includeUntracked?: boolean): Promise<GitResultLite>;
    stashPop(index?: number): Promise<GitResultLite>;
    stashDrop(index: number): Promise<GitResultLite>;
    /** Fires when the workspace's git state changes (watcher or a completed op). */
    onChanged(cb: () => void): () => void;
  };
  /**
   * Web repo workflow (connect a git repo into the session sandbox, work on a
   * dedicated branch, ship via commit → push → merge). Optional: only the web
   * transport implements it; desktop uses workspace.openFolder + git.
   */
  /**
   * Scheduled + manual agent runs (desktop only — the web host has no scheduler,
   * so it leaves this undefined rather than stubbing one).
   */
  automations?: {
    list(): Promise<AutomationInfo[]>;
    create(input: Omit<Automation, "id" | "createdAt" | "updatedAt">): Promise<AutomationMutationResult>;
    update(id: string, patch: Partial<Omit<Automation, "id" | "createdAt">>): Promise<AutomationMutationResult>;
    remove(id: string): Promise<AutomationInfo[]>;
    toggle(id: string, enabled: boolean): Promise<AutomationInfo[]>;
    /** Undo one of the healer's changes to this automation's learned rules, and every change after it. */
    revertLearned(id: string, revisionId: string): Promise<AutomationInfo[]>;
    run(id: string): Promise<AutomationRun>;
    stop(runId: string): void;
    runs(automationId?: string): Promise<AutomationRun[]>;
    /** Probe a WSL distro for Node 20+ and the deyin CLI. */
    testWsl(distro: string): Promise<{ ok: boolean; message: string; nodeVersion?: string; deyinVersion?: string }>;
    onEvent(cb: (payload: { runId: string; automationId: string; event: AgentUiEvent }) => void): () => void;
    onRunFinished(cb: (payload: { run: AutomationRun }) => void): () => void;
    /** Fires with the new list when something other than the caller changed it, e.g. a routine on a server was put there or brought back. */
    onChange?(cb: (list: AutomationInfo[]) => void): () => void;
  };
  /**
   * Superagent: a proactive, policy-gated coding agent for one GitHub repository (desktop only; it needs the local runtime
   * and git). Off until set up; the token belongs to a dedicated agent account and is stored encrypted, never returned.
   */
  superagent?: {
    view(): Promise<SuperagentReply>;
    /** `baseRevision` is the `settingsRevision` the edit started from; a stale one is refused. */
    saveSettings(settings: SuperagentSettings, baseRevision: number): Promise<SuperagentReply>;
    setToken(token: string): Promise<SuperagentReply>;
    clearToken(): Promise<SuperagentReply>;
    verify(): Promise<SuperagentReply<SuperagentVerification>>;
    stopTicket(ticketId: string): Promise<SuperagentReply>;
    retryTicket(ticketId: string): Promise<SuperagentReply>;
    /** Sends a decided message to assessment again. */
    requeue(triggerId: string): Promise<SuperagentReply>;
    /** Forgets all tickets, decisions and conversations; settings and the token stay. */
    reset(): Promise<SuperagentReply>;
    onChanged(cb: (view: SuperagentView) => void): () => void;
  };
  /** SSH targets for remote automation runs (desktop only). */
  sshHosts?: {
    list(): Promise<SshHostInfo[]>;
    add(input: SshHostInput): Promise<SshHostInfo[]>;
    update(id: string, patch: Partial<SshHostInput>): Promise<SshHostInfo[]>;
    remove(id: string): Promise<SshHostInfo[]>;
    setCredentials(id: string, creds: SshHostCredentials): Promise<SshHostInfo[]>;
    test(hostId: string, acceptFingerprint?: string): Promise<SshTestResult>;
    pinFingerprint(hostId: string, fingerprint: string): Promise<SshHostInfo[]>;
    importKey(): Promise<string | null>;
    /** Browse remote directories for SSH workspace connect. */
    browse(hostId: string, remotePath: string): Promise<DirectoryEntry[]>;
  };
  repo?: {
    connect(opts: RepoConnectRequest): Promise<RepoStateResult>;
    state(): Promise<RepoStateResult>;
    ship(message?: string): Promise<RepoShipResult>;
    /** Streaming progress for clone/connect/ship operations. */
    onProgress(cb: (e: RepoProgressEvent) => void): () => void;
  };
  github?: {
    connect(): Promise<GitHubAuthState>;
    disconnect(): Promise<void>;
    authState(): Promise<GitHubAuthState>;
    listRepos(query?: string): Promise<GitHubRepoEntry[]>;
  };
  projects: {
    /** Persisted folder-projects + active selection. The renderer patches projects
     *  and active ids; workspaceRoot is owned by the host. */
    get(): Promise<ProjectsState>;
    set(patch: Partial<ProjectsState>): Promise<ProjectsState>;
  };
  terminal: {
    create(opts: TerminalCreateOptions): Promise<string>;
    /** Attach to an existing terminal id (e.g. agent shell) and receive its scrollback. */
    attach(id: string): Promise<{ scrollback: string }>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): void;
    onData(cb: (e: TerminalDataEvent) => void): () => void;
    onExit(cb: (e: TerminalExitEvent) => void): () => void;
  };
  env: {
    detect(): Promise<EnvInfo>;
  };
  settings: {
    get(): Promise<DeyinSettings>;
    set(patch: Partial<DeyinSettings>): Promise<DeyinSettings>;
  };
  caps: {
    /** Live capability registry (filesystem scan merged with disabled set). */
    list(kind?: CapabilityKind): Promise<CapabilityItem[]>;
    toggle(id: string, enabled: boolean): Promise<CapabilityItem[]>;
  };
  mcp: {
    list(): Promise<McpServerEntry[]>;
    /** Add a custom server to ~/.deyin/mcp.json. */
    add(input: McpServerInput): Promise<McpServerEntry[]>;
    /** Remove a user-level server from ~/.deyin/mcp.json. */
    remove(name: string): Promise<McpServerEntry[]>;
    /** Connect, list tools, disconnect. */
    test(name: string): Promise<McpTestResult>;
    catalog: {
      list(): Promise<McpCatalogEntry[]>;
      install(input: McpCatalogInstallInput): Promise<McpServerEntry[]>;
    };
    modules: {
      list(): Promise<McpModuleManifest[]>;
      uninstall(id: string): Promise<McpServerEntry[]>;
    };
    authenticate(moduleId: string): Promise<McpAuthResult>;
    auth: {
      revoke(moduleId: string): Promise<void>;
      status(): Promise<Record<string, McpAuthStatus>>;
    };
  };
  plugins: {
    list(): Promise<PluginInfo[]>;
    catalog(force?: boolean): Promise<PluginCatalogEntry[]>;
    /** Install from "owner/repo", "owner/repo@ref" or a github.com URL. */
    install(source: string): Promise<{ ok: boolean; message?: string; plugin?: PluginInfo }>;
    uninstall(name: string): Promise<void>;
    setVariable(plugin: string, name: string, value: string): Promise<void>;
    /** Which declared variables have stored values (values never leave main). */
    variableState(plugin: string, names: string[]): Promise<Record<string, boolean>>;
    /** Kernel-hosted plugins (tool families, llm adapters, ...): state + errors. */
    kernelStatus(): Promise<KernelPluginStatus[]>;
  };
  index: {
    status(): Promise<IndexStatus>;
    rebuild(): Promise<void>;
    search(query: string, topK?: number): Promise<IndexSearchHit[]>;
    onStatus(cb: (status: IndexStatus) => void): () => void;
  };
  agent: {
    /** Start (or continue) an agent run for a chat thread. */
    start(options: AgentStartOptions): Promise<void>;
    stop(threadId: string): void;
    /** Drop in-memory session state so the next run rebuilds from UI history. */
    resetSession(threadId: string): Promise<void>;
    approve(requestId: string, decision: AgentPermissionDecision): void;
    answerQuestion(requestId: string, answers: Record<string, string | string[]>): void;
    /** Answer a Bot's Secure Form: what was typed (it goes to the page, never to the model), or null when cancelled. Desktop only. */
    answerSecureForm?(requestId: string, values: Record<string, string> | null): void;
    disposeShell(threadId: string): void;
    /** Agent lifecycle events for a thread; `runId` (when present) must match the active run. */
    onEvent(cb: (envelope: AgentEventEnvelope) => void): () => void;
  };
  checkpoints: {
    revertRun(threadId: string, checkpointId: string): Promise<RevertResult>;
    revertFile(threadId: string, checkpointId: string, path: string): Promise<RevertResult>;
    revertAfterEvent(threadId: string, eventIndex: number, events?: ThreadEvent[]): Promise<RevertResult>;
  };
  browserControl: {
    /** Register the active workspace <webview> as the controlled browser tab. */
    register(webContentsId: number | null): void;
    /** Sync tab metadata (url/title) for multi-tab registry. */
    syncTab(webContentsId: number, url: string, title: string): void;
    /** Remove a tab from the main-process registry when its webview closes. */
    removeTab(webContentsId: number): void;
    /** Per-workspace persistent session partition for the webview. */
    getPartition(): Promise<string>;
    clearProfile(): Promise<void>;
    /** Main asks the renderer to open the Browser tab so tools have a target. */
    onEnsure(cb: () => void): () => void;
    /** Main asks the renderer to open/switch/close browser tabs. */
    onTabCommand(cb: (cmd: BrowserTabCommand) => void): () => void;
    /** True while browser_* agent tools are in flight. */
    onActive(cb: (active: boolean) => void): () => void;
  };
  /**
   * OS desktop automation. Optional: only the desktop transport implements it,
   * and the underlying plugin is Windows-only — the web host has no OS to drive.
   */
  computerUse?: {
    getAllowlist(): Promise<string[]>;
    setAllowlist(apps: string[]): Promise<string[]>;
    listApps(): Promise<unknown>;
    getHostStatus(): Promise<ComputerUseHostStatus>;
    /** Live phase of the running computer-use action (idle when nothing is running). */
    onState(cb: (state: ComputerUseState) => void): () => void;
    /** Cancel the running computer-use action. */
    stop(): void;
    /** Continue after the user took over (paused phase). */
    resume(): void;
    onAppApprovalRequest(cb: (req: { requestId: string; appId: string; action: string }) => void): () => void;
    respondAppApproval(requestId: string, decision: "always" | "once" | "deny"): void;
  };
  /**
   * Your real Chrome through the Deyin extension. Optional: desktop only.
   */
  chrome?: {
    getStatus(): Promise<ChromeBridgeStatus>;
    onStatus(cb: (status: ChromeBridgeStatus) => void): () => void;
    /** Open a short pairing window; the next unpaired extension connection starts pairing. */
    beginPairing(): Promise<ChromeBridgeStatus>;
    cancelPairing(): Promise<ChromeBridgeStatus>;
    forgetBrowser(browserId: string): Promise<ChromeBridgeStatus>;
    /** Stop everything: detach from all tabs and refuse commands until resumed. */
    stop(): Promise<ChromeBridgeStatus>;
    resume(): Promise<ChromeBridgeStatus>;
    closeAgentTabs(): Promise<ChromeBridgeStatus>;
    getApprovedOrigins(): Promise<string[]>;
    setApprovedOrigins(origins: string[]): Promise<string[]>;
    openExtensionFolder(): Promise<void>;
    /** True while chrome_* agent tools are in flight. */
    onActive(cb: (active: boolean) => void): () => void;
    onOriginApprovalRequest(cb: (req: { requestId: string; origin: string; action: string }) => void): () => void;
    respondOriginApproval(requestId: string, decision: "always" | "once" | "deny"): void;
  };
  /**
   * Workspace trust gate (desktop only). The main process raises it before a
   * run executes a workspace's .deyin hooks / MCP config; the renderer shows
   * the same inline prompt card used for tool permissions.
   */
  workspaceTrust?: {
    onRequest(cb: (req: { requestId: string; root: string }) => void): () => void;
    respond(requestId: string, decision: "trust" | "skip"): void;
  };
  visualize: {
    read(threadId: string, fileName: string): Promise<string>;
  };
  page: {
    /** Stored one-page website HTML for the Preview panel. */
    read(threadId: string, fileName: string): Promise<string>;
    /** Chat-only web: persist HTML extracted from assistant markdown. */
    save?(threadId: string, input: { html: string; fileName?: string; title?: string }): Promise<{ file: string }>;
  };
  images: {
    /** Persist generated image bytes for a thread; returns the embed file name. */
    save(threadId: string, input: { base64: string; mediaType?: string }): Promise<{ file: string }>;
    /** Stored image as a `data:` URL, for inline rendering in chat. */
    read(threadId: string, fileName: string): Promise<string>;
    /** Run a text-to-image model and store the results for the thread. */
    generate(request: ImageGenerateRequest): Promise<ImageGenerateResult>;
  };
  videos: {
    save(threadId: string, input: { base64: string; mediaType?: string }): Promise<{ file: string }>;
    read(threadId: string, fileName: string): Promise<string>;
    generate(request: VideoGenerateRequest): Promise<VideoGenerateResult>;
  };
  /**
   * On-device vision via the Local Vision plugin (Ollama). Desktop only.
   */
  vision?: {
    describeLocal(images: AgentImageInput[], userText?: string): Promise<LocalVisionDescribeResult>;
    localStatus(): Promise<LocalVisionStatus>;
  };
  telemetry: {
    /** Anonymous feature-usage event; dropped unless telemetry is enabled. */
    record(name: string, props?: Record<string, string | number | boolean>): void;
  };
  providers: {
    list(): Promise<ProviderInfo[]>;
    add(input: { name: string; baseUrl: string }): Promise<ProviderInfo[]>;
    update(id: string, patch: ProviderPatch): Promise<ProviderInfo[]>;
    remove(id: string): Promise<ProviderInfo[]>;
    setKey(id: string, key: string): Promise<ProviderInfo[]>;
    getKey(id: string): Promise<string | null>;
    test(id: string): Promise<ProviderTestResult>;
    /** Pull the provider's /models catalog and persist it as the provider's model list. */
    fetchModels(id: string): Promise<ProviderTestResult>;
  };
  usage: {
    get(): Promise<UsageStats>;
    record(event: UsageEvent): Promise<void>;
    /** Cached Openference account snapshot; `force` bypasses the 6h TTL. */
    account(force?: boolean): Promise<AccountUsage | null>;
  };
  plans: {
    /** Public Openference plan catalog (edge-cached on the server). */
    list(): Promise<PublicPlan[] | null>;
    /** Live daily-release status: drop countdown and sold-out plan ids. */
    releaseStatus(): Promise<ReleaseStatus>;
  };
  billing: {
    /** Subscription and billing overview for plan changes. */
    overview(): Promise<BillingOverview | null>;
    /** Start plan selection / Stripe checkout for the signed-in user. */
    selectPlan(planId: number, options?: SelectPlanOptions): Promise<SelectPlanResponse>;
    publishableKey(): Promise<string | null>;
    completeCrossCurrencyUpgrade(newSubscriptionId: string): Promise<{ success?: boolean; redirect?: string; error?: string }>;
    abortCrossCurrencyUpgrade(newSubscriptionId: string): Promise<void>;
  };
  win: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
  };
  browserData: {
    clearCache(): Promise<void>;
    clearAll(): Promise<void>;
  };
  search: {
    query(q: string): Promise<SearchResult[]>;
  };
  shell: {
    showItem(path: string): void;
    openExternal(url: string): void;
  };
  /** System clipboard, so copy/paste works in the web host and in packaged builds alike.
   *  Optional: a host without it falls back to `navigator.clipboard`. */
  clipboard?: {
    readText(): Promise<string>;
    writeText(text: string): Promise<boolean>;
  };
  /** Native context menu for a right-click the renderer does not draw itself.
   *  Optional: the browser host leaves the platform's own menu in place. */
  contextMenu?: {
    /**
     * Shows the OS edit menu at the pointer. `kind: "terminal"` adds Paste and
     * Select All for the xterm canvas, which has no editable element of its own.
     * Resolves to the command the user picked, or null when they dismissed it.
     */
    show(request: ContextMenuRequest): Promise<ContextMenuCommand | null>;
  };
  paths: {
    /** Well-known locations for the task menu copy actions. */
    get(): Promise<{ userData: string; logs: string; config: string }>;
  };
  updates: {
    getState(): Promise<UpdatesState>;
    /** Check GitHub Releases for a newer build; resolves to the latest state. */
    check(opts?: { userInitiated?: boolean }): Promise<UpdatesState>;
    /** Download the pending update (only meaningful while status is "available"). */
    download(): Promise<UpdatesState>;
    /** Quit and install the downloaded update. */
    install(): void;
    /** Pushed on every status/progress transition. */
    onState(cb: (state: UpdatesState) => void): () => void;
  };
  identity: {
    /** Live snapshot for the Identity & Access page (env, account, fingerprint). */
    get(): Promise<IdentityInfo>;
    /** Register this workstation + workspace with Openference; updates lastSyncedAt. */
    sync(): Promise<IdentitySyncResult>;
  };
  diagnostics: {
    /** Upload a scrubbed diagnostics bundle; returns the support report id. */
    send(note?: string): Promise<DiagnosticsResult>;
  };
  logs: {
    /** Append a renderer-side line to deyin.log (errors are forwarded by the app). */
    write(level: "info" | "warn" | "error", message: string): void;
  };
  context: {
    search(query: string): Promise<ContextSearchHit[]>;
    resolve(refs: ContextRef[]): Promise<ResolvedContextFile[]>;
  };
  review: {
    list(threadId?: string): Promise<PendingChange[]>;
    approve(threadId: string, changeId: string): Promise<boolean>;
    reject(threadId: string, changeId: string): Promise<boolean>;
    approveAll(threadId: string): Promise<number>;
    rejectAll(threadId: string): Promise<number>;
  };
  security: {
    listFindings(threadId: string): Promise<SecurityFindingsReport | null>;
    clearFindings(threadId: string): Promise<void>;
    scanDiff(threadId: string, diff: string): Promise<SecurityFindingsReport>;
    onFindingsChanged(cb: (threadId: string) => void): () => void;
  };
  beta: {
    submitFeedback(payload: { category: string; message: string; rating?: number }): Promise<{ ok: boolean }>;
  };
  externalAgents: {
    list(forceRefresh?: boolean): Promise<ExternalAgentDescriptor[]>;
    test(agentId: string): Promise<{ ok: boolean; message: string; version?: string }>;
    run(options: {
      agentId: string;
      prompt: string;
      cwd: string;
      model?: string;
      timeoutMs?: number;
      stallThresholdMs?: number;
      runId?: string;
      logBufferId?: string;
    }): Promise<{ ok: boolean; error?: string; outputText: string; runId?: string }>;
    abort(runId: string): Promise<boolean>;
    nudge(runId: string, message?: string): Promise<boolean>;
    logs(runId: string, maxLines?: number): Promise<string[]>;
  };
  conductorWorkflows: {
    list(): Promise<ConductorWorkflowDefinition[]>;
    save(workflow: ConductorWorkflowDefinition): Promise<ConductorWorkflowDefinition>;
    delete(id: string): Promise<boolean>;
    run(workflowId: string, cwd: string): Promise<{ ok: boolean; runId?: string }>;
    abort(runId: string): Promise<boolean>;
    merge(workspaceRoot: string, branchName: string): Promise<{ ok: boolean; message: string }>;
    onEvent(cb: (event: any) => void): () => void;
  };
  /**
   * Deyin Bots: durable personas with their own memory. Every call returns a `BotResult` so a refusal
   * ("a Bot needs a name") reaches the UI as text. Hosts without a runtime (chat-only web) report the
   * roster as empty and refuse changes.
   */
  bots: {
    list(): Promise<BotsSnapshot>;
    create(input: BotInput): Promise<BotResult<DeyinBot>>;
    update(id: string, patch: BotPatch): Promise<BotResult<DeyinBot>>;
    archive(id: string): Promise<BotResult<DeyinBot>>;
    restore(id: string): Promise<BotResult<DeyinBot>>;
    /** Permanently deletes the Bot, its memory, and every conversation it had. */
    delete(id: string): Promise<BotResult<null>>;
    setPrimary(id: string): Promise<BotResult<DeyinBot>>;
    setPinned(id: string, pinned: boolean): Promise<BotResult<BotRosterLayout>>;
    setHidden(id: string, hidden: boolean): Promise<BotResult<BotRosterLayout>>;
    addSection(name: string): Promise<BotResult<BotRosterLayout>>;
    renameSection(sectionId: string, name: string): Promise<BotResult<BotRosterLayout>>;
    removeSection(sectionId: string): Promise<BotResult<BotRosterLayout>>;
    moveToSection(id: string, sectionId: string | null): Promise<BotResult<BotRosterLayout>>;
    memoryList(id: string): Promise<BotResult<BotMemoryFactView[]>>;
    memoryForget(id: string, ref: string): Promise<BotResult<null>>;
    /** Share a private fact with every Bot (or make a shared one private to this Bot). */
    memoryShare(id: string, ref: string, shared: boolean): Promise<BotResult<BotMemoryFactView>>;
    /** Fires with the new roster after any change, including ones made in another window. */
    onChange(cb: (snapshot: BotsSnapshot) => void): () => void;
  };
  /**
   * Make a picture for a Bot from a description, with one of the person's image models. Nothing is saved: the
   * picture comes back for the person to look at, and becomes the avatar only through `bots.update`. Desktop only.
   */
  botAvatar?: {
    generate(request: BotAvatarRequest): Promise<BotResult<BotAvatarPicture>>;
  };
  /**
   * What every Bot may do with a tool: per-tool permissions, and the allow and block instructions Auto Review
   * applies. A Bot's approval mode is on the Bot itself (`bots.update`). Absent in hosts without Bots.
   */
  botPermissions?: {
    get(): Promise<BotPermissionSettings>;
    /** Change part of the settings; a refusal ("that is not a permission") comes back as text. */
    update(patch: unknown): Promise<BotResult<BotPermissionSettings>>;
    /** Fires with the new settings after any change, including ones "Always allow" made on an approval card. */
    onChange(cb: (settings: BotPermissionSettings) => void): () => void;
  };
  /**
   * The Vault: logins, cards and contacts a Bot can fill into pages without ever seeing them. Passwords, card
   * numbers and security codes can be saved and replaced here but are never sent back. Desktop only.
   */
  vault?: {
    get(): Promise<VaultSnapshot>;
    /** Save an item, or change the one named by `input.id`. A refusal ("that card has expired") comes back as text. */
    save(input: unknown): Promise<BotResult<VaultItem>>;
    /** Remove an item, and every permission any Bot had to use it. */
    remove(id: string): Promise<BotResult<null>>;
    /** Take back one Bot's permission to use an item on a site; the next use asks again. */
    revoke(botId: string, itemId: string, host: string): Promise<BotResult<null>>;
    /** Fires with the new snapshot after any change, including a permission a person gave on an approval card. */
    onChange(cb: (snapshot: VaultSnapshot) => void): () => void;
  };
  /**
   * What a Bot knows how to do: skills, written by the person, taught by showing, or imported with a template. Each is
   * a `SKILL.md` the Bot reads when a task calls for it. Every call returns a `BotResult`. Desktop only.
   */
  botSkills?: {
    list(botId: string): Promise<BotResult<BotSkillSummary[]>>;
    get(botId: string, name: string): Promise<BotResult<BotSkill>>;
    /** Save a skill. With `expectedVersion`, a skill changed since it was opened is refused instead of overwritten. */
    save(botId: string, input: BotSkillInput, expectedVersion?: number): Promise<BotResult<BotSkill>>;
    remove(botId: string, name: string): Promise<BotResult<null>>;
    /** Earlier versions of a skill, newest first. */
    revisions(botId: string, name: string): Promise<BotResult<SkillRevision[]>>;
    /** Make an earlier version the current one; the version it replaces is kept. */
    revert(botId: string, name: string, revisionId: string): Promise<BotResult<BotSkill>>;
    /** Fires with the Bot's id after its skills changed, from any window or from teaching. */
    onChange(cb: (botId: string) => void): () => void;
  };
  /**
   * Handing Bots around: export one as text or a link, preview and import one someone shared, and the starters in the
   * marketplace. An imported Bot is always a new one, and its routines start paused. Desktop only.
   */
  botTemplates?: {
    export(botId: string, options?: { includeRoutines?: boolean }): Promise<BotResult<ExportedTemplate>>;
    /** What importing `text` (a template or a link carrying one) would add, without adding it. */
    preview(text: string): Promise<BotResult<TemplatePreview>>;
    import(text: string, options: ImportOptions): Promise<BotResult<ImportedBot>>;
    catalog(query?: string, category?: CatalogCategory): Promise<BotResult<CatalogListing>>;
    importCatalog(id: string, options: ImportOptions): Promise<BotResult<ImportedBot>>;
    /** A shared Bot's link that opened the app and is waiting to be looked at; handed over once. */
    takeLink(): Promise<string | null>;
    /** Fires with a shared Bot's link when one is opened while the app is running. */
    onLink(cb: (link: string) => void): () => void;
  };
  /**
   * Files for Bots: a Bot's own folder (on its server, for a Bot that lives on one) and the library every Bot can
   * read. Only text. Desktop only.
   */
  botFiles?: {
    list(scope: FileScope, botId: string | null, path: string): Promise<BotResult<RuntimeFileEntry[]>>;
    read(scope: FileScope, botId: string | null, path: string): Promise<BotResult<FileContent>>;
    write(scope: FileScope, botId: string | null, path: string, content: string): Promise<BotResult<null>>;
    remove(scope: FileScope, botId: string | null, path: string): Promise<BotResult<null>>;
    /** Copy one file between the library and a Bot's folder. */
    copy(direction: CopyDirection, botId: string, path: string, as?: string): Promise<BotResult<{ path: string }>>;
    /** Fires after a Bot's files, or the library, changed; `botId` is null for the library. */
    onChange(cb: (event: { scope: FileScope; botId: string | null }) => void): () => void;
  };
  /**
   * Teach a Bot a task by doing it in the in-app browser. Passwords, card numbers and anything else secret are never
   * kept. Stopping drafts a skill the person reads and changes before it is saved. Desktop only.
   */
  botTeach?: {
    state(): Promise<TeachState>;
    start(botId: string, title: string): Promise<BotResult<TeachState>>;
    /** Say something while working ("wait for the download"); it becomes a line in the skill. */
    note(text: string): Promise<BotResult<TeachState>>;
    /** Ends the recording and drafts the skill; `name` and `description` are the person's own, when they gave them. */
    stop(options?: { name?: string; description?: string }): Promise<BotResult<TeachDraft>>;
    cancel(): Promise<BotResult<TeachState>>;
    save(botId: string, skill: BotSkillInput): Promise<BotResult<BotSkill>>;
    onChange(cb: (state: TeachState) => void): () => void;
  };
  /**
   * Where a Bot can be reached from outside this app: a webhook, email, Slack, Teams and X. Messages go to one of the
   * Bot's own routines, only from people the Bot's list allows; what a Bot wants to say in public on X waits in the
   * Outbox until a person approves that exact text. No call returns a secret. Desktop only.
   */
  botSurfaces?: {
    state(botId: string): Promise<BotResult<BotSurfacesState>>;
    /** Save one surface. A secret left out keeps what is saved; a key this app made is returned once, here. */
    save(botId: string, kind: SurfaceKind, input: Partial<SurfaceInput>): Promise<BotResult<SurfaceSaved>>;
    /** Make a new key for a webhook or an email sender. The old one stops working at once; the new one is returned once. */
    remake(botId: string, kind: SurfaceKind, name: string): Promise<BotResult<{ view: SurfaceView; value: string }>>;
    setEnabled(botId: string, kind: SurfaceKind, enabled: boolean): Promise<BotResult<SurfaceView>>;
    remove(botId: string, kind: SurfaceKind): Promise<BotResult<null>>;
    /** Where this computer listens, and the public address shown for it. */
    setHub(settings: Partial<HubSettings>): Promise<BotResult<{ settings: HubSettings; status: HubStatus }>>;
    outboxEdit(id: string, text: string): Promise<BotResult<OutboxPost>>;
    /** Post the draft as it stands now, once. A post that X refuses comes back as a draft that failed, with why. */
    outboxApprove(id: string): Promise<BotResult<OutboxPost>>;
    outboxDeny(id: string): Promise<BotResult<OutboxPost>>;
    /** Fires when a surface, the hub, the Outbox or what lately happened changed. */
    onChange(cb: () => void): () => void;
  };
  /**
   * Bot engines: the small program that runs Bots on a server the person owns, so they keep working while this
   * computer is off. Setup runs over the saved SSH connection and reports through `onSetup`. Desktop only.
   */
  engines?: {
    /** Every saved server, with whether an engine is set up on it. */
    list(): Promise<EngineHostView[]>;
    /** Ask a server's engine how it is. A refusal ("no engine is set up", "could not connect") comes back as text. */
    status(hostId: string): Promise<BotResult<EngineStatusView>>;
    /** Put the engine on a server, or bring the one there up to date and running. Progress arrives through `onSetup`. */
    install(hostId: string): Promise<BotResult<{ version: string; warnings: string[] }>>;
    /** Stop a setup or removal that is running on a server. */
    cancel(hostId: string): Promise<boolean>;
    /** Take the engine off a server; with `purge`, delete the Bots' files and routines there too. */
    uninstall(hostId: string, purge: boolean): Promise<BotResult<null>>;
    /** Stop using a server's engine without reaching the server, for when it is gone. The engine itself is left running. */
    forget(hostId: string): Promise<BotResult<null>>;
    /** Whether the computer a Bot works on can run it right now, and if not why. */
    health(botId: string): Promise<BotResult<RuntimeHealth>>;
    /** Fires with the new list after any change: a setup began or ended, an engine was added or removed. */
    onChange(cb: (hosts: EngineHostView[]) => void): () => void;
    /** Fires for each step of a setup, for the sign-in the server asks for, and when it ends. */
    onSetup(cb: (event: EngineSetupEvent) => void): () => void;
  };
}

declare global {
  interface Window {
    deyin: DeyinApi;
  }
}
