import type {
  Bootstrap,
  CapabilityItem,
  CapabilityKind,
  DeyinSettings,
  EnvInfo,
  FileNode,
  ModelInfo,
  ProviderInfo,
  ProviderPatch,
  ProviderTestResult,
  SearchResult,
  TerminalCreateOptions,
  TerminalDataEvent,
  TerminalExitEvent,
  UsageEvent,
  UsageStats,
  UserProfile,
} from "./types.js";

/** IPC channel identifiers, shared by main and preload so they never drift. */
export const CH = {
  bootstrap: "deyin:bootstrap",
  authConnect: "deyin:auth:connect",
  authLogout: "deyin:auth:logout",
  authGetUser: "deyin:auth:getUser",
  authGetToken: "deyin:auth:getToken",
  authChanged: "deyin:auth:changed",
  modelsList: "deyin:models:list",
  filesTree: "deyin:files:tree",
  filesRead: "deyin:files:read",
  workspaceOpen: "deyin:workspace:open",
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
  providersList: "deyin:providers:list",
  providersAdd: "deyin:providers:add",
  providersUpdate: "deyin:providers:update",
  providersRemove: "deyin:providers:remove",
  providersSetKey: "deyin:providers:setKey",
  providersGetKey: "deyin:providers:getKey",
  providersTest: "deyin:providers:test",
  usageGet: "deyin:usage:get",
  usageRecord: "deyin:usage:record",
  winMinimize: "deyin:win:minimize",
  winToggleMaximize: "deyin:win:toggleMaximize",
  winClose: "deyin:win:close",
  browserClearCache: "deyin:browser:clearCache",
  browserClearAll: "deyin:browser:clearAll",
  searchQuery: "deyin:search:query",
  shellShowItem: "deyin:shell:showItem",
  shellOpenExternal: "deyin:shell:openExternal",
  pathsGet: "deyin:paths:get",
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
    list(): Promise<ModelInfo[]>;
  };
  files: {
    tree(dir?: string): Promise<FileNode[]>;
    read(path: string): Promise<string>;
  };
  workspace: {
    openFolder(): Promise<string | null>;
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
    list(kind?: CapabilityKind): Promise<CapabilityItem[]>;
    toggle(id: string, enabled: boolean): Promise<CapabilityItem[]>;
  };
  providers: {
    list(): Promise<ProviderInfo[]>;
    add(input: { name: string; baseUrl: string }): Promise<ProviderInfo[]>;
    update(id: string, patch: ProviderPatch): Promise<ProviderInfo[]>;
    remove(id: string): Promise<ProviderInfo[]>;
    setKey(id: string, key: string): Promise<ProviderInfo[]>;
    getKey(id: string): Promise<string | null>;
    test(id: string): Promise<ProviderTestResult>;
  };
  usage: {
    get(): Promise<UsageStats>;
    record(event: UsageEvent): Promise<void>;
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
}

declare global {
  interface Window {
    deyin: DeyinApi;
  }
}
