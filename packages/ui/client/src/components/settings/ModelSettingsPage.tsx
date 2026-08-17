import { useEffect, useState } from "react";
import { Icon } from "../Icon.js";
import { formatContext } from "../ModelPicker.js";
import { PageHeader, Toggle } from "./controls.js";
import type {
  AccountUsage,
  ModelInfo,
  ProviderInfo,
  ProviderModel,
  ProviderPatch,
  ProviderTestResult,
} from "@deyin/contract";

interface Props {
  providers: ProviderInfo[];
  /** Live models for the primary provider (served from the 1-week cache). */
  liveModels: ModelInfo[];
  busy: boolean;
  onConnect: () => void;
  onProvidersChanged: (providers: ProviderInfo[]) => void;
  /** Force-refresh the primary provider's cached /models catalog. */
  onRefreshLiveModels: () => Promise<void>;
}

/** Sentinel id for the unsaved "Add provider" draft shown in the detail pane. */
const DRAFT_ID = "__draft__";

export function ModelSettingsPage(props: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(props.providers[0]?.id ?? null);
  const [account, setAccount] = useState<AccountUsage | null>(null);

  useEffect(() => {
    if (!selectedId && props.providers[0]) setSelectedId(props.providers[0].id);
  }, [props.providers, selectedId]);

  // Cached account snapshot: the plan shown on the primary provider.
  useEffect(() => {
    void window.deyin.usage.account().then(setAccount).catch(() => setAccount(null));
  }, []);

  const adding = selectedId === DRAFT_ID;
  const selected = adding ? null : (props.providers.find((p) => p.id === selectedId) ?? props.providers[0] ?? null);
  const primaries = props.providers.filter((p) => p.kind === "primary");
  const customs = props.providers.filter((p) => p.kind === "custom");

  return (
    <div className="settings-page">
      <PageHeader
        title="Model settings"
        description="Manage model providers. Once configured, they can be selected during chat."
      >
        <button
          className="icon-btn"
          title="Refresh"
          onClick={() => void window.deyin.providers.list().then(props.onProvidersChanged)}
        >
          <Icon name="refresh" size={14} />
        </button>
      </PageHeader>

      <div className="providers">
        <div className="providers__list">
          <div className="providers__group">Providers</div>
          {primaries.map((p) => (
            <ProviderRow key={p.id} provider={p} active={selected?.id === p.id} onClick={() => setSelectedId(p.id)} />
          ))}
          <div className="providers__group">Custom providers</div>
          {customs.map((p) => (
            <ProviderRow key={p.id} provider={p} active={selected?.id === p.id} onClick={() => setSelectedId(p.id)} />
          ))}
          <button
            className={`providers__add ${adding ? "providers__add--active" : ""}`}
            onClick={() => setSelectedId(DRAFT_ID)}
          >
            <Icon name="plus" size={13} />
            Add provider
          </button>
        </div>

        {adding && (
          <ProviderDraft
            onCancel={() => setSelectedId(props.providers[0]?.id ?? null)}
            onCreated={(providers, newId) => {
              props.onProvidersChanged(providers);
              setSelectedId(newId);
            }}
          />
        )}
        {!adding && selected && (
          <ProviderDetail
            key={selected.id}
            provider={selected}
            liveModels={props.liveModels}
            planName={account?.planName ?? null}
            busy={props.busy}
            onConnect={props.onConnect}
            onProvidersChanged={props.onProvidersChanged}
            onRefreshLiveModels={props.onRefreshLiveModels}
          />
        )}
      </div>
    </div>
  );
}

function ProviderRow({ provider, active, onClick }: { provider: ProviderInfo; active: boolean; onClick: () => void }) {
  return (
    <button className={`provider-row ${active ? "provider-row--active" : ""}`} onClick={onClick}>
      <span className="provider-row__name">{provider.name}</span>
      {provider.local && <span className="badge badge--muted">local</span>}
      <span className={`provider-row__status ${provider.status === "connected" ? "provider-row__status--on" : ""}`} />
    </button>
  );
}

/* New provider draft (unsaved until Save) -------------------------------------- */

/** Curated presets (DeepSeek, OpenAI, ...) live in DEFAULT_PROVIDERS and are
 *  seeded into the store automatically — this draft is for custom endpoints. */
function ProviderDraft({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (providers: ProviderInfo[], newId: string) => void;
}) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiFormat, setApiFormat] = useState<ProviderInfo["apiFormat"]>("chat-completions");
  const [authHeader, setAuthHeader] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim() || !baseUrl.trim()) {
      setError("Name and base URL are required.");
      return;
    }
    let scheme = "";
    try {
      scheme = new URL(baseUrl.trim()).protocol;
    } catch {
      setError("Base URL is not a valid URL (expected http:// or https://).");
      return;
    }
    if (scheme !== "http:" && scheme !== "https:") {
      setError("Base URL must start with http:// or https://.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let providers = await window.deyin.providers.add({ name: name.trim(), baseUrl: baseUrl.trim() });
      const created = providers.find((p) => p.kind === "custom" && p.name === name.trim());
      if (!created) {
        setError("A provider with that name already exists.");
        return;
      }
      if (apiFormat !== "chat-completions") {
        providers = await window.deyin.providers.update(created.id, { apiFormat });
      }
      if (apiFormat === "anthropic" && authHeader) {
        providers = await window.deyin.providers.update(created.id, { authHeader: true });
      }
      if (key.trim()) {
        providers = await window.deyin.providers.setKey(created.id, key.trim());
      }
      onCreated(providers, created.id);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="providers__detail">
      <div className="providers__detail-head">
        <span className="providers__detail-name">New provider</span>
        <span className="badge badge--muted">Unsaved</span>
        <div className="providers__detail-spacer" />
      </div>

      <div className="field">
        <label className="field__label">Name</label>
        <input className="input" placeholder="My provider" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label className="field__label">Base URL</label>
        <input
          className="input"
          placeholder="https://api.example.com/v1"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="field__label">API format</label>
        <select
          className="select"
          style={{ width: "100%" }}
          value={apiFormat}
          onChange={(e) => setApiFormat(e.target.value as ProviderInfo["apiFormat"])}
        >
          <option value="chat-completions">Chat completions (/chat/completions)</option>
          <option value="responses">Responses (/responses)</option>
          <option value="anthropic">Anthropic (/v1/messages)</option>
        </select>
      </div>
      {apiFormat === "anthropic" && (
        <label className="field__row" style={{ gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={authHeader} onChange={(e) => setAuthHeader(e.target.checked)} />
          <span>Use Authorization: Bearer instead of x-api-key (Anthropic-compatible gateways)</span>
        </label>
      )}
      <div className="field">
        <label className="field__label">API key (optional)</label>
        <input className="input" type="password" placeholder="sk-..." value={key} onChange={(e) => setKey(e.target.value)} />
      </div>
      {error && <div className="hint hint--bad">{error}</div>}
      <div className="providers__add-actions">
        <button className="chip chip--small" onClick={onCancel}>Cancel</button>
        <button className="chip chip--small chip--active" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save provider"}
        </button>
      </div>
    </div>
  );
}

/* Detail editor --------------------------------------------------------------- */

interface DetailProps {
  provider: ProviderInfo;
  liveModels: ModelInfo[];
  /** Cached Openference plan name shown on the primary provider. */
  planName: string | null;
  busy: boolean;
  onConnect: () => void;
  onProvidersChanged: (providers: ProviderInfo[]) => void;
  onRefreshLiveModels: () => Promise<void>;
}

function ProviderDetail({ provider, liveModels, planName, busy, onConnect, onProvidersChanged, onRefreshLiveModels }: DetailProps) {
  const isCustom = provider.kind === "custom";
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [keyDraft, setKeyDraft] = useState("");
  const [keyVisible, setKeyVisible] = useState(false);
  const [keyDirty, setKeyDirty] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [addingModel, setAddingModel] = useState(false);
  const [modelId, setModelId] = useState("");
  const [modelCtx, setModelCtx] = useState("200000");
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchMessage, setFetchMessage] = useState<string | null>(null);

  const apply = async (patch: ProviderPatch) => {
    onProvidersChanged(await window.deyin.providers.update(provider.id, patch));
  };

  const saveKey = async () => {
    if (!keyDirty) return;
    onProvidersChanged(await window.deyin.providers.setKey(provider.id, keyDraft));
    setKeyDraft("");
    setKeyDirty(false);
    setKeyVisible(false);
  };

  const removeProvider = async () => {
    onProvidersChanged(await window.deyin.providers.remove(provider.id));
  };

  const test = async () => {
    setTestResult(null);
    setTestResult(await window.deyin.providers.test(provider.id));
  };

  const addModel = async () => {
    const id = modelId.trim();
    if (!id) return;
    const models: ProviderModel[] = [...provider.models, { id, name: id, contextLength: Number(modelCtx) || undefined }];
    await apply({ models });
    setAddingModel(false);
    setModelId("");
  };

  const removeModel = async (id: string) => {
    await apply({ models: provider.models.filter((m) => m.id !== id) });
  };

  /** Persist the on/off state of one model id. */
  const toggleModel = async (id: string, enabled: boolean) => {
    const disabled = new Set(provider.disabledModels);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    await apply({ disabledModels: [...disabled] });
  };

  /** Force-refresh the model catalog (bypasses the 1-week cache). */
  const fetchModels = async () => {
    setFetchingModels(true);
    setFetchMessage(null);
    try {
      if (isCustom) {
        const res = await window.deyin.providers.fetchModels(provider.id);
        if (res.ok) {
          onProvidersChanged(await window.deyin.providers.list());
          setFetchMessage(
            res.modelCount ? `Loaded ${res.modelCount} models from the provider.` : "The provider returned no models.",
          );
        } else {
          setFetchMessage(`Fetch failed: ${res.message ?? `HTTP ${res.status}`}`);
        }
      } else {
        await onRefreshLiveModels();
        setFetchMessage("Model list refreshed.");
      }
    } finally {
      setFetchingModels(false);
    }
  };

  const shownModels: ProviderModel[] = isCustom
    ? provider.models
    : liveModels.map((m) => ({ id: m.id, name: m.name, contextLength: m.contextLength }));

  const cachedAgo =
    isCustom && provider.modelsFetchedAt
      ? `Model list fetched ${describeAge(provider.modelsFetchedAt)}; cached for one week.`
      : !isCustom
        ? "Model list is cached for one week; refresh to fetch the live catalog."
        : null;

  return (
    <div className="providers__detail">
      <div className="providers__detail-head">
        {renaming ? (
          <input
            className="input"
            style={{ maxWidth: 200 }}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setRenaming(false);
              if (name.trim() && name !== provider.name) void apply({ name: name.trim() });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        ) : (
          <span className="providers__detail-name">{provider.name}</span>
        )}
        {isCustom && !renaming && (
          <button className="icon-btn icon-btn--small" title="Rename" onClick={() => setRenaming(true)}>
            <Icon name="pencil" size={12} />
          </button>
        )}
        {provider.enabled ? <span className="badge badge--ok">Enabled</span> : <span className="badge badge--muted">Disabled</span>}
        <button className="chip chip--small" onClick={() => void apply({ enabled: !provider.enabled })}>
          {provider.enabled ? "Disable" : "Enable"}
        </button>
        <div className="providers__detail-spacer" />
        {isCustom && (
          <button className="icon-btn icon-btn--small" title="Delete provider" onClick={() => void removeProvider()}>
            <Icon name="trash" size={13} />
          </button>
        )}
      </div>

      {provider.kind === "primary" && (
        <div className="plan-connect">
          <div className="plan-connect__meta">
            <span className="plan-connect__title">
              Coding plan
              {provider.status === "connected" && (
                <span className="badge badge--ok" style={{ marginLeft: 8 }}>
                  {planName ?? "Connected"}
                </span>
              )}
            </span>
            <span className="hint">
              {provider.status === "connected"
                ? planName
                  ? `Signed in on the ${planName} plan.`
                  : "Connected via Openference sign-in."
                : "Not connected"}
            </span>
          </div>
          {provider.status !== "connected" && (
            <button className="btn btn--outline" disabled={busy} onClick={onConnect}>
              {busy ? "Connecting..." : `Connect to ${provider.name}`}
            </button>
          )}
        </div>
      )}

      <div className="field">
        <label className="field__label">Base URL</label>
        <input
          className="input"
          value={baseUrl}
          disabled={!isCustom}
          placeholder="https://api.example.com/v1"
          onChange={(e) => setBaseUrl(e.target.value)}
          onBlur={() => {
            if (isCustom && baseUrl.trim() && baseUrl !== provider.baseUrl) void apply({ baseUrl: baseUrl.trim() });
          }}
        />
      </div>

      <div className="field">
        <label className="field__label">API format</label>
        <select
          className="select"
          style={{ width: "100%" }}
          value={provider.apiFormat}
          onChange={(e) => void apply({ apiFormat: e.target.value as ProviderInfo["apiFormat"] })}
        >
          <option value="chat-completions">Chat completions (/chat/completions)</option>
          <option value="responses">Responses (/responses)</option>
          <option value="anthropic">Anthropic (/v1/messages)</option>
        </select>
      </div>
      {provider.apiFormat === "anthropic" && provider.kind === "custom" && (
        <label className="field__row" style={{ gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={provider.authHeader === true}
            onChange={(e) => void apply({ authHeader: e.target.checked })}
          />
          <span>Use Authorization: Bearer instead of x-api-key (Anthropic-compatible gateways)</span>
        </label>
      )}

      <div className="field">
        <label className="field__label">API key</label>
        {provider.kind === "primary" ? (
          <div className="hint" style={{ padding: "6px 0" }}>
            Managed by your Openference sign-in - no key needed.
          </div>
        ) : (
          <div className="field__row">
            <input
              className="input"
              type={keyVisible ? "text" : "password"}
              placeholder={provider.hasKey && !keyDirty ? "••••••••••••••••••••••••••••" : "sk-..."}
              value={keyDraft}
              onChange={(e) => {
                setKeyDraft(e.target.value);
                setKeyDirty(true);
              }}
              onBlur={() => void saveKey()}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <button className="icon-btn" title={keyVisible ? "Hide" : "Reveal"} onClick={() => setKeyVisible((v) => !v)}>
              <Icon name="eye" size={14} />
            </button>
            <button className="icon-btn" title="Test connection" onClick={() => void test()}>
              <Icon name="link" size={14} />
            </button>
          </div>
        )}
        {testResult && (
          <div className={testResult.ok ? "hint hint--ok" : "hint hint--bad"}>
            {testResult.ok
              ? `Connection OK${testResult.modelCount !== undefined ? ` · ${testResult.modelCount} models` : ""}`
              : `Connection failed: ${testResult.message ?? testResult.status}`}
          </div>
        )}
      </div>

      <div className="field">
        <label className="field__label">Model list</label>
        {cachedAgo && <div className="hint" style={{ marginBottom: 6 }}>{cachedAgo}</div>}
        <div className="modellist">
          {shownModels.map((model) => {
            const modelEnabled = !provider.disabledModels.includes(model.id);
            return (
              <div className={`modellist__row ${modelEnabled ? "" : "modellist__row--off"}`} key={model.id}>
                <code className="modellist__id">{model.name}</code>
                {formatContext(model.contextLength) && (
                  <span className="badge badge--muted">{formatContext(model.contextLength)}</span>
                )}
                <div className="modellist__spacer" />
                {isCustom && (
                  <button className="icon-btn icon-btn--small" title="Remove" onClick={() => void removeModel(model.id)}>
                    <Icon name="trash" size={12} />
                  </button>
                )}
                <Toggle checked={modelEnabled} onChange={(on) => void toggleModel(model.id, on)} />
              </div>
            );
          })}
          {shownModels.length === 0 && !addingModel && (
            <div className="hint" style={{ padding: "4px 2px" }}>
              {isCustom
                ? "No models yet - fetch the list from the provider or add model ids manually."
                : "Connect to load the live model list."}
            </div>
          )}
          {addingModel && isCustom ? (
            <div className="modellist__row modellist__row--form">
              <input
                className="input"
                placeholder="model-id"
                value={modelId}
                autoFocus
                onChange={(e) => setModelId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addModel();
                }}
              />
              <select className="select select--small" value={modelCtx} onChange={(e) => setModelCtx(e.target.value)}>
                <option value="128000">128K</option>
                <option value="200000">200K</option>
                <option value="1000000">1M</option>
                <option value="2000000">2M</option>
              </select>
              <button className="chip chip--small" onClick={() => setAddingModel(false)}>Cancel</button>
              <button className="chip chip--small chip--active" onClick={() => void addModel()}>Add</button>
            </div>
          ) : (
            <div className="modellist__actions">
              <button className="providers__add" disabled={fetchingModels} onClick={() => void fetchModels()}>
                <Icon name="refresh" size={13} />
                {fetchingModels ? "Fetching..." : isCustom ? "Fetch models" : "Refresh models"}
              </button>
              {isCustom && (
                <button className="providers__add" onClick={() => setAddingModel(true)}>
                  <Icon name="plus" size={13} />
                  Add model
                </button>
              )}
            </div>
          )}
          {fetchMessage && (
            <div className={fetchMessage.startsWith("Fetch failed") ? "hint hint--bad" : "hint hint--ok"}>
              {fetchMessage}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function describeAge(epochMs: number): string {
  const days = Math.floor((Date.now() - epochMs) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
