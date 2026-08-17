import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../Icon.js";
import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";
import type { KernelPluginStatus, PluginCatalogEntry, PluginInfo } from "@deyin/contract";

const CATEGORIES = ["All", "Productivity", "Security", "Engineering"] as const;

/**
 * Plugins: bundles of skills/commands/subagents/MCP servers/hooks installed
 * from GitHub or shipped as bundled first-party plugins.
 */
export function PluginsPage({ onToggle }: { onToggle: (id: string, enabled: boolean) => void }) {
  const [installed, setInstalled] = useState<PluginInfo[]>([]);
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("All");
  const [kernel, setKernel] = useState<KernelPluginStatus[]>([]);

  const reload = useCallback(() => {
    void window.deyin.plugins.list().then(setInstalled).catch(() => setInstalled([]));
    void window.deyin.plugins.catalog().then(setCatalog).catch(() => setCatalog([]));
    void window.deyin.plugins.kernelStatus().then(setKernel).catch(() => setKernel([]));
  }, []);

  useEffect(() => reload(), [reload]);

  const install = async (repo: string) => {
    setBusy(repo);
    setMessage(null);
    try {
      const result = await window.deyin.plugins.install(repo);
      setMessage(result.ok ? `Installed ${result.plugin?.name ?? repo}.` : `Install failed: ${result.message}`);
      if (result.ok) {
        setSource("");
        reload();
      }
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (name: string) => {
    await window.deyin.plugins.uninstall(name);
    reload();
  };

  const toggle = (plugin: PluginInfo, enabled: boolean) => {
    onToggle(`plugin:${plugin.name}`, enabled);
    setInstalled((cur) => cur.map((p) => (p.name === plugin.name ? { ...p, enabled } : p)));
  };

  const installedNames = new Set(installed.map((p) => p.name));
  const filtered = useMemo(() => {
    if (category === "All") return installed;
    return installed.filter((p) => p.interface?.category === category);
  }, [installed, category]);

  return (
    <div className="settings-page">
      <PageHeader
        title="Plugins"
        description="First-party bundled plugins and community packs from GitHub. Each plugin contributes skills, MCP servers, and host tools."
      >
        <button className="icon-btn" title="Refresh" onClick={reload}>
          <Icon name="refresh" size={14} />
        </button>
      </PageHeader>

      <div className="plugin-filters">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            className={`chip chip--small${category === c ? " chip--active" : ""}`}
            onClick={() => setCategory(c)}
          >
            {c}
          </button>
        ))}
      </div>

      <SectionTitle>Kernel plugins</SectionTitle>
      <p className="settings-page__desc" style={{ margin: "0 0 12px" }}>
        Capability plugins composed by the kernel (bundle:base + desktop profile). A failed plugin is isolated — the rest keep running.
      </p>
      <div className="plugin-grid">
        {kernel.map((plugin) => (
          <div key={plugin.name} className="setting-card">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className={`chip chip--small${plugin.state === "active" ? " chip--active" : ""}`} title={plugin.source ?? ""}>
                {plugin.state}
              </span>
              <strong style={{ fontSize: 13 }}>{plugin.name}</strong>
            </div>
            {plugin.error && <div className="hint hint--bad" style={{ marginTop: 6 }}>{plugin.error}</div>}
          </div>
        ))}
      </div>
      {kernel.length === 0 && <div className="hint">Kernel has not started yet.</div>}

      <SectionTitle>Installed</SectionTitle>
      <div className="plugin-grid">
        {filtered.map((plugin) => (
          <PluginCard
            key={plugin.name}
            plugin={plugin}
            onToggle={(v) => toggle(plugin, v)}
            onUninstall={() => void uninstall(plugin.name)}
          />
        ))}
      </div>
      {filtered.length === 0 && <div className="hint">No plugins in this category.</div>}

      {installed.some((p) => p.variables && p.variables.length > 0) && (
        <>
          <SectionTitle>Plugin secrets</SectionTitle>
          {installed
            .filter((p) => p.variables && p.variables.length > 0)
            .map((plugin) => (
              <div key={`vars-${plugin.name}`}>
                <div className="plugin-vars__heading">{plugin.interface?.displayName ?? plugin.name}</div>
                <PluginVariables plugin={plugin.name} names={plugin.variables!} />
              </div>
            ))}
        </>
      )}

      <SectionTitle>Install from GitHub</SectionTitle>
      <div className="field__row" style={{ marginBottom: 12 }}>
        <input
          className="input"
          placeholder="owner/repo, owner/repo@ref or a github.com URL"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && source.trim()) void install(source.trim());
          }}
        />
        <button
          className="btn btn--outline"
          disabled={!source.trim() || busy !== null}
          onClick={() => void install(source.trim())}
        >
          {busy === source.trim() ? "Installing…" : "Install"}
        </button>
      </div>
      {message && <div className={message.startsWith("Install failed") ? "hint hint--bad" : "hint hint--ok"}>{message}</div>}

      <SectionTitle>Catalog</SectionTitle>
      <p className="settings-page__desc" style={{ margin: "0 0 12px" }}>
        Curated by the official registry (DeYinAI/registry on GitHub).
      </p>
      {catalog.map((entry) => (
        <SettingCard key={entry.repo} title={entry.name} description={`${entry.description} — ${entry.repo}`}>
          {installedNames.has(entry.name) ? (
            <span className="badge badge--ok">Installed</span>
          ) : (
            <button className="btn btn--outline" disabled={busy !== null} onClick={() => void install(entry.repo)}>
              {busy === entry.repo ? "Installing…" : "Install"}
            </button>
          )}
        </SettingCard>
      ))}
      {catalog.length === 0 && <div className="hint">Catalog unavailable (offline?). Install from a GitHub URL above.</div>}
    </div>
  );
}

function PluginCard({
  plugin,
  onToggle,
  onUninstall,
}: {
  plugin: PluginInfo;
  onToggle: (enabled: boolean) => void;
  onUninstall: () => void;
}) {
  const ui = plugin.interface;
  const color = ui?.brandColor ?? "var(--accent)";
  const caps = ui?.capabilities?.join(" · ") ?? componentSummary(plugin);

  return (
    <div className="plugin-card">
      <div className="plugin-card__accent" style={{ background: color }} />
      <div className="plugin-card__body">
        <div className="plugin-card__header">
          <div>
            <div className="plugin-card__title">{ui?.displayName ?? plugin.name}</div>
            <div className="plugin-card__meta">
              {plugin.bundled && <span className="badge">Bundled</span>}
              {plugin.version && <span>v{plugin.version}</span>}
              {plugin.platform === "windows" && <span className="badge">Windows</span>}
            </div>
          </div>
          <Toggle checked={plugin.enabled} onChange={onToggle} />
        </div>
        <p className="plugin-card__desc">{ui?.shortDescription ?? plugin.description ?? "No description."}</p>
        <div className="plugin-card__footer">
          <span className="plugin-card__caps">{caps}</span>
          {!plugin.bundled && (
            <button className="icon-btn icon-btn--small" title="Uninstall" onClick={onUninstall}>
              <Icon name="trash" size={12} />
            </button>
          )}
        </div>
        {ui?.defaultPrompt && ui.defaultPrompt.length > 0 && (
          <div className="plugin-card__prompts">
            {ui.defaultPrompt.slice(0, 2).map((p) => (
              <span key={p} className="chip chip--small">
                {p}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function componentSummary(plugin: PluginInfo): string {
  const c = plugin.components;
  const parts = [
    c.skills > 0 ? `${c.skills} skills` : null,
    c.commands > 0 ? `${c.commands} commands` : null,
    c.subagents > 0 ? `${c.subagents} subagents` : null,
    c.mcpServers > 0 ? `${c.mcpServers} MCP` : null,
    c.hooks > 0 ? `${c.hooks} hooks` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "no components";
}

/** Secret variables a plugin declares; values are stored encrypted, write-only. */
function PluginVariables({ plugin, names }: { plugin: string; names: string[] }) {
  const [state, setState] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    void window.deyin.plugins.variableState(plugin, names).then(setState).catch(() => setState({}));
  }, [plugin, names]);

  const save = async (name: string) => {
    const value = drafts[name] ?? "";
    await window.deyin.plugins.setVariable(plugin, name, value);
    setState((cur) => ({ ...cur, [name]: value.length > 0 }));
    setDrafts((cur) => ({ ...cur, [name]: "" }));
  };

  return (
    <div className="plugin-vars">
      {names.map((name) => (
        <div className="field__row" key={name} style={{ marginBottom: 6 }}>
          <code className="plugin-vars__name">{name}</code>
          <input
            className="input"
            type="password"
            placeholder={state[name] ? "•••••••• (set)" : "value"}
            value={drafts[name] ?? ""}
            onChange={(e) => setDrafts((cur) => ({ ...cur, [name]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save(name);
            }}
          />
          <button className="chip chip--small" onClick={() => void save(name)}>
            Save
          </button>
        </div>
      ))}
    </div>
  );
}
