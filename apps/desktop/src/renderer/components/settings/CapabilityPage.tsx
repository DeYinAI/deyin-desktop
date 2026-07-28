import { Icon } from "../Icon.js";
import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";
import type { CapabilityItem, CapabilityKind } from "../../../shared/types.js";

const COPY: Record<CapabilityKind, { title: string; description: string; empty: string }> = {
  plugin: {
    title: "Plugins",
    description: "Extensions that add tools and integrations to agent sessions.",
    empty: "No plugins installed.",
  },
  skill: {
    title: "Skills",
    description:
      "Reusable task recipes the agent reads on demand. Discovered from .deyin/skills (workspace), ~/.deyin/skills (custom) and installed plugins; create your own with /create-skill in chat.",
    empty: "No skills available. Ask the agent to /create-skill one.",
  },
  subagent: {
    title: "Subagents",
    description:
      "Specialized helper agents the main agent delegates to via the task tool. Custom ones live in .deyin/agents/*.md (frontmatter: name, description, model, readonly, is_background).",
    empty: "No subagents configured.",
  },
  mcp: {
    title: "MCP Servers",
    description: "Model Context Protocol servers exposing external tools and resources.",
    empty: "No MCP servers configured.",
  },
  command: {
    title: "Commands",
    description:
      "Slash commands available in the composer. One markdown file per command in .deyin/commands/ or ~/.deyin/commands/; $ARGUMENTS receives the text after the command.",
    empty: "No commands defined.",
  },
  hook: {
    title: "Hooks",
    description:
      "Custom scripts that run around agent lifecycle events, defined in .deyin/hooks.json (workspace) or ~/.deyin/hooks.json. Exit code 2 blocks the action; hooks fail open otherwise.",
    empty: "No hooks defined. Create .deyin/hooks.json to add some.",
  },
};

/** Group order: built-ins first, then user ("custom"), workspace, plugins. */
function groupOf(item: CapabilityItem): string {
  const source = item.source ?? "built-in";
  if (source === "built-in") return "Built-in";
  if (source === "user") return "Custom";
  if (source === "workspace") return "Workspace";
  if (source.startsWith("plugin:")) return `Plugin · ${source.slice("plugin:".length)}`;
  return source;
}

const GROUP_ORDER = ["Built-in", "Custom", "Workspace"];

interface Props {
  kind: CapabilityKind;
  items: CapabilityItem[];
  onToggle: (id: string, enabled: boolean) => void;
}

export function CapabilityPage({ kind, items, onToggle }: Props) {
  const copy = COPY[kind];

  const groups = new Map<string, CapabilityItem[]>();
  for (const item of items) {
    const group = groupOf(item);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(item);
  }
  const orderedGroups = [...groups.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });

  return (
    <div className="settings-page">
      <PageHeader title={copy.title} description={copy.description} />
      {items.length === 0 && <div className="hint">{copy.empty}</div>}
      {orderedGroups.map((group) => (
        <div key={group}>
          {orderedGroups.length > 1 && <SectionTitle>{group}</SectionTitle>}
          {groups.get(group)!.map((item) => (
            <SettingCard
              key={item.id}
              title={item.name + (item.version ? ` · v${item.version}` : "")}
              description={item.description + (item.path ? ` — ${item.path}` : "")}
            >
              <div className="field__row">
                {item.path && (
                  <button
                    className="icon-btn icon-btn--small"
                    title="Reveal definition file"
                    onClick={() => window.deyin.shell.showItem(item.path!)}
                  >
                    <Icon name="folder" size={12} />
                  </button>
                )}
                <Toggle checked={item.enabled} onChange={(v) => onToggle(item.id, v)} />
              </div>
            </SettingCard>
          ))}
        </div>
      ))}
    </div>
  );
}
