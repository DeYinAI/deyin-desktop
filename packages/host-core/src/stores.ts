import { fetchAccountUsage } from "./account.js";
import {
  DEFAULT_CAPABILITIES,
  DEFAULT_PROVIDERS,
  PROVIDER_SEED_VERSION,
  SETTINGS_SCHEMA_VERSION,
  mergePresetProviders,
  migrateSettings,
  type StoredProviderBase,
} from "./defaults.js";
import { classifyModelKinds, modelImageCapability } from "./images.js";
import { isVideoModel } from "./videos.js";
import { listModels, modelSupportsVision, type TokenSource } from "./models.js";
import { deyinUserAgent } from "./user-agent.js";
import { parseModelReasoningMeta } from "./model-reasoning.js";
import type { Storage } from "./storage.js";
import type {
  AccountUsage,
  CapabilityItem,
  CapabilityKind,
  DeyinSettings,
  ModelInfo,
  ProjectsState,
  ProviderInfo,
  ProviderPatch,
  ProviderTestResult,
  UsageDay,
  UsageEvent,
  UsageStats,
} from "./types.js";
import { applyEvent, computeStats } from "./usage.js";

/** File-backed user settings at <storage.dir>/settings.json, migrated on load. */
interface ProviderCatalogEntry {
  id: string;
  context_length?: unknown;
  max_output_tokens?: unknown;
  vision?: unknown;
  capabilities?: unknown;
  type?: unknown;
  modality?: unknown;
  modalities?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  /** OpenRouter-style nested modality block. */
  architecture?: unknown;
  reasoning?: unknown;
  supported_parameters?: unknown;
}


export class SettingsStore {
  private cache: DeyinSettings;

  constructor(private readonly storage: Storage) {
    // Empty fallback: the merge must not inject schemaVersion before we can
    // tell whether the on-disk file predates the current schema.
    const raw = storage.readJson<Partial<DeyinSettings>>("settings.json", {});
    this.cache = migrateSettings(raw);
    // Persist upgrades so older builds never see half-migrated files again.
    if (raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
      this.storage.writeJson("settings.json", this.cache);
    }
  }

  get(): DeyinSettings {
    return this.cache;
  }

  set(patch: Partial<DeyinSettings>): DeyinSettings {
    this.cache = migrateSettings({ ...this.cache, ...patch });
    this.storage.writeJson("settings.json", this.cache);
    return this.cache;
  }
}

/** Provider record as persisted (includes the encrypted key, never exposed via list). */
interface StoredProvider extends StoredProviderBase {
  /** Output of SecretCipher.encrypt (safeStorage base64 or "plain:"-prefixed fallback). */
  keyCipher?: string;
}

/**
 * Custom-provider base URLs must be absolute http(s) URLs: the stored API key is
 * sent to this origin, so a typo'd scheme (or worse, a non-TLS endpoint) would
 * leak it. Returns false for anything without an explicit http/https scheme.
 */
export function isValidProviderBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

interface AgentsState {
  /** Legacy full capability records; migrated into disabledCaps on load. */
  caps?: CapabilityItem[];
  /** Capability ids the user switched off (live registry entries default to on). */
  disabledCaps: string[];
  providers: StoredProvider[];
  /** Last DEFAULT_PROVIDERS seed version merged into this record. */
  providerSeedVersion?: number;
  /** Encrypted plugin variable values: plugin name -> variable -> cipher text. */
  pluginSecrets?: Record<string, Record<string, string>>;
}

/** File-backed registry for capability toggles and model providers at <storage.dir>/agents.json. */
export class AgentsStore {
  private state: AgentsState;

  constructor(private readonly storage: Storage) {
    this.state = storage.readJson<AgentsState>("agents.json", {
      disabledCaps: [],
      providers: DEFAULT_PROVIDERS,
      providerSeedVersion: PROVIDER_SEED_VERSION,
    });
    this.normalize();
  }

  /** New built-ins appear after updates; old records gain newly added fields. */
  private normalize(): void {
    // Legacy agents.json stored full capability records; only the off-switches
    // carry user intent, so fold them into disabledCaps and drop the seed data.
    this.state.disabledCaps = this.state.disabledCaps ?? [];
    if (this.state.caps) {
      for (const cap of this.state.caps) {
        if (!cap.enabled && !this.state.disabledCaps.includes(cap.id)) {
          this.state.disabledCaps.push(cap.id);
        }
      }
      delete this.state.caps;
      this.persist();
    }
    // One-time merge of newly shipped provider presets + v3 preset disable pass.
    const prevSeed = this.state.providerSeedVersion ?? 0;
    const beforeProviders = this.state.providers;
    const merged = mergePresetProviders(this.state.providers, this.state.providerSeedVersion);
    this.state.providers = merged.providers;
    let changed = merged.providers !== beforeProviders;
    if (prevSeed < 3) {
      for (const p of this.state.providers) {
        if (p.kind !== "custom" || !p.preset || p.keyCipher || p.local) continue;
        if (p.enabled) {
          p.enabled = false;
          changed = true;
        }
      }
    }
    if (changed || prevSeed < PROVIDER_SEED_VERSION) {
      this.state.providerSeedVersion = PROVIDER_SEED_VERSION;
      this.persist();
    }
    this.state.providers = this.state.providers.map((p) => ({
      ...p,
      enabled: p.enabled ?? true,
      apiFormat: p.apiFormat === "responses" || p.apiFormat === "anthropic" ? p.apiFormat : "chat-completions",
      authHeader: p.authHeader === true ? true : undefined,
      models: p.models ?? [],
      disabledModels: p.disabledModels ?? [],
      connectionModes: p.connectionModes ?? ["API key"],
      activeMode: p.activeMode ?? p.connectionModes?.[0] ?? "API key",
    }));
  }

  private persist(): void {
    this.storage.writeJson("agents.json", this.state);
  }

  /** Capability ids the user switched off. */
  disabledCaps(): Set<string> {
    return new Set(this.state.disabledCaps);
  }

  setCapEnabled(id: string, enabled: boolean): void {
    const disabled = new Set(this.state.disabledCaps);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    this.state.disabledCaps = [...disabled];
    this.persist();
  }

  /** Legacy shim: static seed registry filtered by the disabled set. The desktop
   *  host overrides this with the live filesystem registry. */
  listCaps(kind?: CapabilityKind): CapabilityItem[] {
    const disabled = this.disabledCaps();
    const all = DEFAULT_CAPABILITIES.map((c) => ({ ...c, enabled: !disabled.has(c.id) && c.enabled }));
    return kind ? all.filter((c) => c.kind === kind) : all;
  }

  toggleCap(id: string, enabled: boolean): CapabilityItem[] {
    this.setCapEnabled(id, enabled);
    return this.listCaps();
  }

  /* Plugin secrets ---------------------------------------------------------- */

  setPluginSecret(plugin: string, name: string, value: string): void {
    const secrets = (this.state.pluginSecrets ??= {});
    const bag = (secrets[plugin] ??= {});
    if (value) bag[name] = this.storage.cipher.encrypt(value);
    else delete bag[name];
    this.persist();
  }

  getPluginSecrets(plugin: string): Record<string, string> {
    const bag = this.state.pluginSecrets?.[plugin] ?? {};
    const out: Record<string, string> = {};
    for (const [name, cipherText] of Object.entries(bag)) {
      const plain = this.storage.cipher.decrypt(cipherText);
      if (plain !== null) out[name] = plain;
    }
    return out;
  }

  removePluginSecrets(plugin: string): void {
    if (this.state.pluginSecrets?.[plugin]) {
      delete this.state.pluginSecrets[plugin];
      this.persist();
    }
  }

  private toInfo(p: StoredProvider, connected: boolean): ProviderInfo {
    const { keyCipher, ...rest } = p;
    return {
      ...rest,
      // Lists stored before modality classification carry no `kind`.
      models: classifyModelKinds(rest.models),
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
    if (!isValidProviderBaseUrl(input.baseUrl)) return;
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
    if (patch.baseUrl !== undefined && provider.kind === "custom" && isValidProviderBaseUrl(patch.baseUrl)) {
      provider.baseUrl = patch.baseUrl;
    }
    if (patch.apiFormat !== undefined) provider.apiFormat = patch.apiFormat;
    if (patch.authHeader !== undefined) provider.authHeader = patch.authHeader;
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

  /** Count of stored secret values (provider keys + plugin variables); the
   *  values themselves are never enumerated. Shown by the Identity page. */
  secretCount(): number {
    const providerKeys = this.state.providers.filter((p) => Boolean(p.keyCipher)).length;
    const pluginVars = Object.values(this.state.pluginSecrets ?? {}).reduce(
      (sum, bag) => sum + Object.keys(bag).length,
      0,
    );
    return providerKeys + pluginVars;
  }

/** Raw entry from a custom provider's OpenAI-compatible /models catalog. */
/** Fetch the provider's /models catalog and persist it as the provider's model list. */
  async fetchModels(id: string): Promise<ProviderTestResult> {
    const provider = this.state.providers.find((p) => p.id === id);
    if (!provider?.baseUrl) return { ok: false, message: "No base URL configured." };
    const key = provider.keyCipher ? this.storage.cipher.decrypt(provider.keyCipher) : null;
    try {
      const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models`, {
        headers: { "user-agent": deyinUserAgent(), ...(key ? { authorization: `Bearer ${key}` } : {}) },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status}` };
 const body = (await res.json().catch(() => ({}))) as { data?: ProviderCatalogEntry[] };
      const models = (Array.isArray(body.data) ? body.data : [])
        .filter((m): m is ProviderCatalogEntry => typeof m.id === "string" && m.id.length > 0)
        .map((m) => {
          const video = isVideoModel(m.id, m);
          const capability = modelImageCapability(m.id, m);
          const endpointOnly = capability === "endpoint";
          const reasoning = parseModelReasoningMeta(m);
          return {
            id: m.id,
            name: m.id,
            contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
             // Image models take a prompt, not a conversation: never route vision to them.
 // Vision capability is explicit catalog metadata only (see models.ts) — a catalog
 // that says nothing leaves `vision` undefined, so the client sends images anyway
 // and the provider's own error is the fallback.
 vision: video || endpointOnly ? false : modelSupportsVision(m.id, m),
            kind: video ? ("video" as const) : endpointOnly ? ("image" as const) : ("chat" as const),
            ...(capability === "chat" ? { imageOutput: true } : {}),
            ...(reasoning ? { reasoning } : {}),
          };
        });
      if (models.length > 0) {
        provider.models = models;
        provider.modelsFetchedAt = Date.now();
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
        headers: { "user-agent": deyinUserAgent(), ...(key ? { authorization: `Bearer ${key}` } : {}) },
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

/* Server-side caches ---------------------------------------------------------
 * Both caches persist to disk so restarts stay warm, serve stale data instantly
 * and refresh in the background (stale-while-revalidate). */

const ACCOUNT_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const MODELS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

interface AccountCacheFile {
  account: AccountUsage | null;
  fetchedAt: number;
}

/** Cached Openference account snapshot (plan, limits, credits, usage) at account-cache.json. */
export class AccountCache {
  private state: AccountCacheFile;
  private inflight: Promise<AccountUsage | null> | null = null;

  constructor(
    private readonly storage: Storage,
    private readonly config: { oauthIssuer: string },
    private readonly getToken: TokenSource,
  ) {
    this.state = storage.readJson<AccountCacheFile>("account-cache.json", { account: null, fetchedAt: 0 });
  }

  /** Cached snapshot; fetches when stale (or `force`), deduplicating concurrent calls. */
  async get(force = false): Promise<AccountUsage | null> {
    const fresh = Date.now() - this.state.fetchedAt < ACCOUNT_TTL_MS;
    if (!force && fresh) return this.state.account;
    if (this.inflight) return this.inflight;
    this.inflight = fetchAccountUsage(this.config, this.getToken)
      .then((account) => {
        // Keep the last good snapshot when the endpoint is temporarily unreachable.
        if (account !== null || !fresh) {
          this.state = { account, fetchedAt: Date.now() };
          this.storage.writeJson("account-cache.json", this.state);
        }
        return this.state.account;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Cached plan name without hitting the network. */
  planName(): string | null {
    return this.state.account?.planName ?? null;
  }

  /** Drop the snapshot (sign-in/out changes the account behind it). */
  invalidate(): void {
    this.state = { account: null, fetchedAt: 0 };
    this.storage.writeJson("account-cache.json", this.state);
  }
}

interface ModelsCacheFile {
  models: ModelInfo[];
  fetchedAt: number;
}

/** One-week cache of the primary provider's /models catalog at models-cache.json. */
export class ModelsCache {
  private state: ModelsCacheFile;
  private inflight: Promise<ModelInfo[]> | null = null;

  constructor(
    private readonly storage: Storage,
    private readonly config: { apiBaseUrl: string },
    private readonly getToken: TokenSource,
  ) {
    this.state = storage.readJson<ModelsCacheFile>("models-cache.json", { models: [], fetchedAt: 0 });
  }

  async get(force = false): Promise<ModelInfo[]> {
    const fresh = this.state.models.length > 0 && Date.now() - this.state.fetchedAt < MODELS_TTL_MS;
    if (!force && fresh) return this.listCached();
    if (this.inflight) return this.inflight;
    this.inflight = listModels(this.config, this.getToken)
      .then((models) => {
        if (models.length > 0) {
          this.state = { models, fetchedAt: Date.now() };
          this.storage.writeJson("models-cache.json", this.state);
        }
        return this.state.models.length > 0 ? this.listCached() : classifyModelKinds(models);
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Sync peek of the last cached catalog (no network). Empty until first fetch. */
  listCached(): ModelInfo[] {
    // Catalogs cached by an older build carry no `kind`; classify on read.
    return classifyModelKinds(this.state.models);
  }

  fetchedAt(): number {
    return this.state.fetchedAt;
  }

  invalidate(): void {
    this.state = { models: [], fetchedAt: 0 };
    this.storage.writeJson("models-cache.json", this.state);
  }
}

const DEFAULT_PROJECTS_STATE: ProjectsState = {
  projects: [],
  activeProjectId: null,
  activeThreadId: null,
  workspaceRoot: null,
};

/**
 * File-backed project/session state at <storage.dir>/projects.json. Patches merge
 * shallowly: the renderer owns projects + active ids, the host owns workspaceRoot,
 * so neither side can clobber the other's fields.
 */
export class ProjectsStore {
  private state: ProjectsState;

  constructor(private readonly storage: Storage) {
    this.state = storage.readJson<ProjectsState>("projects.json", DEFAULT_PROJECTS_STATE);
  }

  get(): ProjectsState {
    return this.state;
  }

  set(patch: Partial<ProjectsState>): ProjectsState {
    this.state = { ...this.state, ...patch };
    this.storage.writeJson("projects.json", this.state);
    return this.state;
  }
}
