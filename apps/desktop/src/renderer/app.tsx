import { useCallback, useEffect, useMemo, useState } from "react";
import { streamChat } from "./api/openference.js";
import { ChatView } from "./components/ChatView.js";
import { Composer } from "./components/Composer.js";
import { EnvironmentBadge } from "./components/EnvironmentBadge.js";
import { SearchOverlay } from "./components/SearchOverlay.js";
import { SettingsView } from "./components/SettingsView.js";
import { Sidebar } from "./components/Sidebar.js";
import { TerminalPanel } from "./components/TerminalPanel.js";
import { ThreadMenu, type ThreadAction } from "./components/ThreadMenu.js";
import { TopBar } from "./components/TopBar.js";
import { Welcome } from "./components/Welcome.js";
import { WorkspacePanel, type PanelTab } from "./components/WorkspacePanel.js";
import type { FileDiff } from "./diff.js";
import { emptyThread, toChatMessages, type Project, type ThreadEvent } from "./threads.js";
import type { SettingsPage } from "./components/SettingsView.js";
import type {
  ApprovalMode,
  Bootstrap,
  DeyinSettings,
  EnvInfo,
  ModelInfo,
  ProviderInfo,
  UserProfile,
} from "../shared/types.js";

type View = "workspace" | "settings";

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<DeyinSettings | null>(null);
  const [env, setEnv] = useState<EnvInfo | null>(null);

  const [view, setView] = useState<View>("workspace");
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("general");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("openference");
  const [selectedModel, setSelectedModel] = useState<string>("GLM-5.2");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);

  const [panelOpen, setPanelOpen] = useState(true);
  const [panelTab, setPanelTab] = useState<PanelTab>("plan");
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [browserUrl, setBrowserUrl] = useState("");
  const [terminalOpen, setTerminalOpen] = useState(false);

  const [searchOpen, setSearchOpen] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [threadMenu, setThreadMenu] = useState<{ threadId: string; x: number; y: number } | null>(null);

  // Bootstrap: config, profile, models, settings, environment, providers.
  useEffect(() => {
    void (async () => {
      const b = await window.deyin.bootstrap();
      setBoot(b);
      setUser(b.user);
      setWorkspaceRoot(b.workspaceRoot);
      const [list, s, e, provs] = await Promise.all([
        window.deyin.models.list(),
        window.deyin.settings.get(),
        window.deyin.env.detect().catch(() => null),
        window.deyin.providers.list().catch(() => [] as ProviderInfo[]),
      ]);
      setModels(list);
      setSettings(s);
      setEnv(e);
      setProviders(provs);
      // defaultModel persists as "providerId::modelId" (falls back to a bare model id).
      const [savedProvider, savedModel] = s.defaultModel?.includes("::")
        ? (s.defaultModel.split("::") as [string, string])
        : ["openference", s.defaultModel ?? ""];
      const disabledFor = (providerId: string) =>
        new Set(provs.find((p) => p.id === providerId)?.disabledModels ?? []);
      const savedUsable =
        Boolean(savedModel) &&
        !disabledFor(savedProvider).has(savedModel) &&
        (savedProvider !== "openference" || list.some((m) => m.id === savedModel));
      if (savedUsable) {
        setSelectedProviderId(savedProvider);
        setSelectedModel(savedModel);
      } else {
        // Fall back to the first enabled primary model.
        const primaryDisabled = disabledFor("openference");
        const enabled = list.filter((m) => !primaryDisabled.has(m.id));
        if (enabled[0]) {
          setSelectedModel((cur) => (enabled.some((m) => m.id === cur) ? cur : enabled[0]!.id));
        }
      }
    })();
  }, []);

  // Select the first thread that has content on first load.
  useEffect(() => {
    if (activeThreadId) return;
    const first = projects.flatMap((p) => p.threads).find((t) => t.events.length > 0) ?? projects[0]?.threads[0];
    if (first) setActiveThreadId(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeThread = useMemo(
    () => projects.flatMap((p) => p.threads).find((t) => t.id === activeThreadId) ?? null,
    [projects, activeThreadId],
  );

  const patchSettings = useCallback((patch: Partial<DeyinSettings>) => {
    setSettings((cur) => (cur ? { ...cur, ...patch } : cur));
    void window.deyin.settings.set(patch).then(setSettings);
  }, []);

  const [connecting, setConnecting] = useState(false);

  const refreshSession = useCallback(async () => {
    const profile = await window.deyin.auth.getUser();
    setUser(profile);
    if (profile) setModels(await window.deyin.models.list());
  }, []);

  const connect = useCallback(async () => {
    setBusy(true);
    setConnecting(true);
    try {
      // Deep-link flow returns null (completes via the auth:changed event);
      // the loopback/dev flow returns the profile directly.
      const profile = await window.deyin.auth.connect();
      if (profile) {
        setUser(profile);
        setModels(await window.deyin.models.list());
        setConnecting(false);
      }
    } catch (err) {
      console.error("Connect failed", err);
      setConnecting(false);
    } finally {
      setBusy(false);
    }
  }, []);

  // Browser deep-link login (or logout) finishes asynchronously in the main
  // process; re-read the session when it signals a change.
  useEffect(() => {
    const off = window.deyin.auth.onChanged(() => {
      setConnecting(false);
      void refreshSession();
    });
    return off;
  }, [refreshSession]);

  const logout = useCallback(async () => {
    await window.deyin.auth.logout();
    setUser(null);
    // Signing out returns to the Welcome screen, even for API-key users.
    patchSettings({ welcomeDismissed: false });
  }, [patchSettings]);

  const openFolder = useCallback(async () => {
    const root = await window.deyin.workspace.openFolder();
    if (root) setWorkspaceRoot(root);
  }, []);

  const appendEvents = useCallback((threadId: string, events: ThreadEvent[]) => {
    setProjects((cur) =>
      cur.map((project) => ({
        ...project,
        threads: project.threads.map((thread) =>
          thread.id === threadId ? { ...thread, events: [...thread.events, ...events], age: "now" } : thread,
        ),
      })),
    );
  }, []);

  const newTask = useCallback(() => {
    const thread = emptyThread();
    setProjects((cur) => {
      if (cur.length === 0) return [{ id: "proj-default", name: "Workspace", threads: [thread] }];
      const [first, ...rest] = cur;
      return [{ ...first!, threads: [thread, ...first!.threads] }, ...rest];
    });
    setActiveThreadId(thread.id);
    setView("workspace");
  }, []);

  const updateThread = useCallback((threadId: string, patch: Partial<Project["threads"][number]>) => {
    setProjects((cur) =>
      cur.map((project) => ({
        ...project,
        threads: project.threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread)),
      })),
    );
  }, []);

  const handleThreadAction = useCallback(
    (threadId: string, action: ThreadAction) => {
      switch (action) {
        case "pin": {
          const thread = projects.flatMap((p) => p.threads).find((t) => t.id === threadId);
          updateThread(threadId, { pinned: !thread?.pinned });
          break;
        }
        case "rename":
          setRenamingThreadId(threadId);
          break;
        case "archive": {
          updateThread(threadId, { archived: true });
          if (activeThreadId === threadId) {
            const next = projects
              .flatMap((p) => p.threads)
              .find((t) => t.id !== threadId && !t.archived);
            setActiveThreadId(next?.id ?? null);
          }
          break;
        }
        case "unread":
          updateThread(threadId, { unread: true });
          break;
        case "trajectory":
          setPanelOpen(true);
          setPanelTab("plan");
          break;
      }
    },
    [projects, activeThreadId, updateThread],
  );

  // Global shortcuts: Ctrl/Cmd+K search, Ctrl/Cmd+N new task.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newTask();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newTask]);

  // Interface theme: apply the setting to <html data-theme>; "system" follows the OS.
  useEffect(() => {
    const pref = settings?.theme ?? "dark";
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        pref === "system" ? (mql.matches ? "dark" : "light") : pref;
    };
    apply();
    if (pref === "system") {
      mql.addEventListener("change", apply);
      return () => mql.removeEventListener("change", apply);
    }
  }, [settings?.theme]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streamText !== null || !activeThread || !boot) return;

    // Route to the selected provider: primary uses the Openference OAuth token,
    // custom providers use their stored base URL + API key.
    const provider = providers.find((p) => p.id === selectedProviderId);
    let apiBaseUrl = boot.config.apiBaseUrl;
    let token: string | null = null;
    if (!provider || provider.kind === "primary") {
      token = await window.deyin.auth.getAccessToken();
      if (!token) {
        await connect();
        return;
      }
    } else {
      apiBaseUrl = provider.baseUrl ?? apiBaseUrl;
      token = await window.deyin.providers.getKey(provider.id);
      if (!token) {
        appendEvents(activeThread.id, [
          { kind: "assistant", text: `No API key stored for ${provider.name}. Add one in Settings → Model settings.` },
        ]);
        return;
      }
    }

    const isFirstMessage = toChatMessages(activeThread.events).length === 0;
    const history = [...toChatMessages(activeThread.events), { role: "user" as const, content: text }];
    appendEvents(activeThread.id, [{ kind: "user", text }]);
    setInput("");
    setStreamText("");

    let acc = "";
    let reportedTokens = 0;
    try {
      for await (const delta of streamChat({
        apiBaseUrl,
        token,
        model: selectedModel,
        messages: history,
        thinking: settings?.thinking,
        onUsage: (u) => {
          reportedTokens = u.totalTokens;
        },
      })) {
        acc += delta;
        setStreamText(acc);
      }
      appendEvents(activeThread.id, [{ kind: "assistant", text: acc }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendEvents(activeThread.id, [{ kind: "assistant", text: `Request failed: ${msg}` }]);
    } finally {
      setStreamText(null);
      // Real token usage from the provider's final stream frame. Providers that
      // report none record 0 tokens; message/session counts still apply.
      void window.deyin.usage.record({ model: selectedModel, tokens: reportedTokens, newSession: isFirstMessage });
    }
  }, [input, streamText, activeThread, boot, providers, selectedProviderId, selectedModel, settings, connect, appendEvents]);

  const greetingName = useMemo(() => {
    const first = user?.name?.split(/\s+/)[0];
    return first ? `Hi ${first}` : "Afternoon";
  }, [user]);

  const projectName = workspaceRoot
    ? workspaceRoot.split(/[\\/]/).pop() ?? "Workspace"
    : projects.find((p) => p.threads.some((t) => t.id === activeThreadId))?.name ?? "No workspace";

  // Signed-out desktop users see the Welcome screen first, unless they chose
  // the API-key path (persisted as settings.welcomeDismissed). While settings
  // load, keep showing Welcome to avoid a workspace flash. (Web signs in via a
  // full-page redirect, so it never sits in this state.)
  if (boot && boot.platform === "desktop" && !user && !settings?.welcomeDismissed) {
    return (
      <Welcome
        busy={busy}
        connecting={connecting}
        onConnect={() => void connect()}
        onUseApiKey={() => {
          // Let them in signed out; custom providers work with stored API keys.
          patchSettings({ welcomeDismissed: true });
          setSettingsPage("models");
          setView("settings");
        }}
      />
    );
  }

  if (view === "settings" && settings && boot) {
    return (
      <SettingsView
        key={settingsPage}
        initialPage={settingsPage}
        settings={settings}
        user={user}
        busy={busy}
        version={boot.version}
        workspaceRoot={workspaceRoot}
        liveModels={models}
        onChangeSettings={patchSettings}
        onConnect={connect}
        onBack={() => setView("workspace")}
      />
    );
  }

  return (
    <div className="app">
      <TopBar
        platform={boot?.platform ?? "desktop"}
        threadId={activeThreadId}
        threadTitle={activeThread?.title ?? "New task"}
        threadPinned={activeThread?.pinned ?? false}
        projectName={projectName}
        workspaceRoot={workspaceRoot}
        panelOpen={panelOpen}
        terminalOpen={terminalOpen}
        onOpenFolder={openFolder}
        onTogglePanel={() => setPanelOpen((v) => !v)}
        onToggleTerminal={() => setTerminalOpen((v) => !v)}
        onThreadAction={handleThreadAction}
      />

      <div className="app__body">
        <Sidebar
          projects={projects}
          activeThreadId={activeThreadId}
          renamingThreadId={renamingThreadId}
          user={user}
          busy={busy}
          onNewTask={newTask}
          onSelectThread={(_pid, tid) => {
            setActiveThreadId(tid);
            updateThread(tid, { unread: false });
            setView("workspace");
          }}
          onOpenSearch={() => setSearchOpen(true)}
          onThreadContext={(threadId, x, y) => setThreadMenu({ threadId, x, y })}
          onRenameSubmit={(threadId, title) => {
            updateThread(threadId, { title });
            setRenamingThreadId(null);
          }}
          onConnect={connect}
          onLogout={logout}
          onOpenSettings={() => setView("settings")}
        />

        <div className="app__center">
          <div className="app__columns">
            <main className="chat-column">
              <div className="chat-column__bar">
                <EnvironmentBadge
                  env={env}
                  onPickShell={() => setTerminalOpen(true)}
                />
              </div>

              <ChatView
                events={activeThread?.events ?? []}
                streamText={streamText}
                greetingName={greetingName}
                onOpenFile={() => {
                  setPanelOpen(true);
                  setPanelTab("diff");
                }}
                onUndo={() => setDiff(null)}
              />

              <div className="chat-column__composer">
                <Composer
                  value={input}
                  models={models}
                  selectedModel={selectedModel}
                  approvalMode={settings?.approvalMode ?? "full-access"}
                  thinking={settings?.thinking ?? true}
                  canSend={input.trim().length > 0 && streamText === null}
                  streaming={streamText !== null}
                  hasEvents={(activeThread?.events.length ?? 0) > 0}
                  providers={providers}
                  selectedProviderId={selectedProviderId}
                  onChange={setInput}
                  onSend={() => void send()}
                  onSelectModel={(id) => {
                    setSelectedModel(id);
                    patchSettings({ defaultModel: `${selectedProviderId}::${id}` });
                  }}
                  onSelectProviderModel={(providerId, modelId) => {
                    setSelectedProviderId(providerId);
                    setSelectedModel(modelId);
                    patchSettings({ defaultModel: `${providerId}::${modelId}` });
                  }}
                  onManageModels={() => {
                    setSettingsPage("models");
                    setView("settings");
                  }}
                  onSelectApproval={(mode: ApprovalMode) => patchSettings({ approvalMode: mode })}
                  onToggleThinking={(on) => patchSettings({ thinking: on })}
                />
              </div>
            </main>

            {panelOpen && (
              <WorkspacePanel
                platform={boot?.platform ?? "desktop"}
                projectName={projectName}
                activeTab={panelTab}
                planMarkdown=""
                diff={diff}
                browserUrl={browserUrl}
                codeDisplay={{
                  showLineNumbers: settings?.showLineNumbers ?? true,
                  wrapLongLines: settings?.wrapLongLines ?? false,
                  codeFontSize: settings?.codeFontSize ?? 12,
                }}
                browserControlEnabled={settings?.browserControlEnabled ?? true}
                onSelectTab={setPanelTab}
                onNavigate={setBrowserUrl}
                onCollapse={() => setPanelOpen(false)}
                onOpenBrowserSettings={() => {
                  setSettingsPage("browser");
                  setView("settings");
                }}
              />
            )}
          </div>

          {terminalOpen && (
            <TerminalPanel cwd={workspaceRoot} env={env} onClose={() => setTerminalOpen(false)} />
          )}
        </div>
      </div>

      {threadMenu && (
        <ThreadMenu
          threadId={threadMenu.threadId}
          pinned={projects.flatMap((p) => p.threads).find((t) => t.id === threadMenu.threadId)?.pinned ?? false}
          platform={boot?.platform ?? "desktop"}
          workspaceRoot={workspaceRoot}
          position={{ x: threadMenu.x, y: threadMenu.y }}
          onAction={(action) => handleThreadAction(threadMenu.threadId, action)}
          onClose={() => setThreadMenu(null)}
        />
      )}

      {searchOpen && (
        <SearchOverlay
          projects={projects}
          onSelectThread={(_pid, tid) => {
            setActiveThreadId(tid);
            updateThread(tid, { unread: false });
          }}
          onOpenUrl={(url) => {
            setPanelOpen(true);
            setPanelTab("browser");
            setBrowserUrl(url);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}
