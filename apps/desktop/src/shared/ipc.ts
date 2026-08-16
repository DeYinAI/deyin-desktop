import type {
  AccountUsage,
  AgentEventEnvelope,
  AgentStartOptions,
  Bootstrap,
  CapabilityItem,
  CapabilityKind,
  DeyinSettings,
  DiagnosticsResult,
  EnvInfo,
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
  SelectPlanOptions,
  SelectPlanResponse,
  BillingOverview,
  Automation,
  AutomationInfo,
  AutomationRun,
  AgentUiEvent,
  SshHostInfo,
  SshHostInput,
  SshHostCredentials,
  SshTestResult,
  ContextSearchHit,
  ContextRef,
  ResolvedContextFile,
  PendingChange,
  SecurityFindingsReport,
  ReasonixMetricsSnapshot,
  ReasonixWeeklyReport,
  ReasonixDiagnostics,
} from "./types.js";

/** Result of create/update — includes the mutated automation so UI can select by id. */
export interface AutomationMutationResult {
  automation: Automation;
  list: AutomationInfo[];
}

/** Decision for an agent permission request (mirrors agent-core). */
export type AgentPermissionDecision = "allow" | "allow-always" | "deny";

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
  indexStatus: "deyin:index:status",
  indexRebuild: "deyin:index:rebuild",
  indexSearch: "deyin:index:search",
  indexStatusEvent: "deyin:index:statusEvent",
  agentStart: "deyin:agent:start",
  agentStop: "deyin:agent:stop",
  agentApprove: "deyin:agent:approve",
  agentAnswerQuestion: "deyin:agent:answerQuestion",
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
  computerUseActive: "deyin:computerUse:active",
  computerUseGetAllowlist: "deyin:computerUse:getAllowlist",
  computerUseSetAllowlist: "deyin:computerUse:setAllowlist",
  computerUseListApps: "deyin:computerUse:listApps",
  chromeConsentRequest: "deyin:chrome:consent-request",
  chromeConsentRespond: "deyin:chrome:consent-respond",
  visualizeRead: "deyin:visualize:read",
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
  automationsList: "deyin:automations:list",
  automationsCreate: "deyin:automations:create",
  automationsUpdate: "deyin:automations:update",
  automationsDelete: "deyin:automations:delete",
  automationsToggle: "deyin:automations:toggle",
  automationsRun: "deyin:automations:run",
  automationsStop: "deyin:automations:stop",
  automationsRuns: "deyin:automations:runs",
  automationEvent: "deyin:automations:event",
  automationRunFinished: "deyin:automations:runFinished",
  sshHostsList: "deyin:ssh:list",
  sshHostsAdd: "deyin:ssh:add",
  sshHostsUpdate: "deyin:ssh:update",
  sshHostsRemove: "deyin:ssh:remove",
  sshHostsSetCredentials: "deyin:ssh:setCredentials",
  sshHostsTest: "deyin:ssh:test",
  sshHostsPinFingerprint: "deyin:ssh:pinFingerprint",
  sshHostsImportKey: "deyin:ssh:importKey",
  contextSearch: "deyin:context:search",
  contextResolve: "deyin:context:resolve",
  reviewList: "deyin:review:list",
  reviewApprove: "deyin:review:approve",
  reviewReject: "deyin:review:reject",
  reviewApproveAll: "deyin:review:approveAll",
  reviewRejectAll: "deyin:review:rejectAll",
  gitDiff: "deyin:git:diff",
  securityListFindings: "deyin:security:listFindings",
  securityClearFindings: "deyin:security:clearFindings",
  securityScanDiff: "deyin:security:scanDiff",
  securityFindingsChanged: "deyin:security:findingsChanged",
  reasonixMetricsGet: "deyin:reasonix:metrics:get",
  reasonixMetricsReport: "deyin:reasonix:metrics:report",
  reasonixDiagnosticsGet: "deyin:reasonix:diagnostics:get",
  reasonixCacheClear: "deyin:reasonix:cache:clear",
  betaFeedbackSubmit: "deyin:beta:feedback",
} as const;

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
    openFolder(): Promise<string | null>;
    /** Point the host's workspace cwd at a folder (terminal/files/agent); persisted. */
    setRoot(root: string | null): Promise<void>;
    /** Current workspace / sandbox root (may change after a web host reconnect). */
    getRoot(): Promise<string | null>;
    /** Fires when the host workspace/sandbox root changes (desktop setRoot or web reconnect). */
    onRootChanged(cb: (root: string | null) => void): () => void;
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
    approve(requestId: string, decision: AgentPermissionDecision): void;
    answerQuestion(requestId: string, answers: Record<string, string | string[]>): void;
    disposeShell(threadId: string): void;
    onEvent(cb: (envelope: AgentEventEnvelope) => void): () => void;
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
  computerUse: {
    getAllowlist(): Promise<string[]>;
    setAllowlist(apps: string[]): Promise<void>;
    listApps(): Promise<unknown>;
    onActive(cb: (active: boolean) => void): () => void;
  };
  chrome: {
    onConsentRequest(cb: (req: { message?: string }) => void): () => void;
    respondConsent(granted: boolean): void;
  };
  visualize: {
    read(threadId: string, fileName: string): Promise<string>;
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
  paths: {
    /** Well-known locations for the task menu copy actions. */
    get(): Promise<{ userData: string; logs: string; config: string }>;
  };
  updates: {
    getState(): Promise<UpdatesState>;
    /** Check GitHub Releases for a newer build; resolves to the latest state. */
    check(): Promise<UpdatesState>;
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
  automations: {
    list(): Promise<AutomationInfo[]>;
    create(input: Omit<Automation, "id" | "createdAt" | "updatedAt">): Promise<AutomationMutationResult>;
    update(id: string, patch: Partial<Omit<Automation, "id" | "createdAt">>): Promise<AutomationMutationResult>;
    remove(id: string): Promise<AutomationInfo[]>;
    toggle(id: string, enabled: boolean): Promise<AutomationInfo[]>;
    run(id: string): Promise<AutomationRun>;
    stop(runId: string): void;
    runs(automationId?: string): Promise<AutomationRun[]>;
    onEvent(cb: (payload: { runId: string; automationId: string; event: AgentUiEvent }) => void): () => void;
    onRunFinished(cb: (payload: { run: AutomationRun }) => void): () => void;
  };
  sshHosts: {
    list(): Promise<SshHostInfo[]>;
    add(input: SshHostInput): Promise<SshHostInfo[]>;
    update(id: string, patch: Partial<SshHostInput>): Promise<SshHostInfo[]>;
    remove(id: string): Promise<SshHostInfo[]>;
    setCredentials(id: string, creds: SshHostCredentials): Promise<SshHostInfo[]>;
    test(hostId: string, acceptFingerprint?: string): Promise<SshTestResult>;
    pinFingerprint(hostId: string, fingerprint: string): Promise<SshHostInfo[]>;
    importKey(): Promise<string | null>;
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
  reasonix: {
    metrics(): Promise<ReasonixMetricsSnapshot>;
    weeklyReport(): Promise<ReasonixWeeklyReport>;
    diagnostics(threadId?: string): Promise<ReasonixDiagnostics>;
    clearThreadCache(threadId: string): Promise<void>;
  };
  beta: {
    submitFeedback(payload: { category: string; message: string; rating?: number }): Promise<{ ok: boolean }>;
  };
}

declare global {
  interface Window {
    deyin: DeyinApi;
  }
}
