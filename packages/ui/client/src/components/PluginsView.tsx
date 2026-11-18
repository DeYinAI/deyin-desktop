import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  CapabilityItem,
  CapabilityKind,
  McpServerEntry,
  McpTestResult,
  PluginCatalogEntry,
  PluginInfo,
} from "@deyin/contract";
import { AnchoredMenu } from "./AnchoredMenu.js";
import { useConfirm } from "./ConfirmDialog.js";
import { Icon, type IconName } from "./Icon.js";
import { AddServerForm } from "./settings/McpPage.js";
import { PluginVariables } from "./settings/PluginsPage.js";
import { IconTile, RowMenu, Tag, Toggle, type MenuAction } from "./settings/controls.js";

type Panel = "github" | "mcp" | { secrets: string } | null;

interface BuiltinRow {
  kind: CapabilityKind;
  title: string;
  description: string;
  icon: IconName;
}

const BUILTIN_ROWS: readonly BuiltinRow[] = [
  { kind: "skill", title: "Skills", description: "Reusable task recipes the agent reads on demand.", icon: "sparkles" },
  { kind: "subagent", title: "Subagents", description: "Pick the model each subagent delegates to.", icon: "brain" },
  { kind: "command", title: "Commands", description: "Slash commands available in the composer.", icon: "terminal" },
  { kind: "hook", title: "Hooks", description: "Scripts that run around agent lifecycle events.", icon: "bolt" },
];

interface Props {
  /** Opens Settings → Extensions on the MCP tab (catalog, OAuth, advanced editing). */
  onOpenMcpSettings: () => void;
  /** Opens Settings → Extensions on one of the skill/subagent/command/hook tabs. */
  onOpenCapabilitySettings: (kind: CapabilityKind) => void;
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

function serverMeta(server: McpServerEntry): string {
  const transport =
    server.transport !== "stdio"
      ? server.transport.toUpperCase()
      : server.source === "built-in"
        ? "In-process"
        : "Local command";
  const origin =
    server.source === "built-in"
      ? "Deyin"
      : server.source.startsWith("plugin:")
        ? `Plugin: ${server.source.slice("plugin:".length)}`
        : server.source.startsWith("module:")
          ? "Installed"
          : "Custom";
  return `${origin} · ${transport}`;
}

interface CardProps {
  icon: ReactNode;
  title: string;
  tags?: ReactNode;
  description: ReactNode;
  end?: ReactNode;
  onOpen?: () => void;
}

/** One list entry: a bordered icon tile, title with tags, a one-line description and trailing controls. */
function Card(props: CardProps) {
  const body = (
    <>
      <span className="plug-card__icon">{props.icon}</span>
      <span className="plug-card__main">
        <span className="plug-card__title-row">
          <span className="plug-card__title">{props.title}</span>
          {props.tags}
        </span>
        <span className="plug-card__desc">{props.description}</span>
      </span>
    </>
  );
  return (
    <li className="plug-card">
      {props.onOpen ? (
        <button type="button" className="plug-card__head plug-card__head--link" onClick={props.onOpen}>
          {body}
        </button>
      ) : (
        <div className="plug-card__head">{body}</div>
      )}
      {props.end && <span className="plug-card__end">{props.end}</span>}
    </li>
  );
}

function Section(props: { title: string; count?: number; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="plug-section">
      <div className="plug-section__head">
        <h2 className="plug-section__title">{props.title}</h2>
        {props.count !== undefined && <span className="plug-section__count">{props.count}</span>}
        {props.aside && <span className="plug-section__aside">{props.aside}</span>}
      </div>
      {props.children}
    </section>
  );
}

/** Plugins, MCP servers and the built-in extension points in one page. */
export function PluginsView(props: Props) {
  const { confirm } = useConfirm();
  const [installed, setInstalled] = useState<PluginInfo[]>([]);
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]);
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [caps, setCaps] = useState<CapabilityItem[]>([]);
  const [tests, setTests] = useState<Record<string, McpTestResult | "running">>({});
  const [loaded, setLoaded] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  /** Each list lands as soon as it resolves: the registry catalog is a network fetch and must not hold up the rest. */
  const reload = useCallback(async () => {
    const local = Promise.all([
      window.deyin.plugins.list().then(setInstalled, () => setInstalled([])),
      window.deyin.mcp.list().then(setServers, () => setServers([])),
      window.deyin.caps.list().then(setCaps, () => setCaps([])),
    ]).then(() => setLoaded(true));
    const remote = window.deyin.plugins.catalog().then(setCatalog, () => setCatalog([]));
    await Promise.all([local, remote]);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const installedNames = useMemo(() => new Set(installed.map((p) => p.name)), [installed]);
  const discover = useMemo(() => catalog.filter((entry) => !installedNames.has(entry.name)), [catalog, installedNames]);
  const capCounts = useMemo(() => {
    const counts: Partial<Record<CapabilityKind, { total: number; enabled: number }>> = {};
    for (const item of caps) {
      const entry = counts[item.kind] ?? { total: 0, enabled: 0 };
      entry.total += 1;
      if (item.enabled) entry.enabled += 1;
      counts[item.kind] = entry;
    }
    return counts;
  }, [caps]);

  const install = async (repo: string) => {
    setBusy(repo);
    setMessage(null);
    try {
      const result = await window.deyin.plugins.install(repo);
      if (result.ok) {
        setMessage({ tone: "ok", text: `Installed ${result.plugin?.name ?? repo}.` });
        setSource("");
        setPanel(result.plugin?.variables && result.plugin.variables.length > 0 ? { secrets: result.plugin.name } : null);
        await reload();
      } else {
        setMessage({ tone: "bad", text: `Install failed: ${result.message}` });
      }
    } catch (err) {
      setMessage({ tone: "bad", text: `Install failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(null);
    }
  };

  const togglePlugin = async (plugin: PluginInfo, enabled: boolean) => {
    setInstalled((cur) => cur.map((p) => (p.name === plugin.name ? { ...p, enabled } : p)));
    await window.deyin.caps.toggle(`plugin:${plugin.name}`, enabled);
    // Enabling a plugin can register its MCP servers, skills and commands.
    await reload();
  };

  const uninstallPlugin = async (plugin: PluginInfo) => {
    const ok = await confirm({
      title: `Uninstall ${plugin.interface?.displayName ?? plugin.name}?`,
      message: "Its skills, commands, subagents, hooks and MCP servers are removed with it.",
      confirmLabel: "Uninstall",
      destructive: true,
    });
    if (!ok) return;
    await window.deyin.plugins.uninstall(plugin.name);
    await reload();
  };

  const toggleServer = async (server: McpServerEntry, enabled: boolean) => {
    setServers((cur) => cur.map((s) => (s.id === server.id ? { ...s, enabled } : s)));
    await window.deyin.caps.toggle(server.id, enabled);
    setTests((cur) => {
      const next = { ...cur };
      delete next[server.name];
      return next;
    });
  };

  const testServer = async (server: McpServerEntry) => {
    setTests((cur) => ({ ...cur, [server.name]: "running" }));
    try {
      const result = await window.deyin.mcp.test(server.name);
      setTests((cur) => ({ ...cur, [server.name]: result }));
    } catch (err) {
      setTests((cur) => ({
        ...cur,
        [server.name]: { ok: false, message: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  const removeServer = async (server: McpServerEntry) => {
    const ok = await confirm({
      title: `Remove ${server.name}?`,
      message: "The server is removed from your MCP configuration.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setServers(
      server.source.startsWith("module:")
        ? await window.deyin.mcp.modules.uninstall(server.name)
        : await window.deyin.mcp.remove(server.name),
    );
  };

  const statusOf = (server: McpServerEntry): { label: string; tone: "muted" | "ok" | "bad" } => {
    const result = tests[server.name];
    if (!server.enabled) return { label: "Off", tone: "muted" };
    if (result === "running") return { label: "Testing…", tone: "muted" };
    if (result && !result.ok) return { label: "Failed", tone: "bad" };
    if (result?.ok) return { label: `${result.toolCount ?? 0} tools`, tone: "ok" };
    return { label: "Ready", tone: "muted" };
  };

  const secretsPlugin = typeof panel === "object" && panel ? installed.find((p) => p.name === panel.secrets) : undefined;

  return (
    <section className="plug" aria-label="Plugins">
      <div className="plug__scroll">
        <div className="plug__content">
          <header className="plug__head">
            <div className="plug__heading">
              <h1>Plugins</h1>
              <p>Install, enable, and configure plugins and MCP servers.</p>
            </div>
            <div className="plug__toolbar">
              <button type="button" className="plug__outline" onClick={() => void reload()}>
                <Icon name="refresh" size={13} />
                Refresh
              </button>
              <span className="plug__add" role="group" aria-label="Add plugin">
                <button
                  type="button"
                  className="plug__add-main"
                  onClick={() => setPanel((cur) => (cur === "github" ? null : "github"))}
                >
                  <Icon name="plus" size={13} />
                  Add plugin
                </button>
                <AnchoredMenu
                  open={addOpen}
                  onToggle={() => setAddOpen((v) => !v)}
                  onClose={() => setAddOpen(false)}
                  triggerClassName="plug__add-more"
                  triggerTitle="Choose what to add"
                  panelClassName="rule-menu"
                  trigger={<Icon name="chevronDown" size={12} />}
                >
                  <button
                    type="button"
                    className="rule-menu__item"
                    onClick={() => {
                      setAddOpen(false);
                      setPanel("github");
                    }}
                  >
                    <Icon name="download" size={14} />
                    <span className="rule-menu__text">
                      <span className="rule-menu__label">Install from GitHub</span>
                      <span className="rule-menu__hint">A plugin repository: owner/repo or a URL</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="rule-menu__item"
                    onClick={() => {
                      setAddOpen(false);
                      setPanel("mcp");
                    }}
                  >
                    <Icon name="plug" size={14} />
                    <span className="rule-menu__text">
                      <span className="rule-menu__label">Add MCP server</span>
                      <span className="rule-menu__hint">A local command or a remote URL</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="rule-menu__item"
                    onClick={() => {
                      setAddOpen(false);
                      props.onOpenMcpSettings();
                    }}
                  >
                    <Icon name="grid" size={14} />
                    <span className="rule-menu__text">
                      <span className="rule-menu__label">Browse MCP catalog</span>
                      <span className="rule-menu__hint">Ready-made servers for common services</span>
                    </span>
                  </button>
                </AnchoredMenu>
              </span>
            </div>
          </header>

          {message && (
            <p className={`plug__message plug__message--${message.tone}`} role="status">
              {message.text}
            </p>
          )}

          {panel === "github" && (
            <div className="plug-panel">
              <label className="plug-panel__label" htmlFor="plug-source">
                Plugin repository
              </label>
              <div className="plug-panel__row">
                <input
                  id="plug-source"
                  className="plug-panel__input"
                  autoFocus
                  placeholder="owner/repo, owner/repo@ref or a github.com URL"
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && source.trim() && busy === null) void install(source.trim());
                    if (event.key === "Escape") setPanel(null);
                  }}
                />
                <button
                  type="button"
                  className="btn btn--outline"
                  onClick={() => {
                    setPanel(null);
                    setSource("");
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!source.trim() || busy !== null}
                  onClick={() => void install(source.trim())}
                >
                  {busy !== null && busy === source.trim() ? "Installing…" : "Install"}
                </button>
              </div>
            </div>
          )}

          {panel === "mcp" && (
            <div className="plug-panel">
              <AddServerForm
                onDone={(next) => {
                  setPanel(null);
                  if (next) {
                    setServers(next);
                    setMessage({ tone: "ok", text: "MCP server added." });
                    void reload();
                  }
                }}
              />
            </div>
          )}

          {secretsPlugin?.variables && (
            <div className="plug-panel">
              <div className="plug-panel__label">
                {secretsPlugin.interface?.displayName ?? secretsPlugin.name} — secrets
              </div>
              <PluginVariables plugin={secretsPlugin.name} names={secretsPlugin.variables} />
              <div className="plug-panel__row plug-panel__row--end">
                <button type="button" className="btn btn--outline" onClick={() => setPanel(null)}>
                  Done
                </button>
              </div>
            </div>
          )}

          <Section title="Plugins" count={installed.length}>
            {installed.length === 0 ? (
              <p className="plug-empty">{loaded ? "No plugins installed yet. Add one from GitHub." : "Loading…"}</p>
            ) : (
              <ul className="plug-cards">
                {installed.map((plugin) => {
                  const actions: MenuAction[] = [];
                  if (plugin.variables && plugin.variables.length > 0) {
                    actions.push({
                      label: "Configure secrets",
                      icon: "shield",
                      onSelect: () => setPanel({ secrets: plugin.name }),
                    });
                  }
                  if (!plugin.bundled) {
                    actions.push({
                      label: "Uninstall",
                      icon: "trash",
                      danger: true,
                      onSelect: () => void uninstallPlugin(plugin),
                    });
                  }
                  return (
                    <Card
                      key={plugin.name}
                      icon={
                        <IconTile
                          id={[plugin.hostModule, plugin.name]}
                          size="lg"
                        />
                      }
                      title={plugin.interface?.displayName ?? plugin.name}
                      tags={
                        <>
                          {plugin.bundled && <Tag tone="muted">Built-in</Tag>}
                          {!plugin.bundled && plugin.version && <Tag tone="muted">v{plugin.version}</Tag>}
                        </>
                      }
                      description={plugin.interface?.shortDescription ?? plugin.description ?? componentSummary(plugin)}
                      end={
                        <>
                          <Toggle
                            checked={plugin.enabled}
                            label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
                            onChange={(enabled) => void togglePlugin(plugin, enabled)}
                          />
                          {actions.length > 0 ? <RowMenu items={actions} /> : <span className="plug-card__spacer" />}
                        </>
                      }
                    />
                  );
                })}
              </ul>
            )}
          </Section>

          <Section
            title="MCP servers"
            count={servers.length}
            aside={
              <button type="button" className="plug-section__link" onClick={props.onOpenMcpSettings}>
                Manage
                <Icon name="chevronRight" size={12} />
              </button>
            }
          >
            {servers.length === 0 ? (
              <p className="plug-empty">{loaded ? "No MCP servers configured." : "Loading…"}</p>
            ) : (
              <ul className="plug-cards">
                {servers.map((server) => {
                  const state = statusOf(server);
                  const result = tests[server.name];
                  const removable = server.source.startsWith("module:") || server.source === "user";
                  const actions: MenuAction[] = [
                    {
                      label: result === "running" ? "Testing…" : "Test connection",
                      icon: "play",
                      onSelect: () => void testServer(server),
                    },
                  ];
                  if (removable) {
                    actions.push({ label: "Remove", icon: "trash", danger: true, onSelect: () => void removeServer(server) });
                  }
                  return (
                    <Card
                      key={server.id}
                      icon={<IconTile id={[server.name]} icon="plug" size="lg" />}
                      title={server.name}
                      tags={<Tag tone={state.tone}>{state.label}</Tag>}
                      description={
                        result && result !== "running" && !result.ok && result.message
                          ? result.message
                          : serverMeta(server)
                      }
                      end={
                        <>
                          <Toggle
                            checked={server.enabled}
                            label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
                            onChange={(enabled) => void toggleServer(server, enabled)}
                          />
                          <RowMenu items={actions} />
                        </>
                      }
                    />
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="Extension points">
            <ul className="plug-cards">
              {BUILTIN_ROWS.map((row) => {
                const count = capCounts[row.kind];
                return (
                  <Card
                    key={row.kind}
                    icon={<IconTile id={`builtin-${row.kind}`} icon={row.icon} size="lg" />}
                    title={row.title}
                    description={
                      count ? `${row.description} ${count.enabled} of ${count.total} enabled.` : row.description
                    }
                    end={<Icon name="chevronRight" size={14} className="plug-card__arrow" />}
                    onOpen={() => props.onOpenCapabilitySettings(row.kind)}
                  />
                );
              })}
            </ul>
          </Section>

          {discover.length > 0 && (
            <Section title="Discover" count={discover.length}>
              <ul className="plug-cards">
                {discover.map((entry) => (
                  <Card
                    key={entry.repo}
                    icon={
                      <IconTile
                        id={entry.name}
                        size="lg"
                      />
                    }
                    title={entry.interface?.displayName ?? entry.name}
                    tags={entry.version ? <Tag tone="muted">v{entry.version}</Tag> : undefined}
                    description={entry.description}
                    end={
                      <button
                        type="button"
                        className="btn btn--outline"
                        disabled={busy !== null}
                        onClick={() => void install(entry.repo)}
                      >
                        {busy === entry.repo ? "Installing…" : "Install"}
                      </button>
                    }
                  />
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </section>
  );
}
