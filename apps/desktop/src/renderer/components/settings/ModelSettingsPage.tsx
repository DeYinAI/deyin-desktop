import { useEffect, useState } from "react";
import { Icon } from "../Icon.js";
import { formatContext } from "../ModelPicker.js";
import { PageHeader, Toggle } from "./controls.js";
import type { ModelInfo, ProviderInfo, ProviderModel, ProviderPatch, ProviderTestResult } from "../../../shared/types.js";

interface Props {
  providers: ProviderInfo[];
  /** Live models for the primary provider (from /v1/models). */
  liveModels: ModelInfo[];
  busy: boolean;
  onConnect: () => void;
  onProvidersChanged: (providers: ProviderInfo[]) => void;
}

export function ModelSettingsPage(props: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(props.providers[0]?.id ?? null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");

  useEffect(() => {
    if (!selectedId && props.providers[0]) setSelectedId(props.providers[0].id);
  }, [props.providers, selectedId]);

  const selected = props.providers.find((p) => p.id === selectedId) ?? props.providers[0] ?? null;
  const primaries = props.providers.filter((p) => p.kind === "primary");
  const customs = props.providers.filter((p) => p.kind === "custom");

  const submitAdd = async () => {
    if (!newName.trim() || !newUrl.trim()) return;
    const next = await window.deyin.providers.add({ name: newName.trim(), baseUrl: newUrl.trim() });
    props.onProvidersChanged(next);
    setAdding(false);
    setNewName("");
    setNewUrl("");
  };

  return (
    <div className="settings-page settings-page--wide">
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
          {adding ? (
            <div className="providers__add-form">
              <input className="input" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <input
                className="input"
                placeholder="Base URL (/v1)"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
              />
              <div className="providers__add-actions">
                <button className="chip chip--small" onClick={() => setAdding(false)}>Cancel</button>
                <button className="chip chip--small chip--active" onClick={() => void submitAdd()}>Add</button>
              </div>
            </div>
          ) : (
            <button className="providers__add" onClick={() => setAdding(true)}>
              <Icon name="plus" size={13} />
              Add provider
            </button>
          )}
        </div>

        {selected && (
          <ProviderDetail
            key={selected.id}
            provider={selected}
            liveModels={props.liveModels}
            busy={props.busy}
            onConnect={props.onConnect}
            onProvidersChanged={props.onProvidersChanged}
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
      <span className={`provider-row__status ${provider.status === "connected" ? "provider-row__status--on" : ""}`} />
    </button>
  );
}

/* Detail editor --------------------------------------------------------------- */

interface DetailProps {
  provider: ProviderInfo;
  liveModels: ModelInfo[];
  busy: boolean;
  onConnect: () => void;
  onProvidersChanged: (providers: ProviderInfo[]) => void;
}

function ProviderDetail({ provider, liveModels, busy, onConnect, onProvidersChanged }: DetailProps) {
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

  /** Pull the live /models catalog from the provider and persist it. */
  const fetchModels = async () => {
    setFetchingModels(true);
    setFetchMessage(null);
    try {
      const res = await window.deyin.providers.fetchModels(provider.id);
      if (res.ok) {
        onProvidersChanged(await window.deyin.providers.list());
        setFetchMessage(
          res.modelCount ? `Loaded ${res.modelCount} models from the provider.` : "The provider returned no models.",
        );
      } else {
        setFetchMessage(`Fetch failed: ${res.message ?? `HTTP ${res.status}`}`);
      }
    } finally {
      setFetchingModels(false);
    }
  };

  const shownModels: ProviderModel[] = isCustom
    ? provider.models
    : liveModels.map((m) => ({ id: m.id, name: m.name, contextLength: m.contextLength }));

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
        {provider.kind === "primary" && (
          <>
            <span className="hint">Connection mode</span>
            <select
              className="select select--small"
              value={provider.activeMode}
              onChange={(e) => void apply({ activeMode: e.target.value })}
            >
              {provider.connectionModes.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </>
        )}
        {isCustom && (
          <button className="icon-btn icon-btn--small" title="Delete provider" onClick={() => void removeProvider()}>
            <Icon name="trash" size={13} />
          </button>
        )}
      </div>

      {provider.kind === "primary" && (
        <div className="plan-connect">
          <div className="plan-connect__meta">
            <span className="plan-connect__title">Coding plan</span>
            <span className="hint">{provider.status === "connected" ? "Connected" : "Not connected"}</span>
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
        </select>
      </div>

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
          {isCustom && (
            <>
              {addingModel ? (
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
                    {fetchingModels ? "Fetching..." : "Fetch models"}
                  </button>
                  <button className="providers__add" onClick={() => setAddingModel(true)}>
                    <Icon name="plus" size={13} />
                    Add model
                  </button>
                </div>
              )}
              {fetchMessage && (
                <div className={fetchMessage.startsWith("Fetch failed") ? "hint hint--bad" : "hint hint--ok"}>
                  {fetchMessage}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
