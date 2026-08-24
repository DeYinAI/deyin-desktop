import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon } from "../Icon.js";
import {
  EmptyState,
  IconTile,
  PageHeader,
  Row,
  RowList,
  RowMenu,
  SearchField,
  SectionHeader,
  Segmented,
  Tag,
} from "./controls.js";
import type { KernelPluginStatus, PluginCatalogEntry, PluginInfo } from "@deyin/contract";

type Scope = "public" | "personal";

/** Catalog grouping: a plugin's declared category, falling back to "Other". */
const CATEGORY_ORDER = ["Developer Tools", "Productivity", "Security", "Engineering", "Guides", "Other", "Community catalog"];

/**
 * Plugins: bundles of skills/commands/subagents/MCP servers/hooks installed
 * from GitHub or shipped as bundled first-party plugins.
 */
export function PluginsPage({ onToggle, tabs }: { onToggle: (id: string, enabled: boolean) => void; tabs?: ReactNode }) {
  const [installed, setInstalled] = useState<PluginInfo[]>([]);
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]);
  const [kernel, setKernel] = useState<KernelPluginStatus[]>([]);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("public");
  const [source, setSource] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [secretsFor, setSecretsFor] = useState<string | null>(null);
  const [showKernel, setShowKernel] = useState(false);

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
        setAdding(false);
        if (result.plugin?.variables && result.plugin.variables.length > 0) {
          setSecretsFor(result.plugin.name);
        }
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

  const installedNames = useMemo(() => new Set(installed.map((p) => p.name)), [installed]);
  const match = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase());

  /** Public = the curated catalog + bundled first-party; Personal = your own installs. */
  const listed = useMemo(() => {
    const entries: ListEntry[] = [];
    for (const plugin of installed) {
      if (scope === "public" ? !plugin.bundled : plugin.bundled) continue;
      entries.push({
        key: `installed:${plugin.name}`,
        name: plugin.interface?.displayName ?? plugin.name,
        description: plugin.interface?.shortDescription ?? plugin.description ?? componentSummary(plugin),
        category: plugin.interface?.category ?? "Other",
        color: plugin.interface?.brandColor,
        plugin,
      });
    }
    if (scope === "public") {
      for (const entry of catalog) {
        if (installedNames.has(entry.name)) continue;
        entries.push({
          key: `catalog:${entry.repo}`,
          name: entry.interface?.displayName ?? entry.name,
          description: entry.description,
          category: entry.interface?.category ?? "Community catalog",
          color: entry.interface?.brandColor,
          repo: entry.repo,
        });
      }
    }
    return entries.filter((e) => !query.trim() || match(e.name) || match(e.description));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installed, catalog, installedNames, scope, query]);

  const groups = useMemo(() => {
    const map = new Map<string, ListEntry[]>();
    for (const entry of listed) {
      const list = map.get(entry.category) ?? [];
      list.push(entry);
      map.set(entry.category, list);
    }
    return [...map.entries()].sort(
      (a, b) => categoryRank(a[0]) - categoryRank(b[0]) || a[0].localeCompare(b[0]),
    );
  }, [listed]);

  const secretPlugin = installed.find((p) => p.name === secretsFor);
  const failedKernel = kernel.filter((p) => p.state !== "active").length;

  return (
    <div className="settings-page">
      <PageHeader
        title="Plugins"
        description="Extend Deyin with skills, commands, subagents and MCP servers from plugins."
      >
        <button className="icon-btn" title="Refresh" onClick={reload}>
          <Icon name="refresh" size={14} />
        </button>
        <button
          className={`icon-btn${showKernel ? " icon-btn--active" : ""}`}
          title="Kernel plugin status"
          onClick={() => setShowKernel((v) => !v)}
        >
          <Icon name="gear" size={14} />
        </button>
        <button className="btn btn--outline btn--small" onClick={() => setAdding((v) => !v)}>
          <Icon name="plus" size={12} />
          Install
          <Icon name="chevronDown" size={11} />
        </button>
      </PageHeader>

      {tabs}

      {adding && (
        <div className="inline-form">
          <input
            className="input"
            autoFocus
            placeholder="owner/repo, owner/repo@ref or a github.com URL"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && source.trim()) void install(source.trim());
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <button
            className="btn btn--primary btn--small"
            disabled={!source.trim() || busy !== null}
            onClick={() => void install(source.trim())}
          >
            {busy === source.trim() ? "Installing…" : "Install"}
          </button>
          <button className="btn btn--ghost btn--small" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      )}
      {message && (
        <div className={message.startsWith("Install failed") ? "hint hint--bad" : "hint hint--ok"}>{message}</div>
      )}

      <SearchField value={query} onChange={setQuery} placeholder="Search plugins" />

      {showKernel && (
        <>
          <SectionHeader
            title="Kernel plugins"
            count={kernel.length}
            note={failedKernel > 0 ? `${failedKernel} not active` : "all active"}
          />
          <RowList>
            {kernel.map((plugin) => (
              <Row
                key={plugin.name}
                icon={<IconTile name={plugin.name} id={plugin.name} icon="bolt" size="sm" />}
                title={plugin.name}
                tags={<Tag tone={plugin.state === "active" ? "ok" : "warn"}>{plugin.state}</Tag>}
                description={plugin.error ?? plugin.source ?? "Composed by the kernel."}
              />
            ))}
          </RowList>
          {kernel.length === 0 && <EmptyState icon="bolt" title="Kernel has not started yet." />}
        </>
      )}

      <SectionHeader
        title="Installed"
        count={installed.length}
        actions={
          <span className="section-head__note">
            {installed.filter((p) => p.enabled).length} enabled
          </span>
        }
      />
      <div className="tile-strip">
        {installed.map((plugin) => (
          <button
            key={plugin.name}
            className={`tile-strip__item${plugin.enabled ? "" : " tile-strip__item--off"}`}
            title={`${plugin.interface?.displayName ?? plugin.name} — ${plugin.enabled ? "enabled" : "disabled"}`}
            onClick={() => toggle(plugin, !plugin.enabled)}
          >
            <IconTile
              name={plugin.interface?.displayName ?? plugin.name}
              id={[plugin.hostModule, plugin.name]}
              color={plugin.interface?.brandColor}
              size="lg"
            />
          </button>
        ))}
        {installed.length === 0 && <span className="hint">Nothing installed yet.</span>}
      </div>

      <Segmented
        options={[
          { id: "public", label: "Public" },
          { id: "personal", label: "Personal" },
        ]}
        value={scope}
        onChange={setScope}
      />

      {groups.map(([category, entries]) => (
        <div key={category}>
          <SectionHeader title={category} count={entries.length} />
          <RowList variant="grid">
            {entries.map((entry) => (
              <Row
                key={entry.key}
                icon={<IconTile name={entry.name} id={[entry.plugin?.hostModule, entry.plugin?.name]} color={entry.color} />}
                title={entry.name}
                tags={
                  entry.plugin?.platform === "windows" ? <Tag tone="muted">Windows</Tag> : undefined
                }
                description={entry.description}
                aside={entry.plugin && !entry.plugin.enabled ? <Tag tone="muted">Off</Tag> : undefined}
                actions={
                  entry.plugin ? (
                    <>
                      <RowMenu
                        items={[
                          {
                            label: entry.plugin.enabled ? "Disable" : "Enable",
                            icon: entry.plugin.enabled ? "close" : "check",
                            onSelect: () => toggle(entry.plugin!, !entry.plugin!.enabled),
                          },
                          ...(entry.plugin.variables && entry.plugin.variables.length > 0
                            ? [
                                {
                                  label: "Configure secrets",
                                  icon: "shield" as const,
                                  onSelect: () => setSecretsFor(entry.plugin!.name),
                                },
                              ]
                            : []),
                          ...(entry.plugin.bundled
                            ? []
                            : [
                                {
                                  label: "Uninstall",
                                  icon: "trash" as const,
                                  danger: true,
                                  onSelect: () => void uninstall(entry.plugin!.name),
                                },
                              ]),
                        ]}
                      />
                    </>
                  ) : (
                    <button
                      className="btn btn--outline btn--small"
                      disabled={busy !== null}
                      onClick={() => void install(entry.repo!)}
                    >
                      {busy === entry.repo ? "Installing…" : "Install"}
                    </button>
                  )
                }
              />
            ))}
          </RowList>
        </div>
      ))}

      {groups.length === 0 && (
        <EmptyState
          icon="grid"
          title={query ? "No plugins match your search." : "Nothing here yet."}
          hint={
            scope === "personal"
              ? "Plugins you install from GitHub appear here."
              : "The catalog is unavailable offline — install from a GitHub URL instead."
          }
        />
      )}

      {secretPlugin?.variables && (
        <>
          <SectionHeader title={`${secretPlugin.interface?.displayName ?? secretPlugin.name} secrets`} />
          <PluginVariables plugin={secretPlugin.name} names={secretPlugin.variables} />
        </>
      )}
    </div>
  );
}

interface ListEntry {
  key: string;
  name: string;
  description: string;
  category: string;
  color?: string;
  /** Set for installed plugins; catalog-only entries carry `repo` instead. */
  plugin?: PluginInfo;
  repo?: string;
}

function categoryRank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(category);
  return i === -1 ? CATEGORY_ORDER.length : i;
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
  return parts.length > 0 ? parts.join(" · ") : "No components";
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
        <div className="inline-form" key={name}>
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
          <button className="btn btn--outline btn--small" onClick={() => void save(name)}>
            Save
          </button>
        </div>
      ))}
    </div>
  );
}
