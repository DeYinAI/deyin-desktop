import { useCallback, useEffect, useState } from "react";
import { Icon } from "../Icon.js";
import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";
import type { PluginCatalogEntry, PluginInfo } from "../../../shared/types.js";

/**
 * Plugins: bundles of skills/commands/subagents/MCP servers/hooks installed
 * from GitHub into the user's plugin directory. The catalog comes from the
 * official DeYinAI/registry repo; any GitHub repo can be installed by URL.
 */
export function PluginsPage({ onToggle }: { onToggle: (id: string, enabled: boolean) => void }) {
  const [installed, setInstalled] = useState<PluginInfo[]>([]);
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(() => {
    void window.deyin.plugins.list().then(setInstalled).catch(() => setInstalled([]));
    void window.deyin.plugins.catalog().then(setCatalog).catch(() => setCatalog([]));
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

  return (
    <div className="settings-page">
      <PageHeader
        title="Plugins"
        description="Bundles of skills, commands, subagents, MCP servers and hooks. Installed from GitHub into your plugin library."
      >
        <button className="icon-btn" title="Refresh" onClick={reload}>
          <Icon name="refresh" size={14} />
        </button>
      </PageHeader>

      <SectionTitle>Installed</SectionTitle>
      {installed.map((plugin) => (
        <div key={plugin.name}>
          <SettingCard
            title={plugin.name + (plugin.version ? ` · v${plugin.version}` : "")}
            description={`${plugin.description ?? "No description."} — ${plugin.source} · ${componentSummary(plugin)}`}
          >
            <div className="field__row">
              <button className="icon-btn icon-btn--small" title="Uninstall" onClick={() => void uninstall(plugin.name)}>
                <Icon name="trash" size={12} />
              </button>
              <Toggle checked={plugin.enabled} onChange={(v) => toggle(plugin, v)} />
            </div>
          </SettingCard>
          {plugin.variables && plugin.variables.length > 0 && (
            <PluginVariables plugin={plugin.name} names={plugin.variables} />
          )}
        </div>
      ))}
      {installed.length === 0 && <div className="hint">No plugins installed yet.</div>}

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

function componentSummary(plugin: PluginInfo): string {
  const c = plugin.components;
  const parts = [
    c.skills > 0 ? `${c.skills} skills` : null,
    c.commands > 0 ? `${c.commands} commands` : null,
    c.subagents > 0 ? `${c.subagents} subagents` : null,
    c.mcpServers > 0 ? `${c.mcpServers} MCP` : null,
    c.hooks > 0 ? `${c.hooks} hooks` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "no components detected";
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
