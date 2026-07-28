import { DEFAULT_CAPABILITIES, DEFAULT_PROVIDERS, DEFAULT_SETTINGS, type StoredProviderBase } from "./defaults.js";
import type { Storage } from "./storage.js";
import type {
  CapabilityItem,
  CapabilityKind,
  DeyinSettings,
  ProviderInfo,
  ProviderPatch,
  ProviderTestResult,
  UsageDay,
  UsageEvent,
  UsageStats,
} from "./types.js";
import { applyEvent, computeStats } from "./usage.js";

/** File-backed user settings at <storage.dir>/settings.json. */
export class SettingsStore {
  private cache: DeyinSettings;

  constructor(private readonly storage: Storage) {
    this.cache = storage.readJson("settings.json", DEFAULT_SETTINGS);
  }

  get(): DeyinSettings {
    return this.cache;
  }

  set(patch: Partial<DeyinSettings>): DeyinSettings {
    this.cache = { ...this.cache, ...patch };
    this.storage.writeJson("settings.json", this.cache);
    return this.cache;
  }
}

/** Provider record as persisted (includes the encrypted key, never exposed via list). */
interface StoredProvider extends StoredProviderBase {
  /** Output of SecretCipher.encrypt (safeStorage base64 or "plain:"-prefixed fallback). */
  keyCipher?: string;
}

interface AgentsState {
  caps: CapabilityItem[];
  providers: StoredProvider[];
}

/** File-backed registry for capabilities and model providers at <storage.dir>/agents.json. */
export class AgentsStore {
  private state: AgentsState;

  constructor(private readonly storage: Storage) {
    this.state = storage.readJson<AgentsState>("agents.json", {
      caps: DEFAULT_CAPABILITIES,
      providers: DEFAULT_PROVIDERS,
    });
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
      disabledModels: p.disabledModels ?? [],
      connectionModes: p.connectionModes ?? ["API key"],
      activeMode: p.activeMode ?? p.connectionModes?.[0] ?? "API key",
    }));
  }

  private persist(): void {
    this.storage.writeJson("agents.json", this.state);
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
      models: [],
      disabledModels: [],
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
    if (patch.disabledModels !== undefined) provider.disabledModels = patch.disabledModels;
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
    provider.keyCipher = key ? this.storage.cipher.encrypt(key) : undefined;
    this.persist();
  }

  getKey(id: string): string | null {
    const cipherText = this.state.providers.find((p) => p.id === id)?.keyCipher;
    return cipherText ? this.storage.cipher.decrypt(cipherText) : null;
  }

  /** Fetch the provider's /models catalog and persist it as the provider's model list. */
  async fetchModels(id: string): Promise<ProviderTestResult> {
    const provider = this.state.providers.find((p) => p.id === id);
    if (!provider?.baseUrl) return { ok: false, message: "No base URL configured." };
    const key = provider.keyCipher ? this.storage.cipher.decrypt(provider.keyCipher) : null;
    try {
      const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status}` };
      const body = (await res.json().catch(() => ({}))) as {
        data?: { id?: unknown; context_length?: unknown; max_output_tokens?: unknown }[];
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
        this.persist();
      }
      return { ok: true, status: res.status, modelCount: models.length };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Ping the provider's /models endpoint with its stored key. */
  async testProvider(id: string): Promise<ProviderTestResult> {
    const provider = this.state.providers.find((p) => p.id === id);
    if (!provider?.baseUrl) return { ok: false, message: "No base URL configured." };
    const key = provider.keyCipher ? this.storage.cipher.decrypt(provider.keyCipher) : null;
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

/** File-backed usage log at <storage.dir>/usage.json. */
export class UsageStore {
  private days: UsageDay[];

  constructor(private readonly storage: Storage) {
    this.days = storage.readJson<{ days: UsageDay[] }>("usage.json", { days: [] }).days;
  }

  record(event: UsageEvent): void {
    this.days = applyEvent(this.days, event);
    this.storage.writeJson("usage.json", { days: this.days });
  }

  stats(): UsageStats {
    return computeStats(this.days);
  }
}
