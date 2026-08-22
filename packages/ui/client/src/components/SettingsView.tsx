import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useT } from "../i18n.js";
import { Icon, type IconName } from "./Icon.js";
import { SectionHeader, SettingCard, SettingGroup, TabBar, Toggle } from "./settings/controls.js";

// Settings pages are heavy (MCP catalog, indexing UI, usage charts) and only one
// is visible at a time; lazy chunks keep them out of the initial renderer bundle.
const CapabilityPage = lazy(() => import("./settings/CapabilityPage.js").then((m) => ({ default: m.CapabilityPage })));
const GeneralPage = lazy(() => import("./settings/GeneralPage.js").then((m) => ({ default: m.GeneralPage })));
const AppearancePage = lazy(() => import("./settings/AppearancePage.js").then((m) => ({ default: m.AppearancePage })));
const SshHostsPage = lazy(() => import("./settings/SshHostsPage.js").then((m) => ({ default: m.SshHostsPage })));
const IdentityPage = lazy(() => import("./settings/IdentityPage.js").then((m) => ({ default: m.IdentityPage })));
const IndexingPage = lazy(() => import("./settings/IndexingPage.js").then((m) => ({ default: m.IndexingPage })));
const McpPage = lazy(() => import("./settings/McpPage.js").then((m) => ({ default: m.McpPage })));
const ModelRolesPage = lazy(() => import("./settings/ModelRolesPage.js").then((m) => ({ default: m.ModelRolesPage })));
const ModelSettingsPage = lazy(() => import("./settings/ModelSettingsPage.js").then((m) => ({ default: m.ModelSettingsPage })));
const PluginsPage = lazy(() => import("./settings/PluginsPage.js").then((m) => ({ default: m.PluginsPage })));
const TerminalPage = lazy(() => import("./settings/TerminalPage.js").then((m) => ({ default: m.TerminalPage })));
const BrowserPage = lazy(() => import("./settings/BrowserPage.js").then((m) => ({ default: m.BrowserPage })));
const ComputerUsePage = lazy(() => import("./settings/ComputerUsePage.js").then((m) => ({ default: m.ComputerUsePage })));
const UsageStatsPage = lazy(() => import("./settings/UsageStatsPage.js").then((m) => ({ default: m.UsageStatsPage })));
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
  | "modelRoles"
  | "integrations"
  | "skills"
  | "workspace"
  | "data"
  | "indexing"
  | "sshHosts"
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
  sshHosts: "sshHosts",
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
      { page: "modelRoles", labelKey: "settings.nav.modelRoles", icon: "brain" },
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
    entries: [
      { page: "account", labelKey: "settings.nav.account", icon: "shield" },
      { page: "sshHosts", labelKey: "settings.nav.sshHosts", icon: "server" },
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
  activeThreadId?: string | null;
  platform?: "desktop" | "web";
  /** Live models for the primary provider, passed through to Model settings. */
  liveModels: import("@deyin/contract").ModelInfo[];
  providers: ProviderInfo[];
  onProvidersChanged: (providers: ProviderInfo[]) => void;
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
  const providers = props.providers;
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [accountUsage, setAccountUsage] = useState<AccountUsage | null>(null);
  const [accountRefreshing, setAccountRefreshing] = useState(false);

  useEffect(() => {
    void window.deyin.caps.list().then(setCaps).catch(() => setCaps([]));
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

  const setRoleModel = (role: string, model: string | undefined) => {
    const next = { ...(props.settings.roleModels ?? {}) };
    if (model) next[role] = model;
    else delete next[role];
    props.onChangeSettings({ roleModels: next });
  };

  const setSubagentModel = (name: string, model: string | undefined) => {
    const next = { ...(props.settings.subagentModels ?? {}) };
    if (model) next[name] = model;
    else delete next[name];
    props.onChangeSettings({ subagentModels: next });
  };

  const setSubagentEffort = (name: string, effort: string | undefined) => {
    const next = { ...(props.settings.subagentEfforts ?? {}) };
    if (effort) next[name] = effort;
    else delete next[name];
    props.onChangeSettings({ subagentEfforts: next });
  };

  const integrationTabs = (
    <TabBar
      tabs={INTEGRATION_TABS.map((tab) => ({ id: tab.id, label: t(tab.labelKey), icon: tab.icon }))}
      value={integrationTab}
      onChange={setIntegrationTab}
    />
  );

  const skillTabs = (
    <TabBar
      tabs={SKILL_TABS.map((tab) => ({ id: tab.id, label: t(tab.labelKey), icon: tab.icon }))}
      value={skillTab}
      onChange={setSkillTab}
    />
  );

  // Integrations, Skills, Workspace and SSH hosts manage desktop-local
  // resources, so the web build hides them entry by entry (a group can mix
  // shared and desktop-only pages, as Account and SSH hosts do).
  const DESKTOP_ONLY: SettingsPage[] = ["integrations", "skills", "workspace", "sshHosts"];
  const visibleNav = NAV.map((group) => ({
    ...group,
    entries: isWeb ? group.entries.filter((e) => !DESKTOP_ONLY.includes(e.page)) : group.entries,
  })).filter((group) => group.entries.length > 0);

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
        <Suspense fallback={<div className="settings-page" />}>
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
            onProvidersChanged={props.onProvidersChanged}
            onRefreshLiveModels={props.onRefreshLiveModels ?? (() => Promise.resolve())}
          />
        )}
        {page === "modelRoles" && (
          <ModelRolesPage
            providers={providers}
            liveModels={props.liveModels}
            roleModels={props.settings.roleModels ?? {}}
            subagents={caps.filter((c) => c.kind === "subagent")}
            subagentModels={props.settings.subagentModels ?? {}}
            onSetRoleModel={setRoleModel}
            onSetSubagentModel={setSubagentModel}
          />
        )}
        {page === "integrations" && (
          <>
            {integrationTab === "mcp" && <McpPage onToggle={toggleCap} tabs={integrationTabs} />}
            {integrationTab === "plugins" && <PluginsPage onToggle={toggleCap} tabs={integrationTabs} />}
          </>
        )}
        {page === "skills" && (
          <CapabilityPage
            kind={skillTab}
            items={caps.filter((c) => c.kind === skillTab)}
            onToggle={toggleCap}
            tabs={skillTabs}
            providers={providers}
            liveModels={props.liveModels}
            subagentModels={props.settings.subagentModels ?? {}}
            subagentEfforts={props.settings.subagentEfforts ?? {}}
            onSetSubagentModel={skillTab === "subagent" ? setSubagentModel : undefined}
            onSetSubagentEffort={skillTab === "subagent" ? setSubagentEffort : undefined}
          />
        )}
        {page === "workspace" && (
          <>
            <TerminalPage settings={props.settings} onChange={props.onChangeSettings} />
            <BrowserPage settings={props.settings} onChange={props.onChangeSettings} />
            <ComputerUsePage settings={props.settings} onChange={props.onChangeSettings} />
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
              <SectionHeader title="Agent data" note="Stored on this device." />
              <SettingGroup>
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
              </SettingGroup>
            </div>
          </>
        )}
        {page === "indexing" && (
          <IndexingPage workspaceRoot={props.workspaceRoot} settings={props.settings} onChange={props.onChangeSettings} />
        )}
        {page === "account" && (
          <IdentityPage user={props.user} onConnect={props.onConnect} onOpenUsage={() => setPage("data")} />
        )}
        {/* SSH targets for remote automation runs; its own page, desktop-only. */}
        {page === "sshHosts" && <SshHostsPage />}
        </Suspense>
      </div>
    </div>
  );
}
