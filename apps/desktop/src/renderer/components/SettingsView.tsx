import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n.js";
import { Icon, type IconName } from "./Icon.js";
import { AppearancePage } from "./settings/AppearancePage.js";
import { BrowserPage } from "./settings/BrowserPage.js";
import { CapabilityPage } from "./settings/CapabilityPage.js";
import { GeneralPage } from "./settings/GeneralPage.js";
import { IdentityPage } from "./settings/IdentityPage.js";
import { IndexingPage } from "./settings/IndexingPage.js";
import { McpPage } from "./settings/McpPage.js";
import { ModelSettingsPage } from "./settings/ModelSettingsPage.js";
import { OnboardPage } from "./settings/OnboardPage.js";
import { OptimizationPage } from "./settings/OptimizationPage.js";
import { PluginsPage } from "./settings/PluginsPage.js";
import { TerminalPage } from "./settings/TerminalPage.js";
import { SshHostsPage } from "./settings/SshHostsPage.js";
import { UsageStatsPage } from "./settings/UsageStatsPage.js";
import type { MessageKey } from "@deyin/host-core/shared";
import type {
  AccountUsage,
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
  | "terminal"
  | "plugins"
  | "skills"
  | "subagents"
  | "mcp"
  | "commands"
  | "hooks"
  | "indexing"
  | "usage"
  | "optimization"
  | "identity"
  | "sshHosts"
  | "onboard";

/** Pages rendered by the generic CapabilityPage (file-backed registries). */
const CAPABILITY_PAGES: Partial<Record<SettingsPage, CapabilityKind>> = {
  skills: "skill",
  subagents: "subagent",
  commands: "command",
  hooks: "hook",
};

interface NavEntry {
  page: SettingsPage;
  labelKey: MessageKey;
  icon: IconName;
}

const NAV: { sectionKey: MessageKey; entries: NavEntry[] }[] = [
  {
    sectionKey: "settings.section.basics",
    entries: [
      { page: "general", labelKey: "settings.nav.general", icon: "gear" },
      { page: "appearance", labelKey: "settings.nav.appearance", icon: "palette" },
      { page: "models", labelKey: "settings.nav.models", icon: "cpu" },
      { page: "browser", labelKey: "settings.nav.browser", icon: "globe" },
      { page: "terminal", labelKey: "settings.nav.terminal", icon: "terminal" },
    ],
  },
  {
    sectionKey: "settings.section.capabilities",
    entries: [
      { page: "plugins", labelKey: "settings.nav.plugins", icon: "grid" },
      { page: "skills", labelKey: "settings.nav.skills", icon: "sparkles" },
      { page: "subagents", labelKey: "settings.nav.subagents", icon: "user" },
      { page: "mcp", labelKey: "settings.nav.mcp", icon: "plug" },
      { page: "commands", labelKey: "settings.nav.commands", icon: "terminal" },
      { page: "hooks", labelKey: "settings.nav.hooks", icon: "anchor" },
    ],
  },
  {
    sectionKey: "settings.section.data",
    entries: [
      { page: "indexing", labelKey: "settings.nav.indexing", icon: "search" },
      { page: "usage", labelKey: "settings.nav.usage", icon: "chart" },
      { page: "optimization", labelKey: "settings.nav.optimization", icon: "sparkles" },
      { page: "sshHosts", labelKey: "settings.nav.sshHosts", icon: "terminal" },
    ],
  },
  {
    sectionKey: "settings.section.deyin",
    entries: [{ page: "identity", labelKey: "settings.nav.identity", icon: "shield" }],
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
  onOpenFolder: () => void;
  onOpenTerminal: () => void;
  onRefreshLiveModels?: () => Promise<void>;
}

/** Full-screen settings: left nav + routed page content. */
export function SettingsView(props: SettingsViewProps) {
  const t = useT();
  const [page, setPage] = useState<SettingsPage>(props.initialPage);
  const [caps, setCaps] = useState<CapabilityItem[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [accountUsage, setAccountUsage] = useState<AccountUsage | null>(null);
  const [accountRefreshing, setAccountRefreshing] = useState(false);

  useEffect(() => {
    void window.deyin.caps.list().then(setCaps).catch(() => setCaps([]));
    void window.deyin.providers.list().then(setProviders);
  }, []);

  useEffect(() => {
    if (page === "usage") {
      void window.deyin.usage.get().then(setUsage);
      void window.deyin.usage.account().then(setAccountUsage).catch(() => setAccountUsage(null));
    }
  }, [page]);

  const refreshAccount = useCallback(async () => {
    setAccountRefreshing(true);
    try {
      setAccountUsage(await window.deyin.usage.account(true));
    } catch {
      setAccountUsage(null);
    } finally {
      setAccountRefreshing(false);
    }
  }, []);

  const toggleCap = (id: string, enabled: boolean) => {
    void window.deyin.caps.toggle(id, enabled).then(setCaps);
  };

  const capKind = CAPABILITY_PAGES[page];

  return (
    <div className="settings">
      <aside className="settings__nav">
        <button className="settings__back" onClick={props.onBack}>
          <Icon name="arrowLeft" size={13} />
          {t("nav.backToWorkspace")}
        </button>
        {NAV.map((group, i) => (
          <div key={i} className="settings__nav-group">
            <div className="sidebar__section">{t(group.sectionKey)}</div>
            {group.entries.map((entry) => (
              <button
                key={entry.page}
                className={`nav-item ${page === entry.page ? "nav-item--active" : ""}`}
                onClick={() => setPage(entry.page)}
              >
                <Icon name={entry.icon} size={14} />
                <span>{t(entry.labelKey)}</span>
              </button>
            ))}
          </div>
        ))}
        <button
          className={`settings__onboard ${page === "onboard" ? "settings__onboard--active" : ""}`}
          onClick={() => setPage("onboard")}
        >
          <Icon name="play" size={13} />
          <span>{t("settings.nav.onboard")}</span>
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
            onRefreshLiveModels={props.onRefreshLiveModels ?? (() => Promise.resolve())}
          />
        )}
        {page === "browser" && <BrowserPage settings={props.settings} onChange={props.onChangeSettings} />}
        {page === "terminal" && <TerminalPage settings={props.settings} onChange={props.onChangeSettings} />}
        {page === "sshHosts" && <SshHostsPage />}
        {page === "plugins" && <PluginsPage onToggle={toggleCap} />}
        {page === "mcp" && <McpPage onToggle={toggleCap} />}
        {capKind && (
          <CapabilityPage kind={capKind} items={caps.filter((c) => c.kind === capKind)} onToggle={toggleCap} />
        )}
        {page === "indexing" && (
          <IndexingPage workspaceRoot={props.workspaceRoot} settings={props.settings} onChange={props.onChangeSettings} />
        )}
        {page === "usage" && (
          <UsageStatsPage
            stats={usage}
            account={accountUsage}
            signedIn={props.user !== null}
            onRefreshAccount={() => void refreshAccount()}
            refreshing={accountRefreshing}
          />
        )}
        {page === "optimization" && (
          <OptimizationPage settings={props.settings} onChange={props.onChangeSettings} />
        )}
        {page === "identity" && (
          <IdentityPage
            user={props.user}
            onConnect={props.onConnect}
            onOpenUsage={() => setPage("usage")}
            onShowThreads={props.onBack}
          />
        )}
        {page === "onboard" && (
          <OnboardPage
            user={props.user}
            busy={props.busy}
            settings={props.settings}
            onConnect={props.onConnect}
            onOpenFolder={props.onOpenFolder}
            onOpenTerminal={props.onOpenTerminal}
            onStartTask={props.onBack}
            onChange={props.onChangeSettings}
          />
        )}
      </div>
    </div>
  );
}
