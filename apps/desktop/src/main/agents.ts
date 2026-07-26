import { join } from "node:path";
import { app, safeStorage } from "electron";
import type { CapabilityItem, CapabilityKind, ProviderInfo, ProviderPatch, ProviderTestResult } from "../shared/types.js";
import { JsonFile } from "./settings.js";

/** Default capability registry. Original seed data; toggles persist across restarts. */
export const DEFAULT_CAPABILITIES: CapabilityItem[] = [
  // Plugins
  {
    id: "browser-use",
    kind: "plugin",
    name: "Browser Use",
    description: "Let agent sessions open, inspect and control pages in the built-in browser.",
    enabled: true,
    version: "0.3.0",
    source: "built-in",
  },
  {
    id: "git-tools",
    kind: "plugin",
    name: "Git Tools",
    description: "Stage, diff, commit and inspect history from agent runs.",
    enabled: true,
    version: "0.2.1",
    source: "built-in",
  },
  {
    id: "web-search",
    kind: "plugin",
    name: "Web Search",
    description: "Give the agent real-time web lookups through the built-in search engine.",
    enabled: true,
    version: "0.2.0",
    source: "built-in",
  },
  // Skills
  {
    id: "review-code",
    kind: "skill",
    name: "review-code",
    description: "Structured review pass over a diff: correctness, security, style.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "generate-tests",
    kind: "skill",
    name: "generate-tests",
    description: "Write unit tests for the selected file or the latest change set.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "refactor",
    kind: "skill",
    name: "refactor",
    description: "Apply a named refactoring across the workspace with a preview diff.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "control-browser",
    kind: "skill",
    name: "browser-use:control-browser",
    description: "Drive the built-in browser: navigate, click, type, screenshot.",
    enabled: true,
    source: "plugin:browser-use",
  },
  // Subagents
  {
    id: "explorer",
    kind: "subagent",
    name: "Explorer",
    description: "Fast codebase exploration: find files, symbols and call sites.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "reviewer",
    kind: "subagent",
    name: "Reviewer",
    description: "Independent second pass that critiques the main agent's changes.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "test-runner",
    kind: "subagent",
    name: "Test Runner",
    description: "Runs the test suite and reports failures back to the main agent.",
    enabled: false,
    source: "built-in",
  },
  // MCP servers
  {
    id: "mcp-deyin-search",
    kind: "mcp",
    name: "deyin-search",
    description: "Built-in free web search (DuckDuckGo) exposed to agent sessions as an MCP tool.",
    enabled: true,
    source: "built-in · runs locally",
  },
  {
    id: "mcp-filesystem",
    kind: "mcp",
    name: "filesystem",
    description: "Filesystem MCP server scoped to the current workspace.",
    enabled: true,
    source: "npx @modelcontextprotocol/server-filesystem",
  },
  {
    id: "mcp-github",
    kind: "mcp",
    name: "github",
    description: "GitHub MCP server for issues, PRs and repository metadata.",
    enabled: false,
    source: "npx @modelcontextprotocol/server-github",
  },
  // Commands
  {
    id: "cmd-commit",
    kind: "command",
    name: "/commit",
    description: "Stage everything and write a conventional commit message.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "cmd-explain",
    kind: "command",
    name: "/explain",
    description: "Explain the selected code or the last terminal error.",
    enabled: true,
    source: "built-in",
  },
  {
    id: "cmd-fix",
    kind: "command",
    name: "/fix",
    description: "Propose and apply a fix for the current diagnostics.",
    enabled: true,
    source: "built-in",
  },
  // Hooks
  {
    id: "hook-session-start",
    kind: "hook",
    name: "session-start",
    description: "Runs when a new agent session begins (loads workspace context).",
    enabled: true,
    source: "built-in",
  },
  {
    id: "hook-post-edit",
    kind: "hook",
    name: "post-edit",
    description: "Runs the linter after every file edit the agent makes.",
    enabled: false,
    source: "built-in",
  },
];

/** Provider record as persisted (includes the encrypted key, never exposed via list). */
interface StoredProvider extends Omit<ProviderInfo, "status" | "hasKey"> {
  /** base64 of safeStorage-encrypted key, or plaintext with "plain:" prefix as fallback. */
  keyCipher?: string;
}

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
      {
        id: "starter",
        name: "Starter plan",
        headline: "5 million tokens per day",
        detail: "Daily quota · GLM-5.2 · Kimi K2.7 · DeepSeek V4",
        tone: "green",
      },
      {
        id: "pro",
        name: "For individuals",
        headline: "US$18.00+",
        detail: "For individual developers with a dedicated coding-plan quota.",
        tone: "blue",
      },
    ],
    models: [],
  },
];

interface AgentsState {
  caps: CapabilityItem[];
  providers: StoredProvider[];
}

function encryptKey(key: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(key).toString("base64");
    }
  } catch {
    // fall through to plaintext marker
  }
  return `plain:${key}`;
}

function decryptKey(cipher: string | undefined): string | null {
  if (!cipher) return null;
  if (cipher.startsWith("plain:")) return cipher.slice(6);
  try {
    return safeStorage.decryptString(Buffer.from(cipher, "base64"));
  } catch {
    return null;
  }
}

/** File-backed registry for capabilities and model providers. */
export class AgentsStore {
  private readonly json: JsonFile<AgentsState>;
  private state: AgentsState;

  constructor(dir: string = app.getPath("userData")) {
    this.json = new JsonFile<AgentsState>(join(dir, "agents.json"), {
      caps: DEFAULT_CAPABILITIES,
      providers: DEFAULT_PROVIDERS,
    });
    this.state = this.json.read();
    this.normalize();
  }

  /** New built-ins appear after updates; old records gain newly added fields. */
  private normalize(): void {
    const known = new Set(this.state.caps.map((c) => c.id));
    for (const cap of DEFAULT_CAPABILITIES) {
      if (!known.has(cap.id)) this.state.caps.push(cap);
    }
    this.state.providers = this.state.providers.map((p) => ({
      ...p,
      enabled: p.enabled ?? true,
      apiFormat: p.apiFormat ?? "chat-completions",
      models: p.models ?? [],
      plans: p.plans ?? [],
      connectionModes: p.connectionModes ?? ["API key"],
      activeMode: p.activeMode ?? p.connectionModes?.[0] ?? "API key",
    }));
  }

  private persist(): void {
    this.json.write(this.state);
  }

  listCaps(kind?: CapabilityKind): CapabilityItem[] {
    return kind ? this.state.caps.filter((c) => c.kind === kind) : this.state.caps;
  }

  toggleCap(id: string, enabled: boolean): CapabilityItem[] {
    const cap = this.state.caps.find((c) => c.id === id);
    if (cap) {
      cap.enabled = enabled;
      this.persist();
    }
    return this.state.caps;
  }

  private toInfo(p: StoredProvider, connected: boolean): ProviderInfo {
    const { keyCipher, ...rest } = p;
    return {
      ...rest,
      status: p.kind === "primary" ? (connected ? "connected" : "not-connected") : keyCipher ? "connected" : "not-connected",
      hasKey: Boolean(keyCipher),
    };
  }

  listProviders(connected: boolean): ProviderInfo[] {
    return this.state.providers.map((p) => this.toInfo(p, connected));
  }

  addProvider(input: { name: string; baseUrl: string }): void {
    const id = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (!id || this.state.providers.some((p) => p.id === id)) return;
    this.state.providers.push({
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
    this.persist();
  }

  updateProvider(id: string, patch: ProviderPatch): void {
    const provider = this.state.providers.find((p) => p.id === id);
    if (!provider) return;
    if (patch.name !== undefined && provider.kind === "custom") provider.name = patch.name;
    if (patch.baseUrl !== undefined && provider.kind === "custom") provider.baseUrl = patch.baseUrl;
    if (patch.apiFormat !== undefined) provider.apiFormat = patch.apiFormat;
    if (patch.enabled !== undefined) provider.enabled = patch.enabled;
    if (patch.activeMode !== undefined) provider.activeMode = patch.activeMode;
    if (patch.models !== undefined) provider.models = patch.models;
    this.persist();
  }

  removeProvider(id: string): void {
    const provider = this.state.providers.find((p) => p.id === id);
    if (!provider || provider.kind === "primary") return;
    this.state.providers = this.state.providers.filter((p) => p.id !== id);
    this.persist();
  }

  setKey(id: string, key: string): void {
    const provider = this.state.providers.find((p) => p.id === id);
    if (!provider) return;
    provider.keyCipher = key ? encryptKey(key) : undefined;
    this.persist();
  }

  getKey(id: string): string | null {
    return decryptKey(this.state.providers.find((p) => p.id === id)?.keyCipher);
  }

  /** Ping the provider's /models endpoint with its stored key. */
  async testProvider(id: string): Promise<ProviderTestResult> {
    const provider = this.state.providers.find((p) => p.id === id);
    if (!provider?.baseUrl) return { ok: false, message: "No base URL configured." };
    const key = decryptKey(provider.keyCipher);
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
  }
}
