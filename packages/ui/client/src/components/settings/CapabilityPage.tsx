import { useMemo, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon.js";
import {
  EmptyState,
  IconTile,
  PageHeader,
  Row,
  RowList,
  SearchField,
  SectionHeader,
  Tag,
  Toggle,
} from "./controls.js";
import type { CapabilityItem, CapabilityKind, ModelInfo, ProviderInfo } from "@deyin/contract";

const COPY: Record<CapabilityKind, { title: string; description: string; empty: string; icon: IconName }> = {
  plugin: {
    title: "Plugins",
    description: "Extensions that add tools and integrations to agent sessions.",
    empty: "No plugins installed.",
    icon: "grid",
  },
  skill: {
    title: "Skills",
    description:
      "Reusable task recipes the agent reads on demand. Enabled skills can be referenced in chat with /skill-name.",
    empty: "No skills available. Ask the agent to /create-skill one.",
    icon: "sparkles",
  },
  subagent: {
    title: "Subagents",
    description:
      "Pick a model per subagent. The main agent delegates via the task tool; only a summary returns to chat. Effort and step caps come from the subagent definition or settings below.",
    empty: "No subagents configured.",
    icon: "brain",
  },
  mcp: {
    title: "MCP Servers",
    description: "Model Context Protocol servers exposing external tools and resources.",
    empty: "No MCP servers configured.",
    icon: "plug",
  },
  command: {
    title: "Commands",
    description:
      "Slash commands available in the composer. One markdown file per command in .deyin/commands/ or ~/.deyin/commands/; $ARGUMENTS receives the text after the command.",
    empty: "No commands defined.",
    icon: "terminal",
  },
  hook: {
    title: "Hooks",
    description:
      "Custom scripts that run around agent lifecycle events, defined in .deyin/hooks.json (workspace) or ~/.deyin/hooks.json. Exit code 2 blocks the action; hooks fail open otherwise.",
    empty: "No hooks defined. Create .deyin/hooks.json to add some.",
    icon: "bolt",
  },
};

/** Where an item came from — shown as the row's right-hand scope label. */
function scopeOf(item: CapabilityItem): string {
  const source = item.source ?? "built-in";
  if (source === "built-in") return "Built-in";
  if (source === "user") return "Personal";
  if (source === "workspace") return "Workspace";
  if (source.startsWith("plugin:")) return source.slice("plugin:".length);
  return source;
}

const SCOPE_FILTERS = ["All", "Built-in", "Personal", "Workspace", "Plugin"] as const;

interface Props {
  kind: CapabilityKind;
  items: CapabilityItem[];
  onToggle: (id: string, enabled: boolean) => void;
  /** Rendered under the page header (page group tabs). */
  tabs?: ReactNode;
  /** Subagent model picker support (enabled providers + live primary models). */
  providers?: ProviderInfo[];
  liveModels?: ModelInfo[];
  /** Saved per-subagent model overrides; drives the dropdown value (not item.model from caps). */
  subagentModels?: Record<string, string>;
  /** Saved per-subagent effort overrides (low | medium | high). */
  subagentEfforts?: Record<string, string>;
  /** Persist a per-subagent model override ("providerId::modelId", undefined = inherit). */
  onSetSubagentModel?: (name: string, model: string | undefined) => void;
  /** Persist a per-subagent effort override. */
  onSetSubagentEffort?: (name: string, effort: string | undefined) => void;
}

const EFFORT_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;

/** Flatten enabled providers' models into "providerId::modelId" options. */
function modelOptions(
  providers: ProviderInfo[] | undefined,
  liveModels: ModelInfo[] | undefined,
): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  if (!providers) return out;
  for (const p of providers.filter((p) => p.enabled)) {
    const list = p.kind === "primary" ? (liveModels ?? []) : p.models;
    const disabled = new Set(p.disabledModels);
    for (const m of list) {
      // Image models take a prompt, not a conversation: never offer them here.
      if (disabled.has(m.id) || m.kind === "image") continue;
      out.push({ value: `${p.id}::${m.id}`, label: `${p.name} · ${m.name}` });
    }
  }
  return out;
}

export function CapabilityPage({
  kind,
  items,
  onToggle,
  tabs,
  providers,
  liveModels,
  subagentModels,
  subagentEfforts,
  onSetSubagentModel,
  onSetSubagentEffort,
}: Props) {
  const copy = COPY[kind];
  const isSubagents = kind === "subagent";
  const options = isSubagents ? modelOptions(providers, liveModels) : [];
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<(typeof SCOPE_FILTERS)[number]>("All");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      const itemScope = scopeOf(item);
      const scopeOk =
        scope === "All" ||
        (scope === "Plugin"
          ? (item.source ?? "").startsWith("plugin:")
          : itemScope === scope);
      const queryOk =
        !q || item.name.toLowerCase().includes(q) || (item.description ?? "").toLowerCase().includes(q);
      return scopeOk && queryOk;
    });
  }, [items, query, scope]);

  return (
    <div className="settings-page">
      <PageHeader title={copy.title} description={copy.description} />
      {tabs}

      <SearchField value={query} onChange={setQuery} placeholder={`Search ${copy.title.toLowerCase()}…`}>
        <select
          className="select"
          value={scope}
          aria-label="Filter by source"
          onChange={(e) => setScope(e.target.value as (typeof SCOPE_FILTERS)[number])}
        >
          {SCOPE_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </SearchField>

      <SectionHeader
        title={isSubagents ? "Installed subagents" : `Workspace and personal ${copy.title.toLowerCase()}`}
        count={filtered.length}
      />

      {filtered.length === 0 ? (
        <EmptyState icon={copy.icon} title={query || scope !== "All" ? "Nothing matches this filter." : copy.empty} />
      ) : (
        <RowList>
          {filtered.map((item) => (
            <Row
              key={item.id}
              icon={<IconTile name={item.name} icon={copy.icon} />}
              title={item.name}
              tags={item.version ? <Tag tone="muted">v{item.version}</Tag> : undefined}
              description={item.description || item.path}
              aside={
                <>
                  {isSubagents && onSetSubagentModel && (
                    <select
                      className="select select--small"
                      aria-label={`Model for ${item.name}`}
                      value={subagentModels?.[item.name] ?? ""}
                      onChange={(e) => onSetSubagentModel(item.name, e.target.value || undefined)}
                    >
                      <option value="">{item.effectiveModel ? `Auto · ${item.effectiveModel}` : "Inherit main model"}</option>
                      {options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                  {isSubagents && onSetSubagentEffort && (
                    <select
                      className="select select--small"
                      aria-label={`Effort for ${item.name}`}
                      value={subagentEfforts?.[item.name] ?? ""}
                      onChange={(e) => onSetSubagentEffort(item.name, e.target.value || undefined)}
                    >
                      <option value="">Inherit effort</option>
                      {EFFORT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <span className="row__note">{scopeOf(item)}</span>
                  <Toggle checked={item.enabled} onChange={(v) => onToggle(item.id, v)} />
                  <button
                    className="icon-btn icon-btn--small"
                    title={item.path ? "Reveal definition file" : "No file on disk"}
                    disabled={!item.path}
                    onClick={() => item.path && window.deyin.shell.showItem(item.path)}
                  >
                    <Icon name="folder" size={12} />
                  </button>
                </>
              }
            />
          ))}
        </RowList>
      )}
    </div>
  );
}
