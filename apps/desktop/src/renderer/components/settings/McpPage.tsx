import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../Icon.js";
import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";
import type {
  McpAuthMode,
  McpAuthStatus,
  McpCatalogCategory,
  McpCatalogEntry,
  McpModuleManifest,
  McpServerEntry,
  McpTestResult,
  McpTransport,
} from "../../../shared/types.js";

const CATEGORY_LABELS: Record<McpCatalogCategory, string> = {
  "cloud-infra": "Cloud & infra",
  database: "Database",
  payments: "Payments",
  devtools: "Dev tools",
  "project-mgmt": "Project management",
  monitoring: "Monitoring",
  communication: "Communication",
  design: "Design",
  local: "Local",
};

const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS) as McpCatalogCategory[];

/**
 * MCP servers from workspace config, per-module installs (~/.deyin/mcp-modules/<id>/),
 * plugins, and built-in in-process servers.
 */
export function McpPage({ onToggle }: { onToggle: (id: string, enabled: boolean) => void }) {
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [modules, setModules] = useState<McpModuleManifest[]>([]);
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [category, setCategory] = useState<McpCatalogCategory | "all" | "featured">("featured");
  const [adding, setAdding] = useState(false);
  const [installEntry, setInstallEntry] = useState<McpCatalogEntry | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<Record<string, McpAuthStatus>>({});
  const [authBusy, setAuthBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, McpTestResult | "running">>({});

  const reload = useCallback(() => {
    void window.deyin.mcp.list().then(setServers).catch(() => setServers([]));
    void window.deyin.mcp.modules.list().then(setModules).catch(() => setModules([]));
    void window.deyin.mcp.catalog.list().then(setCatalog).catch(() => setCatalog([]));
    void window.deyin.mcp.auth.status().then(setAuthStatus).catch(() => setAuthStatus({}));
  }, []);

  useEffect(() => reload(), [reload]);

  const installedNames = useMemo(() => new Set(servers.map((s) => s.name)), [servers]);
  const moduleById = useMemo(() => new Map(modules.map((m) => [m.id, m])), [modules]);

  const filteredCatalog = useMemo(() => {
    if (category === "featured") return catalog.filter((e) => e.featured);
    if (category === "all") return catalog;
    return catalog.filter((e) => e.category === category);
  }, [catalog, category]);

  const test = async (name: string) => {
    setTests((cur) => ({ ...cur, [name]: "running" }));
    const result = await window.deyin.mcp.test(name);
    setTests((cur) => ({ ...cur, [name]: result }));
  };

  const uninstall = async (server: McpServerEntry) => {
    if (server.source.startsWith("module:")) {
      setServers(await window.deyin.mcp.modules.uninstall(server.name));
    } else {
      setServers(await window.deyin.mcp.remove(server.name));
    }
    reload();
  };

  const toggle = (server: McpServerEntry, enabled: boolean) => {
    onToggle(server.id, enabled);
    setServers((cur) => cur.map((s) => (s.id === server.id ? { ...s, enabled } : s)));
  };

  const installCatalogEntry = async (entry: McpCatalogEntry) => {
    if (entry.auth === "none" && !(entry.secrets?.length)) {
      setInstallingId(entry.id);
      try {
        const next = await window.deyin.mcp.catalog.install({ entryId: entry.id });
        setServers(next);
        void window.deyin.mcp.test(entry.id).catch(() => undefined);
        reload();
      } finally {
        setInstallingId(null);
      }
      return;
    }
    if (entry.auth === "oauth") {
      setInstallingId(entry.id);
      try {
        const next = await window.deyin.mcp.catalog.install({ entryId: entry.id, useOAuth: true });
        setServers(next);
        reload();
      } finally {
        setInstallingId(null);
      }
      return;
    }
    setInstallEntry(entry);
  };

  const authenticate = async (moduleId: string) => {
    setAuthBusy(moduleId);
    try {
      const result = await window.deyin.mcp.authenticate(moduleId);
      if (result.ok) {
        void window.deyin.mcp.test(moduleId).catch(() => undefined);
      }
      reload();
    } finally {
      setAuthBusy(null);
    }
  };

  const revokeAuth = async (moduleId: string) => {
    await window.deyin.mcp.auth.revoke(moduleId);
    reload();
  };

  const moduleNeedsOAuth = (mod: McpModuleManifest | undefined): boolean =>
    mod?.authMode === "oauth" || Boolean(mod?.usesNativeOAuth);

  return (
    <div className="settings-page">
      <PageHeader
        title="MCP Servers"
        description="Model Context Protocol servers exposing external tools to agent sessions. Installed modules live in ~/.deyin/mcp-modules/<id>/."
      >
        <button className="icon-btn" title="Reload" onClick={reload}>
          <Icon name="refresh" size={14} />
        </button>
      </PageHeader>

      <SectionTitle>Installed</SectionTitle>
      {servers.map((server) => {
        const result = tests[server.name];
        const mod = moduleById.get(server.name);
        const removable = server.source.startsWith("module:") || server.source === "user";
        const location =
          server.source.startsWith("module:") ? `~/.deyin/mcp-modules/${server.name}/` : server.path ?? server.source;
        const needsOAuth = moduleNeedsOAuth(mod);
        const status = authStatus[server.name];
        return (
          <SettingCard
            key={server.id}
            title={`${mod?.name ?? server.name}${server.transport !== "stdio" ? ` · ${server.transport.toUpperCase()}` : ""}`}
            description={
              (server.transport === "stdio"
                ? server.command
                  ? `${server.command} ${(server.args ?? []).join(" ")}`
                  : "Built-in (runs inside Deyin)."
                : server.url ?? "") +
              ` — ${mod?.vendor ? `${mod.vendor} · ` : ""}${location}`
            }
          >
            <div className="field__row">
              {needsOAuth && status === "authenticated" && <span className="badge badge--ok">Connected</span>}
              {needsOAuth && status === "none" && <span className="badge">Not authenticated</span>}
              {needsOAuth && status === "expired" && <span className="badge">Session expired</span>}
              {result && result !== "running" && (
                <span className={result.ok ? "hint hint--ok" : "hint hint--bad"}>
                  {result.ok ? `${result.toolCount ?? 0} tools` : result.message ?? "failed"}
                </span>
              )}
              {needsOAuth && status !== "authenticated" && (
                <button
                  className="chip chip--small chip--active"
                  disabled={authBusy === server.name}
                  onClick={() => void authenticate(server.name)}
                >
                  {authBusy === server.name ? "Opening browser…" : "Authenticate"}
                </button>
              )}
              {needsOAuth && status === "authenticated" && (
                <button className="chip chip--small" onClick={() => void revokeAuth(server.name)}>
                  Disconnect
                </button>
              )}
              <button
                className="chip chip--small"
                disabled={result === "running"}
                onClick={() => void test(server.name)}
              >
                {result === "running" ? "Testing…" : "Test"}
              </button>
              {removable && (
                <button className="icon-btn icon-btn--small" title="Uninstall" onClick={() => void uninstall(server)}>
                  <Icon name="trash" size={12} />
                </button>
              )}
              <Toggle checked={server.enabled} onChange={(v) => toggle(server, v)} />
            </div>
          </SettingCard>
        );
      })}
      {servers.length === 0 && <div className="hint">No MCP servers configured.</div>}

      <SectionTitle>Browse catalog</SectionTitle>
      <p className="settings-page__desc" style={{ margin: "0 0 12px" }}>
        One-click install for popular MCP servers into <code>~/.deyin/mcp-modules/</code>. OAuth vendors open your
        browser to sign in; tokens are stored encrypted on this device.
      </p>
      <div className="mcp-catalog__filters">
        <button
          className={`chip chip--small${category === "featured" ? " chip--active" : ""}`}
          onClick={() => setCategory("featured")}
        >
          Featured
        </button>
        <button
          className={`chip chip--small${category === "all" ? " chip--active" : ""}`}
          onClick={() => setCategory("all")}
        >
          All
        </button>
        {ALL_CATEGORIES.map((cat) => (
          <button
            key={cat}
            className={`chip chip--small${category === cat ? " chip--active" : ""}`}
            onClick={() => setCategory(cat)}
          >
            {CATEGORY_LABELS[cat]}
          </button>
        ))}
      </div>
      {filteredCatalog.map((entry) => (
        <SettingCard
          key={entry.id}
          title={`${entry.name} · ${entry.vendor}`}
          description={`${entry.description} — ${CATEGORY_LABELS[entry.category]} · ${authLabel(entry.auth)}`}
        >
          <div className="field__row">
            {installedNames.has(entry.id) ? (
              <span className="badge badge--ok">Installed</span>
            ) : (
              <>
                <button
                  className="btn btn--outline"
                  disabled={installingId !== null}
                  onClick={() => void installCatalogEntry(entry)}
                >
                  {installingId === entry.id ? "Installing…" : "Install"}
                </button>
                <a className="hint" href={entry.docsUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                  Docs
                </a>
              </>
            )}
          </div>
        </SettingCard>
      ))}
      {filteredCatalog.length === 0 && <div className="hint">No catalog entries in this filter.</div>}

      <SectionTitle>Custom server</SectionTitle>
      {adding ? (
        <AddServerForm
          onDone={(next) => {
            setAdding(false);
            if (next) {
              setServers(next);
              reload();
            }
          }}
        />
      ) : (
        <button className="providers__add" onClick={() => setAdding(true)}>
          <Icon name="plus" size={13} />
          Add custom MCP server
        </button>
      )}

      {installEntry && (
        <CatalogInstallDialog
          entry={installEntry}
          onClose={() => setInstallEntry(null)}
          onInstalled={(next) => {
            setInstallEntry(null);
            setServers(next);
            reload();
          }}
        />
      )}
    </div>
  );
}

function authLabel(auth: McpAuthMode): string {
  switch (auth) {
    case "none":
      return "No auth";
    case "token":
      return "API token";
    case "oauth":
      return "OAuth";
    case "token-or-oauth":
      return "Token or OAuth";
  }
}

function CatalogInstallDialog({
  entry,
  onClose,
  onInstalled,
}: {
  entry: McpCatalogEntry;
  onClose: () => void;
  onInstalled: (servers: McpServerEntry[]) => void;
}) {
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [useOAuth, setUseOAuth] = useState(
    entry.auth === "oauth" || (entry.auth === "token-or-oauth" && !entry.secrets?.some((s) => s.required)),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canUseToken = entry.auth === "token" || entry.auth === "token-or-oauth";
  const canUseOAuth = entry.auth === "oauth" || entry.auth === "token-or-oauth";

  const install = async () => {
    setError(null);
    setBusy(true);
    try {
      const next = await window.deyin.mcp.catalog.install({
        entryId: entry.id,
        secrets: Object.keys(secrets).length > 0 ? secrets : undefined,
        useOAuth: useOAuth && canUseOAuth,
      });
      onInstalled(next);
      if (!useOAuth) void window.deyin.mcp.test(entry.id).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="goal-modal-backdrop" onClick={onClose}>
      <div className="goal-modal mcp-install-dialog" role="dialog" aria-label={`Install ${entry.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="goal-modal__title">Install {entry.name}</div>
        <p className="hint" style={{ margin: "0 0 12px" }}>
          {entry.description}
        </p>
        <p className="hint" style={{ margin: "0 0 12px" }}>
          Installs to <code>~/.deyin/mcp-modules/{entry.id}/</code>
        </p>

        {canUseOAuth && canUseToken && (
          <div className="field" style={{ marginBottom: 12 }}>
            <label className="field__label">Authentication</label>
            <label className="mcp-install-dialog__radio">
              <input type="radio" checked={useOAuth} onChange={() => setUseOAuth(true)} />
              Sign in with OAuth (recommended)
            </label>
            <label className="mcp-install-dialog__radio">
              <input type="radio" checked={!useOAuth} onChange={() => setUseOAuth(false)} />
              API token / PAT (stored in module mcp.json env)
            </label>
            {useOAuth && (
              <div className="hint">After install, click Authenticate to open your browser and approve access.</div>
            )}
          </div>
        )}

        {!useOAuth &&
          (entry.secrets ?? []).map((spec) => (
            <div className="field" key={spec.envKey}>
              <label className="field__label">
                {spec.label}
                {!spec.required && " (optional)"}
              </label>
              <input
                className="input"
                type="password"
                value={secrets[spec.envKey] ?? ""}
                onChange={(e) => setSecrets((cur) => ({ ...cur, [spec.envKey]: e.target.value }))}
              />
            </div>
          ))}

        {error && <div className="hint hint--bad">{error}</div>}
        <div className="goal-modal__actions">
          <button className="chip chip--small" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="chip chip--small chip--active" onClick={() => void install()} disabled={busy}>
            {busy ? "Installing…" : "Install"}
          </button>
        </div>
      </div>
    </div>
  );
}

function KeyValueEditor({
  label,
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  label: string;
  rows: Array<{ key: string; value: string }>;
  onChange: (rows: Array<{ key: string; value: string }>) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  const update = (index: number, field: "key" | "value", value: string) => {
    const next = rows.map((row, i) => (i === index ? { ...row, [field]: value } : row));
    onChange(next);
  };

  const addRow = () => onChange([...rows, { key: "", value: "" }]);
  const removeRow = (index: number) => onChange(rows.filter((_, i) => i !== index));

  return (
    <div className="field">
      <label className="field__label">{label}</label>
      {rows.map((row, index) => (
        <div className="field__row" key={index} style={{ marginBottom: 6 }}>
          <input
            className="input"
            placeholder={keyPlaceholder}
            value={row.key}
            onChange={(e) => update(index, "key", e.target.value)}
          />
          <input
            className="input"
            placeholder={valuePlaceholder}
            value={row.value}
            onChange={(e) => update(index, "value", e.target.value)}
          />
          <button type="button" className="icon-btn icon-btn--small" title="Remove" onClick={() => removeRow(index)}>
            <Icon name="trash" size={12} />
          </button>
        </div>
      ))}
      <button type="button" className="chip chip--small" onClick={addRow}>
        Add row
      </button>
    </div>
  );
}

function rowsToRecord(rows: Array<{ key: string; value: string }>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) out[key] = row.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function AddServerForm({ onDone }: { onDone: (servers: McpServerEntry[] | null) => void }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [envRows, setEnvRows] = useState([{ key: "", value: "" }]);
  const [headerRows, setHeaderRows] = useState([{ key: "", value: "" }]);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      const [cmd, ...args] = command.trim().split(/\s+/);
      const next = await window.deyin.mcp.add({
        name: name.trim(),
        transport,
        command: transport === "stdio" ? cmd : undefined,
        args: transport === "stdio" && args.length > 0 ? args : undefined,
        url: transport !== "stdio" ? url.trim() : undefined,
        env: rowsToRecord(envRows),
        headers: transport !== "stdio" ? rowsToRecord(headerRows) : undefined,
      });
      onDone(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mcp-add">
      <div className="field">
        <label className="field__label">Name</label>
        <input className="input" placeholder="my-server" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label className="field__label">Transport</label>
        <select className="select" style={{ width: "100%" }} value={transport} onChange={(e) => setTransport(e.target.value as McpTransport)}>
          <option value="stdio">stdio (local command)</option>
          <option value="sse">SSE (remote URL)</option>
          <option value="http">Streamable HTTP (remote URL)</option>
        </select>
      </div>
      {transport === "stdio" ? (
        <div className="field">
          <label className="field__label">Command</label>
          <input
            className="input"
            placeholder="npx -y @modelcontextprotocol/server-filesystem ${workspaceFolder}"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <div className="hint">Creates ~/.deyin/mcp-modules/&lt;name&gt;/ with module.json + mcp.json.</div>
        </div>
      ) : (
        <div className="field">
          <label className="field__label">URL</label>
          <input className="input" placeholder="https://mcp.example.com/sse" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
      )}
      <KeyValueEditor
        label="Environment variables"
        rows={envRows}
        onChange={setEnvRows}
        keyPlaceholder="STRIPE_SECRET_KEY"
        valuePlaceholder="${env:VALUE} or literal"
      />
      {transport !== "stdio" && (
        <KeyValueEditor
          label="HTTP headers"
          rows={headerRows}
          onChange={setHeaderRows}
          keyPlaceholder="Authorization"
          valuePlaceholder="Bearer ${env:TOKEN}"
        />
      )}
      {error && <div className="hint hint--bad">{error}</div>}
      <div className="providers__add-actions">
        <button className="chip chip--small" onClick={() => onDone(null)}>Cancel</button>
        <button className="chip chip--small chip--active" onClick={() => void submit()}>Add server</button>
      </div>
    </div>
  );
}
