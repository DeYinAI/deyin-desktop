import { PageHeader, SettingCard, Toggle } from "./controls.js";
import type { CapabilityItem, CapabilityKind } from "../../../shared/types.js";

const COPY: Record<CapabilityKind, { title: string; description: string; empty: string }> = {
  plugin: {
    title: "Plugins",
    description: "Extensions that add tools and integrations to agent sessions.",
    empty: "No plugins installed.",
  },
  skill: {
    title: "Skills",
    description: "Reusable task recipes the agent can run on demand.",
    empty: "No skills available.",
  },
  subagent: {
    title: "Subagents",
    description: "Specialized helper agents the main agent can delegate to.",
    empty: "No subagents configured.",
  },
  mcp: {
    title: "MCP Servers",
    description: "Model Context Protocol servers exposing external tools and resources.",
    empty: "No MCP servers configured.",
  },
  command: {
    title: "Commands",
    description: "Slash commands available in the composer.",
    empty: "No commands defined.",
  },
  hook: {
    title: "Hooks",
    description: "Scripts that run automatically around agent lifecycle events.",
    empty: "No hooks defined.",
  },
};

interface Props {
  kind: CapabilityKind;
  items: CapabilityItem[];
  onToggle: (id: string, enabled: boolean) => void;
}

export function CapabilityPage({ kind, items, onToggle }: Props) {
  const copy = COPY[kind];
  return (
    <div className="settings-page">
      <PageHeader title={copy.title} description={copy.description} />
      {items.length === 0 && <div className="hint">{copy.empty}</div>}
      {items.map((item) => (
        <SettingCard
          key={item.id}
          title={item.name + (item.version ? ` · v${item.version}` : "")}
          description={item.description + (item.source ? ` — ${item.source}` : "")}
        >
          <Toggle checked={item.enabled} onChange={(v) => onToggle(item.id, v)} />
        </SettingCard>
      ))}
    </div>
  );
}
