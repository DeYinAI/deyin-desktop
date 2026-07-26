import { OAuthClient, type TokenSet, type TokenStore } from "@deyin/oauth-client";
import { beginBrowserLogin, completeBrowserLogin } from "@deyin/oauth-client/browser";
import type { DeyinApi } from "@contract/ipc.js";
import type {
  Bootstrap,
  CapabilityItem,
  DeyinSettings,
  EnvInfo,
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
  ServerMessage,
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
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private dataHandlers = new Set<(e: { id: string; data: string }) => void>();
  private exitHandlers = new Set<(e: { id: string; exitCode: number }) => void>();

  async ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      void (async () => {
        const token = await oauth.getAccessToken().catch(() => null);
        if (!token) return reject(new Error("Not authenticated"));
        const url = `${location.origin.replace(/^http/, "ws")}/host`;
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data as string) as ServerMessage, resolve, reject);
        ws.onerror = () => reject(new Error("Host socket error"));
        ws.onclose = () => {
          this.ready = undefined;
          this.ws = undefined;
        };
        ws.onopen = () => this.raw({ type: "auth", token });
      })();
    });
    return this.ready;
  }

  private onMessage(msg: ServerMessage, resolveReady: () => void, rejectReady: (e: Error) => void) {
    switch (msg.type) {
      case "auth.ok":
        resolveReady();
        break;
      case "auth.err":
        rejectReady(new Error(msg.message));
        break;
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
    void this.ensure().then(() => this.raw(msg));
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
    return raw ? ({ ...fallback, ...(JSON.parse(raw) as T) } as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

const DEFAULT_SETTINGS: DeyinSettings = {
  theme: "dark",
  language: "en",
  fontSize: 14,
  autoUpdate: true,
  telemetry: false,
  browserControlEnabled: true,
  defaultModel: null,
  approvalMode: "full-access",
  thinking: true,
  codeThemeLight: "GitHub Light",
  codeThemeDark: "GitHub Dark",
  showLineNumbers: true,
  wrapLongLines: false,
  codeFontSize: 12,
};

const DEFAULT_CAPS: CapabilityItem[] = [
  { id: "browser-use", kind: "plugin", name: "Browser Use", description: "Let agent sessions open, inspect and control pages in the built-in browser.", enabled: true, version: "0.3.0", source: "built-in" },
  { id: "git-tools", kind: "plugin", name: "Git Tools", description: "Stage, diff, commit and inspect history from agent runs.", enabled: true, version: "0.2.1", source: "built-in" },
  { id: "web-search", kind: "plugin", name: "Web Search", description: "Give the agent real-time web lookups through the built-in search engine.", enabled: true, version: "0.2.0", source: "built-in" },
  { id: "mcp-deyin-search", kind: "mcp", name: "deyin-search", description: "Built-in free web search (DuckDuckGo) exposed to agent sessions as an MCP tool.", enabled: true, source: "built-in · runs locally" },
  { id: "review-code", kind: "skill", name: "review-code", description: "Structured review pass over a diff: correctness, security, style.", enabled: true, source: "built-in" },
  { id: "generate-tests", kind: "skill", name: "generate-tests", description: "Write unit tests for the selected file or the latest change set.", enabled: true, source: "built-in" },
  { id: "refactor", kind: "skill", name: "refactor", description: "Apply a named refactoring across the workspace with a preview diff.", enabled: true, source: "built-in" },
  { id: "control-browser", kind: "skill", name: "browser-use:control-browser", description: "Drive the built-in browser: navigate, click, type, screenshot.", enabled: true, source: "plugin:browser-use" },
  { id: "explorer", kind: "subagent", name: "Explorer", description: "Fast codebase exploration: find files, symbols and call sites.", enabled: true, source: "built-in" },
  { id: "reviewer", kind: "subagent", name: "Reviewer", description: "Independent second pass that critiques the main agent's changes.", enabled: true, source: "built-in" },
  { id: "test-runner", kind: "subagent", name: "Test Runner", description: "Runs the test suite and reports failures back to the main agent.", enabled: false, source: "built-in" },
  { id: "mcp-filesystem", kind: "mcp", name: "filesystem", description: "Filesystem MCP server scoped to the current workspace.", enabled: true, source: "npx @modelcontextprotocol/server-filesystem" },
  { id: "mcp-github", kind: "mcp", name: "github", description: "GitHub MCP server for issues, PRs and repository metadata.", enabled: false, source: "npx @modelcontextprotocol/server-github" },
  { id: "cmd-commit", kind: "command", name: "/commit", description: "Stage everything and write a conventional commit message.", enabled: true, source: "built-in" },
  { id: "cmd-explain", kind: "command", name: "/explain", description: "Explain the selected code or the last terminal error.", enabled: true, source: "built-in" },
  { id: "cmd-fix", kind: "command", name: "/fix", description: "Propose and apply a fix for the current diagnostics.", enabled: true, source: "built-in" },
  { id: "hook-session-start", kind: "hook", name: "session-start", description: "Runs when a new agent session begins (loads workspace context).", enabled: true, source: "built-in" },
  { id: "hook-post-edit", kind: "hook", name: "post-edit", description: "Runs the linter after every file edit the agent makes.", enabled: false, source: "built-in" },
];

type StoredProvider = Omit<ProviderInfo, "status" | "hasKey">;

const DEFAULT_PROVIDERS: StoredProvider[] = [
  {
    id: "openference",
    name: "Openference",
    kind: "primary",
    enabled: true,
    baseUrl: "https://api.openference.com/v1",
    apiFormat: "chat-completions",
    connectionModes: ["Individual plan", "Team plan", "API key"],
    activeMode: "Individual plan",
    quotaNote: "+50% quota",
    plans: [
      { id: "starter", name: "Starter plan", headline: "5 million tokens per day", detail: "Daily quota · GLM-5.2 · Kimi K2.7 · DeepSeek V4", tone: "green" },
      { id: "pro", name: "For individuals", headline: "US$18.00+", detail: "For individual developers with a dedicated coding-plan quota.", tone: "blue" },
    ],
    models: [],
  },
];

function readProviders(): StoredProvider[] {
  return readLocal<StoredProvider[]>("deyin.providers", DEFAULT_PROVIDERS).map((p) => ({
    ...p,
    enabled: p.enabled ?? true,
    apiFormat: p.apiFormat ?? "chat-completions",
    models: p.models ?? [],
    plans: p.plans ?? [],
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

function computeUsageStats(days: UsageDay[]) {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const byModel = new Map<string, number>();
  let totalTokens = 0;
  let messages = 0;
  let sessions = 0;
  for (const day of sorted) {
    messages += day.messages;
    sessions += day.sessions;
    for (const [model, tokens] of Object.entries(day.byModel)) {
      totalTokens += tokens;
      byModel.set(model, (byModel.get(model) ?? 0) + tokens);
    }
  }
  let favorite: { id: string; share: number } | null = null;
  for (const [id, tokens] of byModel) {
    if (!favorite || tokens > (byModel.get(favorite.id) ?? 0)) {
      favorite = { id, share: totalTokens > 0 ? Math.round((tokens / totalTokens) * 100) : 0 };
    }
  }
  const active = new Set(sorted.filter((d) => d.messages > 0).map((d) => d.date));
  let streak = 0;
  const cursor = new Date();
  if (!active.has(cursor.toISOString().slice(0, 10))) cursor.setDate(cursor.getDate() - 1);
  while (active.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return {
    totalTokens,
    sessions,
    messages,
    activeDays: active.size,
    currentStreak: streak,
    favoriteModel: favorite,
    days: sorted,
  };
}

function recordUsage(event: UsageEvent): void {
  const days = readLocal<UsageDay[]>("deyin.usage", []);
  const key = new Date().toISOString().slice(0, 10);
  let day = days.find((d) => d.date === key);
  if (!day) {
    day = { date: key, byModel: {}, messages: 0, sessions: 0 };
    days.push(day);
  }
  day.byModel[event.model] = (day.byModel[event.model] ?? 0) + Math.max(0, Math.round(event.tokens));
  day.messages += 1;
  if (event.newSession) day.sessions += 1;
  writeLocal("deyin.usage", days);
}

/** Build the browser implementation of the DeyinApi contract. */
export function createBrowserTransport(): DeyinApi {
  const host = new HostSocket();

  return {
    async bootstrap(): Promise<Bootstrap> {
      let user: UserProfile | null = null;
      if (await oauth.isAuthenticated()) {
        user = await oauth.getUser().then(toProfile).catch(() => null);
      }
      return {
        config: { oauthIssuer: OAUTH_ISSUER, apiBaseUrl: API_BASE, clientId: CLIENT_ID },
        user,
        workspaceRoot: null,
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
    },
    files: {
      tree: (dir) => host.invoke<FilesTreeResult>((id) => ({ type: "files.tree", id, dir })).then((r) => r.nodes),
      read: (path) => host.invoke<FilesReadResult>((id) => ({ type: "files.read", id, path })).then((r) => r.content),
    },
    workspace: {
      openFolder: async () => null, // web sessions use the server-provisioned sandbox root
    },
    terminal: {
      create: (opts) => host.invoke<TermCreateResult>((id) => ({ type: "term.create", id, opts })).then((r) => r.termId),
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
        const caps = readLocal<CapabilityItem[]>("deyin.caps", DEFAULT_CAPS);
        return kind ? caps.filter((c) => c.kind === kind) : caps;
      },
      toggle: async (id, enabled) => {
        const caps = readLocal<CapabilityItem[]>("deyin.caps", DEFAULT_CAPS);
        const cap = caps.find((c) => c.id === id);
        if (cap) cap.enabled = enabled;
        writeLocal("deyin.caps", caps);
        return caps;
      },
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
            plans: [],
            models: [],
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
    },
    usage: {
      get: async () => computeUsageStats(readLocal<UsageDay[]>("deyin.usage", [])),
      record: async (event) => recordUsage(event),
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
  };
}
