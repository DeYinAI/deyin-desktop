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
  IdentityInfo,
  IdentitySyncResult,
  IndexSearchHit,
  IndexStatus,
  McpServerEntry,
  McpServerInput,
  McpTestResult,
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
} from "./types.js";

/** Decision for an agent permission request (mirrors agent-core). */
export type AgentPermissionDecision = "allow" | "allow-always" | "deny";

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
  workspaceOpen: "deyin:workspace:open",
  workspaceSetRoot: "deyin:workspace:setRoot",
  projectsGet: "deyin:projects:get",
  projectsSet: "deyin:projects:set",
  termCreate: "deyin:term:create",
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
  agentEvent: "deyin:agent:event",
  browserRegister: "deyin:browser:register",
  browserGetPartition: "deyin:browser:getPartition",
  browserClearProfile: "deyin:browser:clearProfile",
  browserEnsure: "deyin:browser:ensure",
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
  };
  workspace: {
    openFolder(): Promise<string | null>;
    /** Point the host's workspace cwd at a folder (terminal/files/agent); persisted. */
    setRoot(root: string | null): Promise<void>;
  };
  projects: {
    /** Persisted folder-projects + active selection. The renderer patches projects
     *  and active ids; workspaceRoot is owned by the host. */
    get(): Promise<ProjectsState>;
    set(patch: Partial<ProjectsState>): Promise<ProjectsState>;
  };
  terminal: {
    create(opts: TerminalCreateOptions): Promise<string>;
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
    onEvent(cb: (envelope: AgentEventEnvelope) => void): () => void;
  };
  browserControl: {
    /** Register the workspace <webview> as the controlled browser tab. */
    register(webContentsId: number | null): void;
    /** Per-workspace persistent session partition for the webview. */
    getPartition(): Promise<string>;
    clearProfile(): Promise<void>;
    /** Main asks the renderer to open the Browser tab so tools have a target. */
    onEnsure(cb: () => void): () => void;
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
}

declare global {
  interface Window {
    deyin: DeyinApi;
  }
}
