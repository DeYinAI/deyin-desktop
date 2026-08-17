import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n.js";
import { Icon, type IconName } from "./Icon.js";
import { CapabilityPage } from "./settings/CapabilityPage.js";
import { GeneralPage } from "./settings/GeneralPage.js";
import { AppearancePage } from "./settings/AppearancePage.js";
import { IdentityPage } from "./settings/IdentityPage.js";
import { IndexingPage } from "./settings/IndexingPage.js";
import { McpPage } from "./settings/McpPage.js";
import { ModelSettingsPage } from "./settings/ModelSettingsPage.js";
import { PluginsPage } from "./settings/PluginsPage.js";
import { TerminalPage } from "./settings/TerminalPage.js";
import { BrowserPage } from "./settings/BrowserPage.js";
import { UsageStatsPage } from "./settings/UsageStatsPage.js";
import { PageHeader, SectionTitle, SettingCard, TabBar, Toggle } from "./settings/controls.js";
import type { MessageKey } from "@deyin/host-core/shared";
import type {
  AccountUsage,
  CapabilityItem,
  CapabilityKind,
  DeyinSettings,
  ProviderInfo,
  UsageStats,
  UserProfile,
} from "@deyin/contract";

export type SettingsPage =
  | "general"
  | "models"
  | "integrations"
  | "skills"
  | "workspace"
  | "data"
  | "indexing"
  | "account";

/** Legacy page ids kept valid so stale deep-links (e.g. stored settings pages) route somewhere sane. */
const LEGACY_PAGE_ROUTES: Partial<Record<string, SettingsPage>> = {
  appearance: "general",
  browser: "workspace",
  terminal: "workspace",
  chrome: "workspace",
  computerUse: "workspace",
  capabilities: "integrations",
  plugins: "integrations",
  mcp: "integrations",
  skills: "skills",
  subagents: "skills",
  commands: "skills",
  hooks: "skills",
  indexing: "indexing",
  usage: "data",
  optimization: "data",
  sshHosts: "account",
  identity: "account",
  onboard: "account",
  cache: "data",
  coordinator: "data",
  scheduler: "data",
  evidence: "data",
};

type IntegrationTab = "mcp" | "plugins";

const INTEGRATION_TABS: { id: IntegrationTab; labelKey: MessageKey; icon: IconName }[] = [
  { id: "mcp", labelKey: "settings.nav.mcp", icon: "plug" },
  { id: "plugins", labelKey: "settings.nav.plugins", icon: "grid" },
];

const SKILL_TABS: { id: CapabilityKind; labelKey: MessageKey; icon: IconName }[] = [
  { id: "skill", labelKey: "settings.nav.skills", icon: "sparkles" },
  { id: "subagent", labelKey: "settings.nav.subagents", icon: "brain" },
  { id: "command", labelKey: "settings.nav.commands", icon: "terminal" },
  { id: "hook", labelKey: "settings.nav.hooks", icon: "bolt" },
];

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
      { page: "models", labelKey: "settings.nav.models", icon: "cpu" },
    ],
  },
  {
    sectionKey: "settings.section.capabilities",
    entries: [
      { page: "integrations", labelKey: "settings.nav.integrations", icon: "plug" },
      { page: "skills", labelKey: "settings.nav.skillsAgents", icon: "sparkles" },
    ],
  },
  {
    sectionKey: "settings.section.data",
    entries: [
      { page: "data", labelKey: "settings.nav.agentData", icon: "chart" },
      { page: "indexing", labelKey: "settings.nav.indexing", icon: "zoom" },
      { page: "workspace", labelKey: "settings.nav.workspace", icon: "terminal" },
    ],
  },
  {
    sectionKey: "settings.section.deyin",
    entries: [{ page: "account", labelKey: "settings.nav.account", icon: "shield" }],
  },
];

interface SettingsViewProps {
  initialPage: SettingsPage;
  settings: DeyinSettings;
  user: UserProfile | null;
  busy: boolean;
  version: string;
  workspaceRoot: string | null;
  activeThreadId?: string | null;
  platform?: "desktop" | "web";
  /** Live models for the primary provider, passed through to Model settings. */
  liveModels: import("@deyin/contract").ModelInfo[];
  onChangeSettings: (patch: Partial<DeyinSettings>) => void;
  onConnect: () => void;
  onBack: () => void;
  onRefreshLiveModels?: () => Promise<void>;
}

/** Full-screen settings: left nav + routed page content. */
export function SettingsView(props: SettingsViewProps) {
  const t = useT();
  const isWeb = props.platform === "web";
  const [page, setPage] = useState<SettingsPage>(
    LEGACY_PAGE_ROUTES[props.initialPage] ?? props.initialPage,
  );
  const [integrationTab, setIntegrationTab] = useState<IntegrationTab>("mcp");
  const [skillTab, setSkillTab] = useState<CapabilityKind>("skill");
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
    if (page === "data") {
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

  const setSubagentModel = (name: string, model: string | undefined) => {
    const next = { ...(props.settings.subagentModels ?? {}) };
    if (model) next[name] = model;
    else delete next[name];
    props.onChangeSettings({ subagentModels: next });
  };

  const visibleNav = NAV.filter((group) => {
    if (isWeb) {
      // Integrations, Skills and Workspace manage desktop-local resources.
      return !group.entries.some(
        (e) => e.page === "integrations" || e.page === "skills" || e.page === "workspace",
      );
    }
    return true;
  });

  return (
    <div className="settings">
      <aside className="settings__nav">
        <button className="settings__back" onClick={props.onBack}>
          <Icon name="arrowLeft" size={13} />
          {t("nav.backToWorkspace")}
        </button>
        {visibleNav.map((group, i) => (
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
      </aside>

      <div className="settings__content">
        {page === "general" && (
          <>
            <GeneralPage settings={props.settings} version={props.version} onChange={props.onChangeSettings} />
            <AppearancePage settings={props.settings} onChange={props.onChangeSettings} />
          </>
        )}
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
        {page === "integrations" && (
          <div className="settings-page">
            <PageHeader title={t("settings.nav.integrations")} description={t("settings.integrations.desc")} />
            <TabBar
              tabs={INTEGRATION_TABS.map((tab) => ({ id: tab.id, label: t(tab.labelKey), icon: tab.icon }))}
              value={integrationTab}
              onChange={setIntegrationTab}
            />
            {integrationTab === "mcp" && <McpPage onToggle={toggleCap} />}
            {integrationTab === "plugins" && <PluginsPage onToggle={toggleCap} />}
          </div>
        )}
        {page === "skills" && (
          <div className="settings-page">
            <PageHeader title={t("settings.nav.skillsAgents")} description={t("settings.skills.desc")} />
            <TabBar
              tabs={SKILL_TABS.map((tab) => ({ id: tab.id, label: t(tab.labelKey), icon: tab.icon }))}
              value={skillTab}
              onChange={setSkillTab}
            />
            <CapabilityPage
              kind={skillTab}
              items={caps.filter((c) => c.kind === skillTab)}
              onToggle={toggleCap}
              providers={providers}
              liveModels={props.liveModels}
              onSetSubagentModel={skillTab === "subagent" ? setSubagentModel : undefined}
            />
          </div>
        )}
        {page === "workspace" && (
          <>
            <TerminalPage settings={props.settings} onChange={props.onChangeSettings} />
            <BrowserPage settings={props.settings} onChange={props.onChangeSettings} />
          </>
        )}
        {page === "data" && (
          <>
            <UsageStatsPage
              stats={usage}
              account={accountUsage}
              signedIn={props.user !== null}
              onRefreshAccount={() => void refreshAccount()}
              refreshing={accountRefreshing}
            />
            <div className="settings-page">
              <PageHeader title={t("settings.nav.agentData")} description={t("settings.nav.agentData")} />
              <SectionTitle>Agent</SectionTitle>
              <SettingCard title="Memory" description="Background memory (remember/forget + automatic recall).">
                <Toggle
                  checked={props.settings.memoryEnabled}
                  onChange={(memoryEnabled) => props.onChangeSettings({ memoryEnabled })}
                />
              </SettingCard>
              <SettingCard
                title="Semantic caches"
                description="Tool-result and response caches via the optimization plugin (embeddings-based)."
              >
                <Toggle
                  checked={props.settings.optimizationPluginEnabled}
                  onChange={(optimizationPluginEnabled) =>
                    props.onChangeSettings({ optimizationPluginEnabled })
                  }
                />
              </SettingCard>
            </div>
          </>
        )}
        {page === "indexing" && (
          <IndexingPage workspaceRoot={props.workspaceRoot} settings={props.settings} onChange={props.onChangeSettings} />
        )}
        {page === "account" && (
          <IdentityPage
            user={props.user}
            onConnect={props.onConnect}
            onOpenUsage={() => setPage("data")}
          />
        )}
      </div>
    </div>
  );
}
