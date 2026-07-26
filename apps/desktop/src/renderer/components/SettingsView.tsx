import { useEffect, useState } from "react";
import { Icon, type IconName } from "./Icon.js";
import { AppearancePage } from "./settings/AppearancePage.js";
import { BrowserPage } from "./settings/BrowserPage.js";
import { CapabilityPage } from "./settings/CapabilityPage.js";
import { GeneralPage } from "./settings/GeneralPage.js";
import { IndexingPage } from "./settings/IndexingPage.js";
import { ModelSettingsPage } from "./settings/ModelSettingsPage.js";
import { OnboardPage } from "./settings/OnboardPage.js";
import { UsageStatsPage } from "./settings/UsageStatsPage.js";
import type {
  CapabilityItem,
  CapabilityKind,
  DeyinSettings,
  ProviderInfo,
  UsageStats,
  UserProfile,
} from "../../shared/types.js";

export type SettingsPage =
  | "general"
  | "appearance"
  | "models"
  | "browser"
  | "plugins"
  | "skills"
  | "subagents"
  | "mcp"
  | "commands"
  | "hooks"
  | "indexing"
  | "usage"
  | "onboard";

const CAPABILITY_PAGES: Partial<Record<SettingsPage, CapabilityKind>> = {
  plugins: "plugin",
  skills: "skill",
  subagents: "subagent",
  mcp: "mcp",
  commands: "command",
  hooks: "hook",
};

interface NavEntry {
  page: SettingsPage;
  label: string;
  icon: IconName;
}

const NAV: { section: string; entries: NavEntry[] }[] = [
  {
    section: "Basics",
    entries: [
      { page: "general", label: "General", icon: "gear" },
      { page: "appearance", label: "Appearance", icon: "palette" },
      { page: "models", label: "Model settings", icon: "cpu" },
      { page: "browser", label: "Browser", icon: "globe" },
    ],
  },
  {
    section: "Agent capabilities",
    entries: [
      { page: "plugins", label: "Plugins", icon: "grid" },
      { page: "skills", label: "Skills", icon: "sparkles" },
      { page: "subagents", label: "Subagents", icon: "user" },
      { page: "mcp", label: "MCP Servers", icon: "plug" },
      { page: "commands", label: "Commands", icon: "terminal" },
      { page: "hooks", label: "Hooks", icon: "anchor" },
    ],
  },
  {
    section: "Data and statistics",
    entries: [
      { page: "indexing", label: "Indexing", icon: "search" },
      { page: "usage", label: "Usage stats", icon: "chart" },
    ],
  },
];

interface SettingsViewProps {
  initialPage: SettingsPage;
  settings: DeyinSettings;
  user: UserProfile | null;
  busy: boolean;
  version: string;
  workspaceRoot: string | null;
  /** Live models for the primary provider, passed through to Model settings. */
  liveModels: import("../../shared/types.js").ModelInfo[];
  onChangeSettings: (patch: Partial<DeyinSettings>) => void;
  onConnect: () => void;
  onBack: () => void;
}

/** Full-screen settings: left nav + routed page content. */
export function SettingsView(props: SettingsViewProps) {
  const [page, setPage] = useState<SettingsPage>(props.initialPage);
  const [caps, setCaps] = useState<CapabilityItem[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [usage, setUsage] = useState<UsageStats | null>(null);

  useEffect(() => {
    void window.deyin.caps.list().then(setCaps);
    void window.deyin.providers.list().then(setProviders);
  }, []);

  useEffect(() => {
    if (page === "usage") void window.deyin.usage.get().then(setUsage);
  }, [page]);

  const toggleCap = (id: string, enabled: boolean) => {
    void window.deyin.caps.toggle(id, enabled).then(setCaps);
  };

  const capKind = CAPABILITY_PAGES[page];

  return (
    <div className="settings">
      <aside className="settings__nav">
        <button className="settings__back" onClick={props.onBack}>
          <Icon name="arrowLeft" size={13} />
          Back to workspace
        </button>
        {NAV.map((group, i) => (
          <div key={i} className="settings__nav-group">
            {group.section && <div className="sidebar__section">{group.section}</div>}
            {group.entries.map((entry) => (
              <button
                key={entry.page}
                className={`nav-item ${page === entry.page ? "nav-item--active" : ""}`}
                onClick={() => setPage(entry.page)}
              >
                <Icon name={entry.icon} size={14} />
                <span>{entry.label}</span>
              </button>
            ))}
          </div>
        ))}
        <button
          className={`settings__onboard ${page === "onboard" ? "settings__onboard--active" : ""}`}
          onClick={() => setPage("onboard")}
        >
          <Icon name="play" size={13} />
          <span>Onboard</span>
        </button>
      </aside>

      <div className="settings__content">
        {page === "general" && (
          <GeneralPage settings={props.settings} version={props.version} onChange={props.onChangeSettings} />
        )}
        {page === "appearance" && <AppearancePage settings={props.settings} onChange={props.onChangeSettings} />}
        {page === "models" && (
          <ModelSettingsPage
            providers={providers}
            liveModels={props.liveModels}
            busy={props.busy}
            onConnect={props.onConnect}
            onProvidersChanged={setProviders}
          />
        )}
        {page === "browser" && <BrowserPage settings={props.settings} onChange={props.onChangeSettings} />}
        {capKind && (
          <CapabilityPage kind={capKind} items={caps.filter((c) => c.kind === capKind)} onToggle={toggleCap} />
        )}
        {page === "indexing" && <IndexingPage workspaceRoot={props.workspaceRoot} />}
        {page === "usage" && <UsageStatsPage stats={usage} />}
        {page === "onboard" && <OnboardPage user={props.user} busy={props.busy} onConnect={props.onConnect} />}
      </div>
    </div>
  );
}
