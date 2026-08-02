import { OAuthClient, type TokenSet, type TokenStore } from "@deyin/oauth-client";
import { beginBrowserLogin, completeBrowserLogin } from "@deyin/oauth-client/browser";
import {
  DEFAULT_CAPABILITIES,
  DEFAULT_PROVIDERS,
  DEFAULT_SETTINGS,
  applyEvent,
  computeStats,
  fetchAccountUsage,
  fetchPublicPlans,
  selectPlan,
  fetchBillingOverview,
  fetchBillingPublishableKey,
  completeCrossCurrencyUpgrade,
  abortCrossCurrencyUpgrade,
  redactObject,
  sendDiagnosticsReport,
  syncWorkspaceIdentity,
  emptyReasonixMetrics,
  type StoredProviderBase,
} from "@deyin/host-core/shared";
import type { DeyinApi } from "@contract/ipc.js";
import type {
  Bootstrap,
  CapabilityItem,
  DeyinSettings,
  EnvInfo,
  PluginCatalogEntry,
  ProjectsState,
  ProviderInfo,
  ProviderPatch,
  ProviderTestResult,
  SearchResult,
  UsageDay,
  UsageEvent,
  UserProfile,
} from "@contract/types.js";
import type {
  ClientMessage,
  EnvDetectResult,
  FilesReadResult,
  FilesTreeResult,
  FilesWriteResult,
  ServerMessage,
  TermAttachResult,
  TermCreateResult,
} from "../shared/protocol.js";

const OAUTH_ISSUER = (import.meta.env.VITE_DEYIN_OAUTH_ISSUER as string) ?? "http://localhost:8788";
const CLIENT_ID = (import.meta.env.VITE_DEYIN_CLIENT_ID as string) ?? "deyin-desktop";
const SCOPES = ["openid", "profile", "email", "offline_access", "model:invoke"];
const REDIRECT_URI = `${location.origin}/auth/callback`;
const API_BASE = `${location.origin}/api`;

/** Persist the token set in localStorage so a web session survives reloads. */
class LocalStorageTokenStore implements TokenStore {
  private key = "deyin.tokens";
  async load(): Promise<TokenSet | undefined> {
    const raw = localStorage.getItem(this.key);
    return raw ? (JSON.parse(raw) as TokenSet) : undefined;
  }
  async save(tokens: TokenSet): Promise<void> {
    localStorage.setItem(this.key, JSON.stringify(tokens));
  }
  async clear(): Promise<void> {
    localStorage.removeItem(this.key);
  }
}

const oauth = new OAuthClient(
  { issuer: OAUTH_ISSUER, clientId: CLIENT_ID, scopes: SCOPES },
  new LocalStorageTokenStore(),
);

/** Complete the OAuth redirect if we're on the callback route. Call before mounting. */
export async function maybeCompleteLogin(): Promise<void> {
  if (location.pathname === "/auth/callback") {
    try {
      await completeBrowserLogin(oauth);
    } finally {
      history.replaceState({}, "", "/");
    }
  }
}

/** WebSocket connection to the host-server, with request/reply + terminal streams. */
class HostSocket {
  private ws?: WebSocket;
  private ready?: Promise<void>;
  private nextId = 1;
  /** Bumped on each new connection attempt; stale sockets ignore late messages. */
  private connGen = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private dataHandlers = new Set<(e: { id: string; data: string }) => void>();
  private exitHandlers = new Set<(e: { id: string; exitCode: number }) => void>();
  private rootHandlers = new Set<(root: string | null) => void>();
  /** Sandbox root assigned by the host after auth; kept across transient disconnects. */
  workspaceRoot: string | null = null;

  private emitRoot(root: string | null): void {
    this.workspaceRoot = root;
    this.rootHandlers.forEach((h) => h(root));
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  onRootChanged(cb: (root: string | null) => void): () => void {
    this.rootHandlers.add(cb);
    cb(this.workspaceRoot);
    return () => {
      this.rootHandlers.delete(cb);
    };
  }

  async ensure(): Promise<void> {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) return this.ready;
    this.ready = undefined;
    const gen = ++this.connGen;
    const disconnectErr = () => new Error("Host disconnected");

    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const resolveReady = () => {
        if (settled || gen !== this.connGen) return;
        settled = true;
        resolve();
      };
      const rejectReady = (err: Error) => {
        if (settled || gen !== this.connGen) return;
        settled = true;
        reject(err);
      };

      void (async () => {
        try {
          const token = await oauth.getAccessToken().catch(() => null);
          if (gen !== this.connGen) return;
          if (!token) {
            this.ready = undefined;
            this.emitRoot(null);
            rejectReady(new Error("Not authenticated"));
            return;
          }

          const url = `${location.origin.replace(/^http/, "ws")}/host`;
          const ws = new WebSocket(url);
          this.ws = ws;

          ws.onmessage = (ev) => {
            if (this.ws !== ws || gen !== this.connGen) return;
            this.onMessage(JSON.parse(ev.data as string) as ServerMessage, resolveReady, rejectReady);
          };
          // Browsers often fire close without a useful error; settle in onclose.
          ws.onerror = () => undefined;
          ws.onclose = () => {
            if (this.ws !== ws) return; // superseded by a newer socket
            this.ws = undefined;
            this.ready = undefined;
            this.failPending(disconnectErr());
            if (!settled) {
              // Handshake never completed — treat as ensure failure and clear root.
              this.emitRoot(null);
              rejectReady(disconnectErr());
            }
            // If already authed, keep last workspaceRoot until next auth.ok or failed ensure.
          };
          ws.onopen = () => {
            if (this.ws !== ws) return;
            this.raw({ type: "auth", token });
          };
        } catch (err) {
          if (gen !== this.connGen) return;
          this.ready = undefined;
          this.emitRoot(null);
          rejectReady(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });

    return this.ready;
  }

  private onMessage(
    msg: ServerMessage,
    resolveReady: () => void,
    rejectReady: (e: Error) => void,
  ) {
    switch (msg.type) {
      case "auth.ok":
        this.emitRoot(msg.workspaceRoot);
        resolveReady();
        break;
      case "auth.err": {
        const err = new Error(msg.message);
        this.ready = undefined;
        this.emitRoot(null);
        this.failPending(err);
        rejectReady(err);
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
        break;
      }
      case "reply": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
        break;
      }
      case "term.data":
        this.dataHandlers.forEach((h) => h({ id: msg.termId, data: msg.data }));
        break;
      case "term.exit":
        this.exitHandlers.forEach((h) => h({ id: msg.termId, exitCode: msg.exitCode }));
        break;
    }
  }

  private raw(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  async invoke<T>(build: (id: number) => ClientMessage): Promise<T> {
    await this.ensure();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.raw(build(id));
    });
  }

  fireAndForget(msg: ClientMessage): void {
    void this.ensure()
      .then(() => this.raw(msg))
      .catch(() => undefined);
  }

  onData(cb: (e: { id: string; data: string }) => void): () => void {
    this.dataHandlers.add(cb);
    return () => this.dataHandlers.delete(cb);
  }
  onExit(cb: (e: { id: string; exitCode: number }) => void): () => void {
    this.exitHandlers.add(cb);
    return () => this.exitHandlers.delete(cb);
  }
}

function toProfile(u: { sub: string; email?: string; name?: string; picture?: string; plan?: string }): UserProfile {
  return { sub: u.sub, email: u.email, name: u.name, picture: u.picture, plan: u.plan };
}

/* Client-local persistence: settings, capabilities, providers and usage live in
 * localStorage on the web (per-browser), mirroring the desktop's file-backed stores. */

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    // Spreading an array into an object would corrupt it; only merge plain objects.
    return Array.isArray(parsed) ? parsed : ({ ...fallback, ...parsed } as T);
  } catch {
    return fallback;
  }
}

function writeLocal<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

/* DEFAULT_SETTINGS, DEFAULT_CAPABILITIES and DEFAULT_PROVIDERS come from
 * @deyin/host-core/shared — the same seed data the desktop stores use. */

type StoredProvider = StoredProviderBase;

function readProviders(): StoredProvider[] {
  return readLocal<StoredProvider[]>("deyin.providers", DEFAULT_PROVIDERS).map((p) => ({
    ...p,
    enabled: p.enabled ?? true,
    apiFormat: p.apiFormat ?? "chat-completions",
    models: p.models ?? [],
    disabledModels: p.disabledModels ?? [],
    connectionModes: p.connectionModes ?? ["API key"],
    activeMode: p.activeMode ?? "API key",
  }));
}

function readKeys(): Record<string, string> {
  return readLocal<Record<string, string>>("deyin.providerKeys", {});
}

async function listProviderInfos(connected: boolean): Promise<ProviderInfo[]> {
  const keys = readKeys();
  return readProviders().map((p) => ({
    ...p,
    status:
      p.kind === "primary"
        ? connected
          ? "connected"
          : "not-connected"
        : keys[p.id]
          ? "connected"
          : "not-connected",
    hasKey: Boolean(keys[p.id]),
  }));
}

function recordUsage(event: UsageEvent): void {
  const days = applyEvent(readLocal<UsageDay[]>("deyin.usage", []), event);
  writeLocal("deyin.usage", days);
}

/** Build the browser implementation of the DeyinApi contract. */
export function createBrowserTransport(): DeyinApi {
  const host = new HostSocket();

  return {
    async bootstrap(): Promise<Bootstrap> {
      let user: UserProfile | null = null;
      let workspaceRoot: string | null = null;
      if (await oauth.isAuthenticated()) {
        user = await oauth.getUser().then(toProfile).catch(() => null);
        // Connect the host socket so we learn the per-session sandbox root.
        try {
          await host.ensure();
          workspaceRoot = host.workspaceRoot;
        } catch {
          workspaceRoot = null;
        }
      }
      return {
        config: { oauthIssuer: OAUTH_ISSUER, apiBaseUrl: API_BASE, clientId: CLIENT_ID },
        user,
        workspaceRoot,
        version: "web",
        platform: "web",
      };
    },
    auth: {
      async connect(): Promise<UserProfile> {
        // Full-page redirect; the profile is resolved after the callback + reload.
        location.href = await beginBrowserLogin(oauth, REDIRECT_URI);
        return new Promise<never>(() => {}); // never resolves; page navigates away
      },
      async logout(): Promise<void> {
        await oauth.logout();
      },
      async getUser(): Promise<UserProfile | null> {
        if (!(await oauth.isAuthenticated())) return null;
        return oauth.getUser().then(toProfile).catch(() => null);
      },
      getAccessToken: () => oauth.getAccessToken().catch(() => null),
      // The web flow completes via a full-page redirect + reload, so there is
      // no in-session change event to subscribe to; return a no-op unsubscribe.
      onChanged: () => () => undefined,
    },
    models: {
      async list() {
        const token = await oauth.getAccessToken().catch(() => null);
        if (!token) return [];
        const res = await fetch(`${API_BASE}/models`, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) return [];
        const body = (await res.json()) as { data?: { id: string; context_length?: number }[] };
        return (body.data ?? []).map((m) => ({ id: m.id, name: m.id, contextLength: m.context_length }));
      },
      // The web fetches live every time (no local cache file), so refresh = list.
      refresh() {
        return this.list();
      },
    },
    files: {
      tree: (dir) => host.invoke<FilesTreeResult>((id) => ({ type: "files.tree", id, dir })).then((r) => r.nodes),
      read: (path) => host.invoke<FilesReadResult>((id) => ({ type: "files.read", id, path })).then((r) => r.content),
      write: (path, content) =>
        host.invoke<FilesWriteResult>((id) => ({ type: "files.write", id, path, content })).then(() => undefined),
    },
    workspace: {
      openFolder: async () => null, // web sessions use the server-provisioned sandbox root
      setRoot: async () => undefined, // sandbox root is server-owned; nothing to switch
      getRoot: async () => {
        try {
          await host.ensure();
          return host.workspaceRoot;
        } catch {
          return null;
        }
      },
      onRootChanged: (cb) => host.onRootChanged(cb),
    },
    projects: {
      get: async () =>
        readLocal<ProjectsState>("deyin.projects", {
          projects: [],
          activeProjectId: null,
          activeThreadId: null,
          workspaceRoot: null,
        }),
      set: async (patch) => {
        const next = {
          ...readLocal<ProjectsState>("deyin.projects", {
            projects: [],
            activeProjectId: null,
            activeThreadId: null,
            workspaceRoot: null,
          }),
          ...patch,
          workspaceRoot: null,
        };
        writeLocal("deyin.projects", next);
        return next;
      },
    },
    terminal: {
      create: (opts) => host.invoke<TermCreateResult>((id) => ({ type: "term.create", id, opts })).then((r) => r.termId),
      attach: (termId) =>
        host.invoke<TermAttachResult>((id) => ({ type: "term.attach", id, termId })),
      write: (id, data) => host.fireAndForget({ type: "term.write", termId: id, data }),
      resize: (id, cols, rows) => host.fireAndForget({ type: "term.resize", termId: id, cols, rows }),
      kill: (id) => host.fireAndForget({ type: "term.kill", termId: id }),
      onData: (cb) => host.onData((e) => cb({ id: e.id, data: e.data })),
      onExit: (cb) => host.onExit((e) => cb({ id: e.id, exitCode: e.exitCode })),
    },
    env: {
      async detect(): Promise<EnvInfo> {
        try {
          const { env } = await host.invoke<EnvDetectResult>((id) => ({ type: "env.detect", id }));
          return env;
        } catch {
          // Not authenticated yet: report a browser-side placeholder environment.
          return {
            platform: "web",
            arch: "browser",
            wsl2: false,
            wslDistros: [],
            shells: [],
            defaultShell: "bash",
            hostname: location.host,
          };
        }
      },
    },
    settings: {
      get: async () => readLocal<DeyinSettings>("deyin.settings", DEFAULT_SETTINGS),
      set: async (patch) => {
        const next = { ...readLocal<DeyinSettings>("deyin.settings", DEFAULT_SETTINGS), ...patch };
        writeLocal("deyin.settings", next);
        return next;
      },
    },
    caps: {
      list: async (kind) => {
        const caps = readLocal<CapabilityItem[]>("deyin.caps", DEFAULT_CAPABILITIES);
        return kind ? caps.filter((c) => c.kind === kind) : caps;
      },
      toggle: async (id, enabled) => {
        const caps = readLocal<CapabilityItem[]>("deyin.caps", DEFAULT_CAPABILITIES);
        const cap = caps.find((c) => c.id === id);
        if (cap) cap.enabled = enabled;
        writeLocal("deyin.caps", caps);
        return caps;
      },
    },
    /* Execution-backed capabilities are desktop-only; the web surfaces read-only
     * placeholders so the settings pages render an honest state. */
    mcp: {
      list: async () => [],
      add: async () => {
        throw new Error("MCP servers are managed in the desktop app.");
      },
      remove: async () => [],
      test: async () => ({ ok: false, message: "MCP servers run in the desktop app." }),
      catalog: {
        list: async () => [],
        install: async () => {
          throw new Error("MCP catalog install requires the desktop app.");
        },
      },
      modules: {
        list: async () => [],
        uninstall: async () => [],
      },
      authenticate: async () => ({ ok: false, message: "MCP OAuth requires the desktop app." }),
      auth: {
        revoke: async () => undefined,
        status: async () => ({}),
      },
    },
    plugins: {
      list: async () => [],
      catalog: async () => {
        try {
          const res = await fetch("https://raw.githubusercontent.com/DeYinAI/registry/main/registry.json", {
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) return [];
          const body = (await res.json()) as { plugins?: PluginCatalogEntry[] } | PluginCatalogEntry[];
          return Array.isArray(body) ? body : (body.plugins ?? []);
        } catch {
          return [];
        }
      },
      install: async () => ({ ok: false, message: "Plugin install requires the desktop app." }),
      uninstall: async () => undefined,
      setVariable: async () => undefined,
      variableState: async () => ({}),
    },
    index: {
      status: async () => ({
        state: "disabled" as const,
        root: null,
        files: 0,
        chunks: 0,
        lastSync: null,
        model: "hash-v1",
        watching: false,
      }),
      rebuild: async () => undefined,
      search: async () => [],
      onStatus: () => () => undefined,
    },
    agent: {
      // The renderer only uses the agent runtime on the desktop platform.
      start: async () => undefined,
      stop: () => undefined,
      approve: () => undefined,
      answerQuestion: () => undefined,
      disposeShell: () => undefined,
      onEvent: () => () => undefined,
    },
    context: {
      search: async () => [],
      resolve: async () => [],
    },
    review: {
      list: async () => [],
      approve: async () => false,
      reject: async () => false,
      approveAll: async () => 0,
      rejectAll: async () => 0,
    },
    git: {
      status: async () => null,
      diff: async () => "",
      stage: async () => undefined,
      commit: async () => "",
      branches: async () => [],
      checkout: async () => undefined,
      log: async () => [],
    },
    security: {
      listFindings: async () => null,
      clearFindings: async () => undefined,
      scanDiff: async () => ({ version: "1", scannedAt: new Date().toISOString(), findings: [] }),
      onFindingsChanged: () => () => undefined,
    },
    browserControl: {
      register: () => undefined,
      syncTab: () => undefined,
      removeTab: () => undefined,
      getPartition: async () => "",
      clearProfile: async () => undefined,
      onEnsure: () => () => undefined,
      onTabCommand: () => () => undefined,
      onActive: () => () => undefined,
    },
    computerUse: {
      getAllowlist: async () => [],
      setAllowlist: async () => undefined,
      listApps: async () => [],
      onActive: () => () => undefined,
    },
    chrome: {
      onConsentRequest: () => () => undefined,
      respondConsent: () => undefined,
    },
    visualize: {
      read: async () => "",
    },
    telemetry: {
      // Web builds do not report telemetry.
      record: () => undefined,
    },
    providers: {
      list: async () => listProviderInfos(await oauth.isAuthenticated().catch(() => false)),
      add: async (input) => {
        const providers = readProviders();
        const id = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        if (id && !providers.some((p) => p.id === id)) {
          providers.push({
            id,
            name: input.name,
            kind: "custom",
            enabled: true,
            baseUrl: input.baseUrl,
            apiFormat: "chat-completions",
            connectionModes: ["API key"],
            activeMode: "API key",
            models: [],
            disabledModels: [],
          });
          writeLocal("deyin.providers", providers);
        }
        return listProviderInfos(await oauth.isAuthenticated().catch(() => false));
      },
      update: async (id, patch: ProviderPatch) => {
        const providers = readProviders();
        const provider = providers.find((p) => p.id === id);
        if (provider) {
          if (patch.name !== undefined && provider.kind === "custom") provider.name = patch.name;
          if (patch.baseUrl !== undefined && provider.kind === "custom") provider.baseUrl = patch.baseUrl;
          if (patch.apiFormat !== undefined) provider.apiFormat = patch.apiFormat;
          if (patch.enabled !== undefined) provider.enabled = patch.enabled;
          if (patch.activeMode !== undefined) provider.activeMode = patch.activeMode;
          if (patch.models !== undefined) provider.models = patch.models;
          if (patch.disabledModels !== undefined) provider.disabledModels = patch.disabledModels;
          writeLocal("deyin.providers", providers);
        }
        return listProviderInfos(await oauth.isAuthenticated().catch(() => false));
      },
      remove: async (id) => {
        const providers = readProviders().filter((p) => p.id !== id || p.kind === "primary");
        writeLocal("deyin.providers", providers);
        const keys = readKeys();
        delete keys[id];
        writeLocal("deyin.providerKeys", keys);
        return listProviderInfos(await oauth.isAuthenticated().catch(() => false));
      },
      setKey: async (id, key) => {
        const keys = readKeys();
        if (key) keys[id] = key;
        else delete keys[id];
        writeLocal("deyin.providerKeys", keys);
        return listProviderInfos(await oauth.isAuthenticated().catch(() => false));
      },
      getKey: async (id) => readKeys()[id] ?? null,
      test: async (id): Promise<ProviderTestResult> => {
        const provider = readProviders().find((p) => p.id === id);
        if (!provider?.baseUrl) return { ok: false, message: "No base URL configured." };
        const key = readKeys()[id];
        try {
          const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models`, {
            headers: key ? { authorization: `Bearer ${key}` } : {},
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status}` };
          const body = (await res.json().catch(() => ({}))) as { data?: unknown[] };
          return { ok: true, status: res.status, modelCount: Array.isArray(body.data) ? body.data.length : undefined };
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
      },
      fetchModels: async (id): Promise<ProviderTestResult> => {
        const providers = readProviders();
        const provider = providers.find((p) => p.id === id);
        if (!provider?.baseUrl) return { ok: false, message: "No base URL configured." };
        const key = readKeys()[id];
        try {
          const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models`, {
            headers: key ? { authorization: `Bearer ${key}` } : {},
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status}` };
          const body = (await res.json().catch(() => ({}))) as {
            data?: { id?: unknown; context_length?: unknown }[];
          };
          const models = (Array.isArray(body.data) ? body.data : [])
            .filter((m): m is { id: string; context_length?: number } => typeof m.id === "string" && m.id.length > 0)
            .map((m) => ({
              id: m.id,
              name: m.id,
              contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
            }));
          if (models.length > 0) {
            provider.models = models;
            writeLocal("deyin.providers", providers);
          }
          return { ok: true, status: res.status, modelCount: models.length };
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    usage: {
      get: async () => computeStats(readLocal<UsageDay[]>("deyin.usage", [])),
      record: async (event) => recordUsage(event),
      account: () =>
        fetchAccountUsage({ oauthIssuer: OAUTH_ISSUER }, () => oauth.getAccessToken().catch(() => null)),
    },
    plans: {
      list: () => fetchPublicPlans({ oauthIssuer: OAUTH_ISSUER }),
    },
    billing: {
      overview: () =>
        fetchBillingOverview({ oauthIssuer: OAUTH_ISSUER }, () => oauth.getAccessToken().catch(() => null)),
      selectPlan: (planId, options) =>
        selectPlan({ oauthIssuer: OAUTH_ISSUER }, () => oauth.getAccessToken().catch(() => null), planId, options),
      publishableKey: () =>
        fetchBillingPublishableKey({ oauthIssuer: OAUTH_ISSUER }, () => oauth.getAccessToken().catch(() => null)),
      completeCrossCurrencyUpgrade: (newSubscriptionId) =>
        completeCrossCurrencyUpgrade(
          { oauthIssuer: OAUTH_ISSUER },
          () => oauth.getAccessToken().catch(() => null),
          newSubscriptionId,
        ),
      abortCrossCurrencyUpgrade: (newSubscriptionId) =>
        abortCrossCurrencyUpgrade(
          { oauthIssuer: OAUTH_ISSUER },
          () => oauth.getAccessToken().catch(() => null),
          newSubscriptionId,
        ),
    },
    win: {
      // No window chrome to control in a browser tab.
      minimize: () => undefined,
      toggleMaximize: () => undefined,
      close: () => undefined,
    },
    browserData: {
      clearCache: async () => undefined,
      clearAll: async () => {
        localStorage.removeItem("deyin.usage");
        localStorage.removeItem("deyin.caps");
      },
    },
    search: {
      query: async (q: string): Promise<SearchResult[]> => {
        const token = await oauth.getAccessToken().catch(() => null);
        if (!token) throw new Error("Sign in to use the built-in search.");
        const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(q)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Search failed (HTTP ${res.status})`);
        }
        const body = (await res.json()) as { results: SearchResult[] };
        return body.results;
      },
    },
    shell: {
      showItem: () => undefined, // no host file manager from a browser tab
      openExternal: (url) => {
        if (/^https?:\/\//.test(url)) window.open(url, "_blank", "noopener");
      },
    },
    paths: {
      get: async () => ({
        userData: "browser-session",
        logs: "browser-session",
        config: "localStorage: deyin.settings",
      }),
    },
    updates: {
      // Web deploys update on reload; the in-app updater is desktop-only.
      getState: async () => ({ status: "unsupported" as const, currentVersion: "web" }),
      check: async () => ({ status: "unsupported" as const, currentVersion: "web" }),
      download: async () => ({ status: "unsupported" as const, currentVersion: "web" }),
      install: () => undefined,
      onState: () => () => undefined,
    },
    identity: {
      get: async () => {
        const member = (await oauth.isAuthenticated().catch(() => false))
          ? await oauth.getUser().then(toProfile).catch(() => null)
          : null;
        const fingerprintFull = webFingerprint();
        return {
          member,
          plan: member?.plan ?? null,
          workspaceName: null,
          workspaceRoot: null,
          device: location.host,
          platform: "web",
          arch: "browser",
          version: "web",
          fingerprint: `${fingerprintFull.slice(0, 4)}…${fingerprintFull.slice(-4)}`,
          fingerprintFull,
          oauthIssuer: OAUTH_ISSUER,
          apiBaseUrl: API_BASE,
          lastSyncedAt: readLocal<string | null>("deyin.identitySyncedAt", null),
          server: null,
          localSecrets: Object.keys(readKeys()).length,
        };
      },
      sync: async () => {
        const syncedAt = await syncWorkspaceIdentity(
          { oauthIssuer: OAUTH_ISSUER },
          () => oauth.getAccessToken().catch(() => null),
          {
            fingerprint: webFingerprint(),
            hostname: location.host,
            platform: "web",
            arch: "browser",
            appVersion: "web",
            workspaceName: null,
          },
        );
        if (syncedAt) writeLocal("deyin.identitySyncedAt", syncedAt);
        return syncedAt ? { ok: true, syncedAt } : { ok: false, syncedAt: null, message: "Sync failed or signed out." };
      },
    },
    diagnostics: {
      send: async (note) => {
        const settings = readLocal<DeyinSettings>("deyin.settings", DEFAULT_SETTINGS);
        return sendDiagnosticsReport(
          { oauthIssuer: OAUTH_ISSUER },
          () => oauth.getAccessToken().catch(() => null),
          {
            reportId: `web-${Date.now().toString(36)}`,
            createdAt: new Date().toISOString(),
            appVersion: "web",
            platform: "web",
            arch: "browser",
            fingerprintFull: webFingerprint(),
            installId: webFingerprint(),
            env: { platform: "web", arch: "browser", wsl2: false, defaultShell: "bash" },
            settings: redactObject({ ...settings } as unknown as Record<string, unknown>),
            logTail: "",
            ...(note ? { note } : {}),
          },
        );
      },
    },
    logs: {
      // No log file in a browser tab; mirror to the devtools console.
      write: (level, message) => {
        if (level === "error") console.error("[deyin]", message);
        else if (level === "warn") console.warn("[deyin]", message);
        else console.info("[deyin]", message);
      },
    },
    automations: {
      list: async () => [],
      create: async (): Promise<never> => {
        throw new Error("Automations are not available in the web app.");
      },
      update: async (): Promise<never> => {
        throw new Error("Automations are not available in the web app.");
      },
      remove: async () => [],
      toggle: async () => [],
      run: async (): Promise<never> => {
        throw new Error("Automations are not available in the web app.");
      },
      stop: () => undefined,
      runs: async () => [],
      onEvent: () => () => undefined,
      onRunFinished: () => () => undefined,
    },
    sshHosts: {
      list: async () => [],
      add: async () => [],
      update: async () => [],
      remove: async () => [],
      setCredentials: async () => [],
      test: async () => ({ ok: false, message: "SSH hosts are not available in the web app." }),
      pinFingerprint: async () => [],
      importKey: async () => null,
    },
    reasonix: {
      metrics: async () => emptyReasonixMetrics(),
      weeklyReport: async () => ({
        generatedAt: new Date().toISOString(),
        weekBucket: emptyReasonixMetrics().weekBucket,
        snapshot: emptyReasonixMetrics(),
        notes: ["Reasonix metrics are not available in the web app."],
      }),
      diagnostics: async () => ({
        cache: {
          prefixShape: null,
          invalidationHistory: [],
          sessionHit: 0,
          sessionMiss: 0,
          hitRate: 0,
        },
        coordinator: [],
        fleet: [],
        evidence: [],
      }),
      clearThreadCache: async () => undefined,
    },
    beta: {
      submitFeedback: async () => ({ ok: false }),
    },
  };
}

/** Stable anonymous id for this browser profile (fingerprint + install id). */
function webFingerprint(): string {
  const key = "deyin.webInstallId";
  let id = localStorage.getItem(key);
  if (!id) {
    id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(key, id);
  }
  return id;
}
