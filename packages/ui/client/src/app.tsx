import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  buildLinkedThreadContext,
  dedupeContextRefs,
  formatStoredModelRef,
  formatUserMessageWithContext,
  modelEffortKey,
  parseStoredModelRef,
  resolveModelReasoning,
  locationKey,
  projectLocation,
  touchProjectOpened,
} from "@deyin/host-core/shared";
import type { ModelReasoningMode, WorkspaceLocation } from "@deyin/host-core/shared";
import { streamChat } from "./api/openference.js";
import { AppProviders } from "./providers.js";
import { ApprovalDialog } from "./components/ApprovalDialog.js";
import { AppApprovalDialog } from "./components/AppApprovalDialog.js";
import { AskQuestionDialog, type QuestionItem } from "./components/AskQuestionDialog.js";
import { PlanApprovalDialog } from "./components/PlanApprovalDialog.js";
import { McpAuthCard } from "./components/McpAuthCard.js";
import { BrowserOverlay } from "./components/BrowserOverlay.js";
import { ComputerUseOverlay } from "./components/ComputerUseOverlay.js";
import { ChatView } from "./components/ChatView.js";
import { Composer, type ComposerImage } from "./components/Composer.js";
import { EnvironmentBadge } from "./components/EnvironmentBadge.js";
import { RepoBar } from "./components/RepoBar.js";
import { WorkspaceBar } from "./components/WorkspaceBar.js";
import { resolveVisionModel, visionBlockedMessage } from "./vision.js";
import { SearchOverlay } from "./components/SearchOverlay.js";
import { AutomationsView } from "./components/AutomationsView.js";
import { PlansView } from "./components/PlansView.js";
import { SettingsView } from "./components/SettingsView.js";
import { Sidebar } from "./components/Sidebar.js";
import { ThreadMenu, type ThreadAction } from "./components/ThreadMenu.js";
import { ProjectMenu, type ProjectAction } from "./components/ProjectMenu.js";
import { TopBar } from "./components/TopBar.js";
import { Icon } from "./components/Icon.js";
import { WhatsNewModal } from "./components/WhatsNewModal.js";
import { BetaFeedbackForm } from "./components/BetaFeedbackForm.js";
import { Welcome } from "./components/Welcome.js";
import { ProjectPicker, type ProjectPickerAction } from "./components/project-picker/ProjectPicker.js";
import { NavRail } from "./components/NavRail.js";
import { PanelRail } from "./components/PanelRail.js";
import { WorkspacePanel, type PanelTab } from "./components/WorkspacePanel.js";
import { ReviewBanner } from "./components/ReviewBanner.js";
import { highSeverityFindings } from "./components/SecurityFindingsPanel.js";
import type { FileDiff } from "./diff.js";
import { TaskList } from "./components/TaskList.js";
import { generateThreadTitle } from "./autotitle.js";
import {
  useAgentStateController,
  useAgentRunState,
  useRunningThreadId,
  useSessionTokenStats,
  agentStateStore,
  type AgentSideEffect,
} from "./hooks/useAgentState.js";
import { useThreadHistory } from "./hooks/useThreadHistory.js";
import {
  DEFAULT_THREAD_TITLE,
  deriveTitle,
  emptyThread,
  hydrateProjects,
  newId,
  planFileNameFromTitle,
  planPreviewFromMarkdown,
  planTitleFromMarkdown,
  toChatMessages,
  type Project,
  type Thread,
  type ThreadEvent,
} from "./threads.js";
import type { SettingsPage } from "./components/SettingsView.js";
import type {
 AgentTodoItem,
 ApprovalMode,
 Bootstrap,
 ChatMode,
 ContextUsageSnapshot,
 ContextAttachment,
 LinkedThreadRef,
 PendingChange,
 DeyinSettings,
 EnvInfo,
 ModelInfo,
 ProviderInfo,
 AgentImageInput,
 RepoStateResult,
 UserProfile,
 SecurityFindingsReport,
 GitHubAuthState,
 SshHostInfo,
 WorkspaceState,
} from "@deyin/contract";

/** Right workspace panel sizing. The panel is measured against the content
 *  area (chat + panel, sidebar excluded) and defaults to half of it; the drag
 *  handle stores the chosen fraction so it survives window resizes. */
/* Key is versioned: the first cut allowed dragging down to a 420px chat, and
   widths stored under the old key stick at a width the new floor disallows. */
const PANEL_FRACTION_KEY = "deyin.panelWidthFraction.v2";
const PANEL_DEFAULT_FRACTION = 0.5;
const PANEL_MIN_PX = 320;
/** Floor for the chat column: the chat measure (820px) plus its 40px of side
 *  padding, less the slack the composer can absorb before its row overflows. */
const CHAT_MIN_PX = 560;

function clampFraction(value: number): number {
  return Math.min(0.7, Math.max(0.25, value));
}

const BUILD_PROMPT = "Implement the plan you proposed above. Follow it step by step, keep the todo list current, and report what you changed when done.";

/** Parse the /goal command. Returns the goal text, null for "/goal" with no
 *  text (clear the goal), or undefined when the input is not a /goal command. */
export function matchGoalCommand(raw: string): string | null | undefined {
  const m = /^\/goal\s*([\s\S]*)$/i.exec(raw.trim());
  if (!m) return undefined;
  const text = m[1]!.trim();
  return text.length > 0 ? text : null;
}

type View = "workspace" | "settings" | "upgrade" | "automations";

interface PendingApproval {
  requestId: string;
  toolName: string;
  summary: string;
}

interface PendingQuestion {
  requestId: string;
  title?: string;
  questions: QuestionItem[];
}

interface PendingMcpAuth {
  requestId: string;
  moduleId: string;
  serverName: string;
  message?: string;
}

interface PendingPlanApproval {
  /** Owning thread — actions only render/apply while it is the active thread. */
  threadId: string;
  title: string;
  overview?: string;
  plan: string;
  filePath?: string;
}

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<DeyinSettings | null>(null);
  const [env, setEnv] = useState<EnvInfo | null>(null);

  const [view, setView] = useState<View>("workspace");
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("general");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [projectsHydrated, setProjectsHydrated] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("openference");
  const [selectedModel, setSelectedModel] = useState<string>("GLM-5.2");
  const [composerMode, setComposerMode] = useState<ChatMode>("agent");
  const [input, setInput] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<ContextAttachment[]>([]);
  const [composerLinked, setComposerLinked] = useState<LinkedThreadRef[]>([]);
  /** Images attached to the next message (vision); base64, platform-independent. */
  const [composerImages, setComposerImages] = useState<ComposerImage[]>([]);
  const [pendingReview, setPendingReview] = useState<PendingChange[]>([]);
  const [securityReport, setSecurityReport] = useState<SecurityFindingsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  /** Bumped when the sandbox content changes outside root switches (repo connect). */
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const [showBetaFeedback, setShowBetaFeedback] = useState(false);

  // A queue, not a slot: parallel tool calls raise several permission requests
  // at once, and dropping any of them leaves its tool call awaiting a decision
  // that can never arrive (the run then hangs until the main-process timeout).
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [mcpAuthRequests, setMcpAuthRequests] = useState<PendingMcpAuth[]>([]);
  const [question, setQuestion] = useState<PendingQuestion | null>(null);
  const [planApproval, setPlanApproval] = useState<PendingPlanApproval | null>(null);
  /** Bumped to pull focus into the composer (declining a plan hands the turn back). */
  const [composerFocus, setComposerFocus] = useState(0);
  const sessionTokenStats = useSessionTokenStats();
  const agentRunState = useAgentRunState(activeThreadId);
  const runningThreadId = useRunningThreadId();
  /** Volatile diff contents per file path; thread events only persist the counts. */
  const fileDiffsRef = useRef(new Map<string, FileDiff>());
  /** Follow-up queued while a run is active; drained when the run finishes (per thread). */
  const [queuedPromptByThread, setQueuedPromptByThread] = useState<Record<string, string>>({});
  const queuedPromptByThreadRef = useRef<Record<string, string>>({});
  /** Thread that owns an in-flight plain-chat stream (agent runs use runningThreadId). */
  const plainChatThreadIdRef = useRef<string | null>(null);
  const setQueuedForThread = useCallback((threadId: string, text: string | null) => {
    const next = { ...queuedPromptByThreadRef.current };
    if (text === null || !text.trim()) delete next[threadId];
    else next[threadId] = text;
    queuedPromptByThreadRef.current = next;
    setQueuedPromptByThread(next);
  }, []);
  /** Latest Context Usage snapshot per thread (session-scoped). */
  const [contextByThread, setContextByThread] = useState<Record<string, ContextUsageSnapshot>>({});
  /** Prefix cache session metrics per thread (from optimization events). */
  const [cacheByThread, setCacheByThread] = useState<
    Record<
      string,
      {
        hitRate: number;
        sessionHit: number;
        sessionMiss: number;
        prefixChanged?: boolean;
        changeReasons?: Array<"system" | "tools" | "log_rewrite">;
      }
    >
  >({});
  /** Soft compaction warning shown above the composer. */
  const [compactionNoticeByThread, setCompactionNoticeByThread] = useState<Record<string, string | null>>({});
  /** Interrupt-and-send: start this prompt once the current run's `done` arrives. */
  const pendingSendNowRef = useRef<{ threadId: string; text: string; mode: ChatMode } | null>(null);
  /** After the 3s stop watchdog force-clears, ignore the late `done` event. */
  const stopWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const plainChatAbortRef = useRef<AbortController | null>(null);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const composerModeRef = useRef(composerMode);
  composerModeRef.current = composerMode;
  /** Latest composer model pick — updated synchronously so send() never uses a stale closure. */
  const composerModelRef = useRef({ providerId: selectedProviderId, modelId: selectedModel });
  composerModelRef.current = { providerId: selectedProviderId, modelId: selectedModel };
  const selectModeRef = useRef<(mode: ChatMode) => void>(() => undefined);
  const startAgentRunRef = useRef<(thread: Thread, text: string, mode: ChatMode) => void>(() => undefined);
  const [browserPartition, setBrowserPartition] = useState<string | null>(null);

  const [panelOpen, setPanelOpen] = useState(false);
  /** Icon rail stays visible when the panel content is collapsed. */
  const [panelRail, setPanelRail] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("plan");
  /** Subagent run shown in the Agent panel; null follows the newest run. */
  const [activeSubagentId, setActiveSubagentId] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  /** Opens a path in the Files panel (markdown links, security findings). */
  const [filesOpenRequest, setFilesOpenRequest] = useState<{ path: string; seq: number } | null>(null);
  const [browserUrl, setBrowserUrl] = useState("");
  /** Agent PTY sessions announced via shell-session, keyed for Terminal tab attach. */
  const [agentTerminals, setAgentTerminals] = useState<{ id: string; label: string; threadId: string }[]>([]);

  const openPanelTab = useCallback((tab: PanelTab) => {
    setPanelOpen(true);
    setPanelRail(true);
    setPanelTab(tab);
    setView("workspace");
  }, []);

  const collapsePanel = useCallback(() => {
    setPanelOpen(false);
    setPanelRail(true);
  }, []);

  const dismissPanel = useCallback(() => {
    setPanelOpen(false);
    setPanelRail(false);
  }, []);

  const terminalVisible = panelOpen && panelTab === "terminal";
  const panelVisible = panelOpen || panelRail;

  /* Panel width. The wrap (rail + panel) is laid out in pixels derived from the
     content area's measured width, so the chat column always keeps CHAT_MIN_PX
     no matter how far the handle is dragged or how narrow the window gets. */
  const [panelFraction, setPanelFraction] = useState(() => {
    const stored = Number(localStorage.getItem(PANEL_FRACTION_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampFraction(stored) : PANEL_DEFAULT_FRACTION;
  });
  const columnsRef = useRef<HTMLDivElement | null>(null);
  const [columnsWidth, setColumnsWidth] = useState(0);
  // Callback ref: the columns element unmounts whenever Settings takes over the
  // view, so the observer has to re-attach rather than run once on mount.
  const columnsObserver = useRef<ResizeObserver | null>(null);
  const attachColumns = useCallback((el: HTMLDivElement | null) => {
    columnsObserver.current?.disconnect();
    columnsRef.current = el;
    if (!el) return;
    const observer = new ResizeObserver(() => setColumnsWidth(el.clientWidth));
    observer.observe(el);
    columnsObserver.current = observer;
    setColumnsWidth(el.clientWidth);
  }, []);
  useEffect(() => () => columnsObserver.current?.disconnect(), []);

  const panelWidthPx = useMemo(() => {
    if (columnsWidth <= 0) return null;
    const max = Math.max(PANEL_MIN_PX, columnsWidth - CHAT_MIN_PX);
    return Math.round(Math.min(max, Math.max(PANEL_MIN_PX, panelFraction * columnsWidth)));
  }, [columnsWidth, panelFraction]);

  const storePanelFraction = (fraction: number) => {
    localStorage.setItem(PANEL_FRACTION_KEY, fraction.toFixed(4));
  };

  const startPanelResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const columns = columnsRef.current;
    if (!columns) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const rect = columns.getBoundingClientRect();
    const max = Math.max(PANEL_MIN_PX, rect.width - CHAT_MIN_PX);
    let latest = panelFraction;
    const onMove = (ev: PointerEvent) => {
      const width = Math.min(max, Math.max(PANEL_MIN_PX, rect.right - ev.clientX));
      latest = clampFraction(width / rect.width);
      setPanelFraction(latest);
    };
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing-ew");
      storePanelFraction(latest);
    };
    document.body.classList.add("is-resizing-ew");
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

 const [searchOpen, setSearchOpen] = useState(false);
 const [projectPickerOpen, setProjectPickerOpen] = useState(false);
 const [githubAuth, setGithubAuth] = useState<GitHubAuthState>({ connected: false, login: null });
 const [sshHosts, setSshHosts] = useState<SshHostInfo[]>([]);
 const [desktopCloneBusy, setDesktopCloneBusy] = useState(false);
 const [desktopCloneProgress, setDesktopCloneProgress] = useState<string | null>(null);
 const [workspaceState, setWorkspaceState] = useState<WorkspaceState | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [threadMenu, setThreadMenu] = useState<{ threadId: string; x: number; y: number } | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);

  // Bootstrap: config, profile, models, settings, environment, providers, projects.
  useEffect(() => {
    void (async () => {
      const b = await window.deyin.bootstrap();
      setBoot(b);
      setUser(b.user);
      setWorkspaceRoot(b.workspaceRoot);
      const [list, s, e, provs, projState] = await Promise.all([
        window.deyin.models.list(),
        window.deyin.settings.get(),
        window.deyin.env.detect().catch(() => null),
        window.deyin.providers.list().catch(() => [] as ProviderInfo[]),
        window.deyin.projects.get(),
      ]);
      setModels(list);
      setSettings(s);
      if (s.whatsNewSeenVersion !== b.version) setShowWhatsNew(true);
      setEnv(e);
      setProviders(provs);
      setProjects(hydrateProjects(projState.projects));
      setActiveProjectId(projState.activeProjectId);
      setActiveThreadId(
        projState.activeThreadId ??
          projState.projects.flatMap((p) => p.threads).find((t) => t.events.length > 0)?.id ??
          projState.projects[0]?.threads[0]?.id ??
          null,
      );
      setProjectsHydrated(true);
      // defaultModel persists as "providerId::modelId" (falls back to a bare model id).
      const [savedProvider, savedModel] = s.defaultModel?.includes("::")
        ? (s.defaultModel.split("::") as [string, string])
        : ["openference", s.defaultModel ?? ""];
      const savedProviderRecord = provs.find((p) => p.id === savedProvider);
      const disabledFor = (providerId: string) =>
        new Set(provs.find((p) => p.id === providerId)?.disabledModels ?? []);
      const savedUsable =
        Boolean(savedProviderRecord?.enabled) &&
        Boolean(savedModel) &&
        !disabledFor(savedProvider).has(savedModel) &&
        (savedProvider !== "openference" || list.some((m) => m.id === savedModel));
      if (savedUsable) {
        composerModelRef.current = { providerId: savedProvider, modelId: savedModel };
        setSelectedProviderId(savedProvider);
        setSelectedModel(savedModel);
      } else {
        // Fall back to the first enabled primary model.
        const primaryDisabled = disabledFor("openference");
        const enabled = list.filter((m) => !primaryDisabled.has(m.id));
        if (enabled[0]) {
          setSelectedModel((cur) => {
            const nextId = enabled.some((m) => m.id === cur) ? cur : enabled[0]!.id;
            composerModelRef.current = { providerId: "openference", modelId: nextId };
            return nextId;
          });
        }
      }
    })();
  }, []);

  // Persist the project tree + selection once hydrated (the host owns workspaceRoot,
  // so it is intentionally not part of this patch). Debounced: agent runs fold
  // events into `projects` continuously and a write per change would hammer disk.
  useEffect(() => {
    if (!projectsHydrated) return;
    const timer = setTimeout(() => {
      void window.deyin.projects.set({ projects, activeProjectId, activeThreadId });
    }, 400);
    return () => clearTimeout(timer);
  }, [projectsHydrated, projects, activeProjectId, activeThreadId]);

  /* Web repo workflow: connect a git repo into the session sandbox, work on a
   * dedicated branch, ship with the top-right button. The URL + branch persist
   * locally so a reload re-clones into the fresh sandbox; tokens never persist. */
  const [repoState, setRepoState] = useState<RepoStateResult | null>(null);
  const [repoBusy, setRepoBusy] = useState<"connect" | "ship" | null>(null);
  const [repoProgressLine, setRepoProgressLine] = useState<string | null>(null);
  const [repoConnectOpen, setRepoConnectOpen] = useState(false);

  const connectRepo = useCallback(async (opts: { url: string; token?: string; branch?: string }): Promise<RepoStateResult | null> => {
    if (!window.deyin.repo) return null;
    setRepoBusy("connect");
    try {
      const state = await window.deyin.repo.connect(opts);
      setRepoState(state);
      if (state.branch) {
        try {
          localStorage.setItem("deyin.repo", JSON.stringify({ url: opts.url, branch: state.branch }));
        } catch { /* private mode */ }
      }
      return state;
    } finally {
      setRepoBusy(null);
      setRepoProgressLine(null);
    }
  }, []);

  const shipRepo = useCallback(async (message?: string) => {
    if (!window.deyin.repo) return null;
    setRepoBusy("ship");
    try {
      return await window.deyin.repo.ship(message);
    } finally {
      setRepoBusy(null);
      setRepoProgressLine(null);
    }
  }, []);

  useEffect(() => {
    const repo = window.deyin.repo;
    if (!repo) return;
    return repo.onProgress((e) => {
      setRepoProgressLine(e.line);
      setDesktopCloneProgress(e.line);
    });
  }, []);

  useEffect(() => {
    if (boot?.platform !== "desktop") return;
    void window.deyin.github?.authState().then(setGithubAuth);
    void window.deyin.sshHosts?.list().then(setSshHosts);
    return window.deyin.workspace.onLocationChanged(setWorkspaceState);
  }, [boot?.platform]);

  useEffect(() => {
    if (boot?.workspaceState) setWorkspaceState(boot.workspaceState);
  }, [boot?.workspaceState]);

  // After a (re)connect the sandbox gains files the Files tab has never seen.
  const repoConnected = repoState?.connected === true;
  useEffect(() => {
    if (!repoConnected) return;
    setFilesRefreshKey((k) => k + 1);
  }, [repoConnected]);

  // Web sessions get a fresh sandbox per WebSocket connection: if this browser
  // already carried a repo config, re-clone and resume the stored work branch.
  useEffect(() => {
    if (boot?.platform !== "web" || !workspaceRoot || !window.deyin.repo) return;
    let cancelled = false;
    void (async () => {
      try {
        const state = await window.deyin.repo!.state();
        if (cancelled) return;
        if (state.connected) {
          setRepoState(state);
          return;
        }
        let cfg: { url: string; branch?: string } | null = null;
        try {
          const raw = localStorage.getItem("deyin.repo");
          cfg = raw ? (JSON.parse(raw) as { url: string; branch?: string }) : null;
        } catch { /* ignore */ }
        if (!cfg?.url) return;
        setRepoBusy("connect");
        const next = await window.deyin.repo!.connect({ url: cfg.url, branch: cfg.branch });
        if (!cancelled) setRepoState(next);
      } catch {
        // Offline or the remote moved on — the user can connect manually.
      } finally {
        if (!cancelled) {
          setRepoBusy(null);
          setRepoProgressLine(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boot?.platform, workspaceRoot]);

  useEffect(() => {
    if (settings && composerMode === "delivery") {
      setComposerMode("agent");
    }
  }, [settings, composerMode]);

  // Forward uncaught renderer errors into deyin.log so diagnostics captures them.
  useEffect(() => {
    if (boot?.platform !== "desktop") return;
    const onError = (event: ErrorEvent) => {
      window.deyin.logs.write("error", `window.onerror: ${event.message} at ${event.filename}:${event.lineno}`);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason instanceof Error ? (event.reason.stack ?? event.reason.message) : String(event.reason);
      window.deyin.logs.write("error", `unhandledrejection: ${reason}`);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [boot?.platform]);

  // Keep the active project selection valid as projects come and go.
  useEffect(() => {
    if (projects.length === 0) {
      if (activeProjectId !== null) setActiveProjectId(null);
      return;
    }
    if (!projects.some((p) => p.id === activeProjectId)) setActiveProjectId(projects[0]!.id);
  }, [projects, activeProjectId]);

  const activeThread = useMemo(
    () => projects.flatMap((p) => p.threads).find((t) => t.id === activeThreadId) ?? null,
    [projects, activeThreadId],
  );

  const activeQueuedPrompt =
    activeThreadId !== null ? queuedPromptByThread[activeThreadId]?.trim() ?? null : null;
  const activeThreadStreaming =
    activeThreadId !== null &&
    (runningThreadId === activeThreadId ||
      (streamText !== null && plainChatThreadIdRef.current === activeThreadId));

  const selectedContextLength = useMemo(() => {
    const fromModels = models.find((m) => m.id === selectedModel)?.contextLength;
    if (fromModels) return fromModels;
    const provider = providers.find((p) => p.id === selectedProviderId);
    return provider?.models.find((m) => m.id === selectedModel)?.contextLength;
  }, [models, providers, selectedModel, selectedProviderId]);

  const activeContextSnapshot =
    activeThreadId !== null ? (contextByThread[activeThreadId] ?? null) : null;
  const activeCacheMetrics = activeThreadId !== null ? (cacheByThread[activeThreadId] ?? null) : null;
  const activeCompactionNotice =
    activeThreadId !== null ? (compactionNoticeByThread[activeThreadId] ?? null) : null;

  // Keep baked snapshot window in sync when the user switches models mid-thread.
  useEffect(() => {
    if (!activeThreadId || !selectedContextLength) return;
    setContextByThread((cur) => {
      const snap = cur[activeThreadId];
      if (!snap || snap.contextLength === selectedContextLength) return cur;
      const percent =
        selectedContextLength > 0
          ? Math.min(100, Math.round((snap.usedTokens / selectedContextLength) * 100))
          : 0;
      return {
        ...cur,
        [activeThreadId]: { ...snap, contextLength: selectedContextLength, percent },
      };
    });
  }, [activeThreadId, selectedContextLength]);

  /** Live plan-file card while Plan mode streams markdown into the Plan tab. */
  const livePlanStream = runningThreadId === activeThreadId ? (agentRunState?.planStream ?? null) : null;
  const planArtifact = useMemo(() => {
    if (livePlanStream === null) return null;
    if (!livePlanStream.trim()) return null;
    const title = planTitleFromMarkdown(livePlanStream);
    return {
      title,
      fileName: planFileNameFromTitle(title),
      preview: planPreviewFromMarkdown(livePlanStream),
    };
  }, [livePlanStream]);

  // Restore the thread's composer mode and model when switching tasks.
  useEffect(() => {
    const thread = projects.flatMap((p) => p.threads).find((t) => t.id === activeThreadId);
    if (!thread) return;
    setComposerMode(thread.mode ?? "agent");
    if (thread.model) {
      const providerId = thread.providerId ?? "openference";
      composerModelRef.current = { providerId, modelId: thread.model };
      setSelectedProviderId(providerId);
      setSelectedModel(thread.model);
      return;
    }
    const fromDefault = parseStoredModelRef(settings?.defaultModel ?? null);
    if (fromDefault) {
      composerModelRef.current = fromDefault;
      setSelectedProviderId(fromDefault.providerId);
      setSelectedModel(fromDefault.modelId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  const patchSettings = useCallback((patch: Partial<DeyinSettings>) => {
    setSettings((cur) => (cur ? { ...cur, ...patch } : cur));
    void window.deyin.settings.set(patch).then(setSettings);
  }, []);

  const fallbackToPrimaryModel = useCallback(
    (provs: ProviderInfo[], liveModels: ModelInfo[]) => {
      const primaryDisabled = new Set(provs.find((p) => p.id === "openference")?.disabledModels ?? []);
      const enabled = liveModels.filter((m) => !primaryDisabled.has(m.id));
      setSelectedProviderId("openference");
      if (enabled[0]) {
        const nextId = enabled.some((m) => m.id === selectedModel) ? selectedModel : enabled[0]!.id;
        setSelectedModel(nextId);
        patchSettings({ defaultModel: `openference::${nextId}` });
      }
    },
    [patchSettings, selectedModel],
  );

  const handleProvidersChanged = useCallback(
    (next: ProviderInfo[]) => {
      setProviders(next);
      const current = next.find((p) => p.id === selectedProviderId);
      if (!current?.enabled) fallbackToPrimaryModel(next, models);
    },
    [selectedProviderId, models, fallbackToPrimaryModel],
  );

  /** Mark one onboarding step done (no-op when already done). */
  const markOnboard = useCallback(
    (key: keyof DeyinSettings["onboard"]) => {
      setSettings((cur) => {
        if (!cur || cur.onboard[key]) return cur;
        const onboard = { ...cur.onboard, [key]: true };
        void window.deyin.settings.set({ onboard }).then(setSettings);
        return { ...cur, onboard };
      });
    },
    [],
  );

  // Opening the terminal completes that onboarding step.
  useEffect(() => {
    if (terminalVisible) markOnboard("terminalUsed");
  }, [terminalVisible, markOnboard]);

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

  // Host sandbox/workspace root (web reconnect or desktop setRoot) → App state.
  useEffect(() => {
    return window.deyin.workspace.onRootChanged(setWorkspaceRoot);
  }, []);

  const logout = useCallback(async () => {
    await window.deyin.auth.logout();
    setUser(null);
    // Signing out returns to the Welcome screen, even for API-key users.
    patchSettings({ welcomeDismissed: false });
  }, [patchSettings]);

  /** Find or create the folder-backed project for a workspace location. */
  const ensureFolderProject = useCallback(
    (location: WorkspaceLocation, displayRoot: string): Project => {
      const key = locationKey(location);
      const existing = projects.find((p) => {
        const loc = projectLocation(p);
        return loc ? locationKey(loc) === key : p.root === displayRoot;
      });
      const now = new Date().toISOString();
      if (existing) {
        setProjects((cur) =>
          touchProjectOpened(
            cur.map((p) =>
              p.id === existing.id ? { ...p, location, root: displayRoot, lastOpenedAt: now } : p,
            ),
            existing.id,
          ),
        );
        return { ...existing, location, root: displayRoot, lastOpenedAt: now };
      }
      const project: Project = {
        id: newId("proj"),
        name: displayRoot.split(/[\\/]/).filter(Boolean).pop() ?? displayRoot,
        root: displayRoot,
        location,
        lastOpenedAt: now,
        threads: [],
      };
      setProjects((cur) => [...cur, project]);
      return project;
    },
    [projects],
  );

  const openWorkspaceLocal = useCallback(
    async (root: string) => {
      await window.deyin.workspace.setRoot(root);
      const location: WorkspaceLocation = { kind: "local", root };
      const project = ensureFolderProject(location, root);
      setActiveProjectId(project.id);
      setWorkspaceRoot(root);
      markOnboard("workspaceOpened");
      setProjectPickerOpen(false);
    },
    [ensureFolderProject, markOnboard],
  );

  /** Opens the Cursor-style project picker (desktop) or native picker (fallback). */
  const addProjectFolder = useCallback(async (startIn?: string) => {
    if (boot?.platform === "desktop" && !startIn) {
      setProjectPickerOpen(true);
      return;
    }
    const root = await window.deyin.workspace.openFolder(startIn);
    if (!root) return;
    await openWorkspaceLocal(root);
  }, [boot?.platform, openWorkspaceLocal]);

  const selectProject = useCallback(
    async (projectId: string) => {
      setActiveProjectId(projectId);
      const project = projects.find((p) => p.id === projectId);
      if (!project) return;
      const loc = projectLocation(project);
      if (loc?.kind === "remote") {
        const state = await window.deyin.workspace.connectRemote(loc.hostId, loc.root);
        setWorkspaceState(state);
        if (state.connected) setWorkspaceRoot(state.label);
        return;
      }
      const root = project.root;
      if (root) {
        await window.deyin.workspace.setRoot(root);
        setWorkspaceRoot(root);
      }
    },
    [projects],
  );

  const handleProjectPickerAction = useCallback(
    async (action: ProjectPickerAction) => {
      switch (action.type) {
        case "open-local":
          await openWorkspaceLocal(action.path);
          break;
        case "select-recent": {
          await selectProject(action.projectId);
          setProjectPickerOpen(false);
          break;
        }
        case "connect-remote": {
          const state = await window.deyin.workspace.connectRemote(action.hostId, action.remotePath);
          setWorkspaceState(state);
          if (!state.connected) throw new Error(state.error ?? "SSH connection failed");
          const location: WorkspaceLocation = { kind: "remote", hostId: action.hostId, root: action.remotePath };
          const project = ensureFolderProject(location, state.label);
          setActiveProjectId(project.id);
          setWorkspaceRoot(state.label);
          markOnboard("workspaceOpened");
          setProjectPickerOpen(false);
          break;
        }
        case "clone-url": {
          if (!window.deyin.repo) break;
          setDesktopCloneBusy(true);
          try {
            await window.deyin.repo.connect(action);
            const root = await window.deyin.workspace.getRoot();
            if (root) await openWorkspaceLocal(root);
          } finally {
            setDesktopCloneBusy(false);
            setDesktopCloneProgress(null);
          }
          break;
        }
        case "clone-github": {
          if (!window.deyin.repo) break;
          setDesktopCloneBusy(true);
          try {
            await window.deyin.repo.connect({ url: action.repo.cloneUrl });
            const root = await window.deyin.workspace.getRoot();
            if (root) await openWorkspaceLocal(root);
          } finally {
            setDesktopCloneBusy(false);
          }
          break;
        }
        default: {
          const _exhaustive: never = action;
          return _exhaustive;
        }
      }
    },
    [openWorkspaceLocal, ensureFolderProject, markOnboard, selectProject],
  );

  const removeProject = useCallback(
    async (projectId: string) => {
      const project = projects.find((p) => p.id === projectId);
      if (!project) return;

      for (const thread of project.threads) {
        window.deyin.agent.disposeShell(thread.id);
      }
      const threadIds = new Set(project.threads.map((t) => t.id));
      setAgentTerminals((cur) => cur.filter((t) => !threadIds.has(t.threadId)));

      const remaining = projects.filter((p) => p.id !== projectId);
      setProjects(remaining);

      if (project.threads.some((t) => t.id === activeThreadId)) {
        const next = remaining.flatMap((p) => p.threads).find((t) => !t.archived);
        setActiveThreadId(next?.id ?? null);
      }

      if (activeProjectId === projectId) {
        const next = remaining[0] ?? null;
        setActiveProjectId(next?.id ?? null);
        const nextRoot = next?.root ?? null;
        await window.deyin.workspace.setRoot(nextRoot);
        setWorkspaceRoot(nextRoot);
      }
    },
    [projects, activeProjectId, activeThreadId],
  );

  const handleProjectAction = useCallback(
    (projectId: string, action: ProjectAction) => {
      if (action === "remove") void removeProject(projectId);
    },
    [removeProject],
  );

  const appendEvents = useCallback((threadId: string, events: ThreadEvent[]) => {
    setProjects((cur) =>
      cur.map((project) => ({
        ...project,
        threads: project.threads.map((thread) =>
          thread.id === threadId ? { ...thread, events: [...thread.events, ...events], updatedAt: Date.now() } : thread,
        ),
      })),
    );
  }, []);

  /** Restore the pre-change content of a file card (uses the tracked diff). */
  const undoFileChange = useCallback(
    (name: string) => {
      setDiff((cur) => {
        if (cur && cur.fileName === name) {
          void window.deyin.files
            .write(cur.fileName, cur.before)
            .catch((err: unknown) => console.warn("undo failed", err));
          return null;
        }
        return cur;
      });
    },
    [],
  );

  /**
   * Single agent-event subscription: the useAgentState store owns the run
   * timeline (streaming, tools, folding); app-level reactions — panels,
   * approvals, persistence, queued-prompt restarts — hang off its side effects.
   */
  const handleAgentSideEffect = useCallback(
    (effect: AgentSideEffect) => {
      switch (effect.type) {
        case "shell-session": {
          setAgentTerminals((cur) => {
            if (cur.some((t) => t.id === effect.terminalId)) return cur;
            return [...cur, { id: effect.terminalId, label: effect.label, threadId: effect.threadId }];
          });
          if (settingsRef.current?.revealTerminalOnAgentCommand !== false) {
            openPanelTab("terminal");
          }
          break;
        }
        case "file-change": {
          if (effect.renderable) {
            const fileDiff: FileDiff = { fileName: effect.path, before: effect.before, after: effect.after };
            fileDiffsRef.current.set(effect.path, fileDiff);
            setDiff(fileDiff); // Diff tab always shows the latest change.
          }
          setPendingReview((cur) => cur.filter((c) => c.path !== effect.path || c.status !== "pending"));
          break;
        }
        case "pending-change": {
          setPendingReview((cur) => [...cur.filter((c) => c.id !== effect.change.id), effect.change]);
          const fileDiff: FileDiff = { fileName: effect.change.path, before: effect.change.before, after: effect.change.after };
          fileDiffsRef.current.set(effect.change.path, fileDiff);
          setDiff(fileDiff);
          openPanelTab("diff");
          break;
        }
        case "pending-change-resolved": {
          setPendingReview((cur) => cur.filter((c) => c.id !== effect.changeId));
          break;
        }
        case "goal-updated": {
          setProjects((cur) =>
            cur.map((p) => ({
              ...p,
              threads: p.threads.map((th) =>
                th.id === effect.threadId ? { ...th, goal: effect.goal ?? undefined } : th,
              ),
            })),
          );
          break;
        }
        case "todos": {
          // Persist on the thread: the pinned task list survives run folding
          // and app restarts.
          setProjects((cur) =>
            cur.map((project) => ({
              ...project,
              threads: project.threads.map((th) => (th.id === effect.threadId ? { ...th, todos: effect.todos } : th)),
            })),
          );
          break;
        }
        case "evidence-sign-off": {
          setProjects((cur) =>
            cur.map((project) => ({
              ...project,
              threads: project.threads.map((th) =>
                th.id === effect.threadId
                  ? {
                      ...th,
                      todos: th.todos?.map((todo) =>
                        todo.id === effect.stepId ? { ...todo, signedOff: true, signOffNotes: effect.reviewNotes } : todo,
                      ),
                    }
                  : th,
              ),
            })),
          );
          break;
        }
        case "compaction-notice": {
          setCompactionNoticeByThread((cur) => ({ ...cur, [effect.threadId]: effect.message }));
          break;
        }
        case "cache-stats": {
          setCacheByThread((cur) => ({ ...cur, [effect.threadId]: effect.patch }));
          setContextByThread((cur) => {
            const snap = cur[effect.threadId];
            if (!snap) return cur;
            return { ...cur, [effect.threadId]: { ...snap, cache: effect.patch } };
          });
          break;
        }
        case "context-snapshot": {
          setContextByThread((cur) => {
            const prevCache = cur[effect.threadId]?.cache;
            return {
              ...cur,
              [effect.threadId]: prevCache ? { ...effect.snapshot, cache: prevCache } : effect.snapshot,
            };
          });
          break;
        }
        case "permission-request":
          setApprovals((cur) =>
            cur.some((a) => a.requestId === effect.requestId)
              ? cur
              : [...cur, { requestId: effect.requestId, toolName: effect.toolName, summary: effect.summary }],
          );
          break;
        case "mcp-auth-needed":
          setMcpAuthRequests((cur) =>
            cur.some((r) => r.moduleId === effect.moduleId)
              ? cur
              : [
                  ...cur,
                  {
                    requestId: effect.requestId,
                    moduleId: effect.moduleId,
                    serverName: effect.serverName,
                    message: effect.message,
                  },
                ],
          );
          break;
        case "question-request":
          setQuestion({ requestId: effect.requestId, title: effect.title, questions: effect.questions });
          break;
        case "plan-created": {
          const planTitle = effect.name || planTitleFromMarkdown(effect.plan);
          openPanelTab("plan");
          setPlanApproval({
            threadId: effect.threadId,
            title: planTitle,
            overview: effect.overview,
            plan: effect.plan,
            filePath: effect.filePath,
          });
          setProjects((cur) =>
            cur.map((project) => ({
              ...project,
              threads: project.threads.map((th) =>
                th.id === effect.threadId
                  ? {
                      ...th,
                      planMarkdown: effect.plan,
                      planFilePath: effect.filePath,
                      planApproved: false,
                    }
                  : th,
              ),
            })),
          );
          break;
        }
        case "plan-panel-open":
          openPanelTab("plan");
          break;
        case "mode-changed":
          if (effect.mode) selectModeRef.current(effect.mode);
          break;
        case "run-complete": {
          const { fold } = effect;
          if (stopWatchdogRef.current) {
            clearTimeout(stopWatchdogRef.current);
            stopWatchdogRef.current = null;
          }
          appendEvents(fold.threadId, fold.events);
          if (fold.planMarkdown !== null) {
            setProjects((cur) =>
              cur.map((project) => ({
                ...project,
                threads: project.threads.map((th) =>
                  th.id === fold.threadId
                    ? { ...th, planMarkdown: fold.planMarkdown!, ...(fold.planFinished ? { planApproved: false } : {}) }
                    : th,
                ),
              })),
            );
            if (fold.planFinished) {
              openPanelTab("plan");
            }
          }
          setApprovals([]);
          setMcpAuthRequests([]);
          setQuestion(null);
          markOnboard("taskRun");
          void window.deyin.usage.record({ model: selectedModel, tokens: fold.tokens, newSession: false });

          // Interrupt-and-send takes priority over a queued follow-up.
          const sendNow = pendingSendNowRef.current;
          pendingSendNowRef.current = null;
          if (sendNow) {
            setQueuedForThread(sendNow.threadId, null);
            const thread =
              projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === sendNow.threadId) ?? null;
            if (thread) {
              // Defer so main has removed this thread from `active` before restart.
              queueMicrotask(() => startAgentRunRef.current(thread, sendNow.text, sendNow.mode));
            }
            break;
          }
          const queued = queuedPromptByThreadRef.current[fold.threadId]?.trim();
          if (queued) {
            setQueuedForThread(fold.threadId, null);
            const thread = projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === fold.threadId) ?? null;
            if (thread) {
              const mode = composerModeRef.current;
              queueMicrotask(() => startAgentRunRef.current(thread, queued, mode));
            }
          }
          break;
        }
        default:
          break;
      }
    },
    [appendEvents, markOnboard, openPanelTab, selectedModel, setQueuedForThread],
  );
  useAgentStateController({ onSideEffect: handleAgentSideEffect });

  // Main asks us to surface the Browser tab when agent browser tools need a target.
  useEffect(() => {
    if (!window.deyin.browserControl) return;
    const off = window.deyin.browserControl.onEnsure(() => {
      openPanelTab("browser");
      setBrowserUrl((cur) => cur || "about:blank");
    });
    return off;
  }, []);

  // Per-workspace persistent browser profile partition.
  useEffect(() => {
    if (boot?.platform !== "desktop" || !window.deyin.browserControl) return;
    void window.deyin.browserControl.getPartition().then(setBrowserPartition);
  }, [boot, workspaceRoot]);

  const newTask = useCallback(() => {
    void (async () => {
      // No workspace yet on desktop: the folder picked here becomes the project.
      let createdProject: Project | null = null;
      if (projects.length === 0 && boot?.platform === "desktop") {
        const root = await window.deyin.workspace.openFolder();
        if (root) {
          const location: WorkspaceLocation = { kind: "local", root };
          createdProject = ensureFolderProject(location, root);
          setWorkspaceRoot(root);
        }
      }
      const thread: Thread = { ...emptyThread(), mode: composerMode };
      const createdId = createdProject?.id ?? null;
      setProjects((cur) => {
        if (cur.length === 0) {
          return [{ id: newId("proj"), name: "Workspace", root: null, threads: [thread] }];
        }
        const target =
          createdId && cur.some((p) => p.id === createdId)
            ? createdId
            : cur.some((p) => p.id === activeProjectId)
              ? activeProjectId!
              : cur[0]!.id;
        return cur.map((p) => (p.id === target ? { ...p, threads: [thread, ...p.threads] } : p));
      });
      setActiveThreadId(thread.id);
      setView("workspace");
    })();
  }, [projects, activeProjectId, boot, ensureFolderProject, composerMode]);

  const updateThread = useCallback((threadId: string, patch: Partial<Project["threads"][number]>) => {
    setProjects((cur) =>
      cur.map((project) => ({
        ...project,
        threads: project.threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread)),
      })),
    );
  }, []);

  /** Fork a new task from the conversation prefix ending at `eventIndex`. */
  const forkThreadAtEvent = useCallback((sourceThreadId: string, eventIndex: number) => {
    let forkedId: string | null = null;
    setProjects((cur) =>
      cur.map((project) => {
        const sourceIdx = project.threads.findIndex((t) => t.id === sourceThreadId);
        if (sourceIdx < 0) return project;
        const source = project.threads[sourceIdx]!;
        if (eventIndex < 0 || eventIndex >= source.events.length) return project;
        const forkedThread: Thread = {
          ...emptyThread(),
          title: `${source.title} · fork`,
          mode: source.mode,
          model: source.model,
          providerId: source.providerId,
          previousMode: source.previousMode,
          events: source.events.slice(0, eventIndex + 1),
          planMarkdown: source.planMarkdown,
          planFilePath: source.planFilePath,
          todos: source.todos,
        };
        forkedId = forkedThread.id;
        const threads = [...project.threads];
        threads.splice(sourceIdx + 1, 0, forkedThread);
        return { ...project, threads };
      }),
    );
    if (forkedId) {
      setActiveThreadId(forkedId);
      setView("workspace");
    }
  }, []);

  /** Apply composer model selection to local state, settings default, and the active thread. */
  const applyComposerModel = useCallback(
    (providerId: string, modelId: string, persistDefault = true) => {
      composerModelRef.current = { providerId, modelId };
      setSelectedProviderId(providerId);
      setSelectedModel(modelId);
      if (persistDefault) patchSettings({ defaultModel: formatStoredModelRef(providerId, modelId) });
      if (activeThreadId) updateThread(activeThreadId, { providerId, model: modelId });
    },
    [activeThreadId, patchSettings, updateThread],
  );

  const resolveThreadModel = useCallback(
    (_thread: Thread | null | undefined): { providerId: string; modelId: string } => {
      const live = composerModelRef.current;
      if (live.modelId) return live;
      const fromDefault = parseStoredModelRef(settings?.defaultModel ?? null);
      if (fromDefault) return fromDefault;
      return { providerId: selectedProviderId, modelId: selectedModel };
    },
    [selectedModel, selectedProviderId, settings?.defaultModel],
  );

  const allThreadIds = useMemo(() => projects.flatMap((p) => p.threads.map((t) => t.id)), [projects]);

  /** Focus a thread, following it into its own project when that differs. */
  const selectThread = useCallback(
    (threadId: string, projectId?: string) => {
      const owner = projectId ?? projects.find((p) => p.threads.some((t) => t.id === threadId))?.id;
      if (owner && owner !== activeProjectId) void selectProject(owner);
      setActiveThreadId(threadId);
      updateThread(threadId, { unread: false });
      setView("workspace");
    },
    [projects, activeProjectId, selectProject, updateThread],
  );

  const threadHistory = useThreadHistory(activeThreadId, allThreadIds, selectThread);

  /** Composer mode change: remembered app-wide and stamped on the active thread. */
  const selectMode = useCallback(
    (mode: ChatMode) => {
      setComposerMode(mode);
      if (activeThreadId) updateThread(activeThreadId, { mode });
    },
    [activeThreadId, updateThread],
  );
  selectModeRef.current = selectMode;

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
          window.deyin.agent.disposeShell(threadId);
          setAgentTerminals((cur) => cur.filter((t) => t.threadId !== threadId));
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
          openPanelTab("plan");
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
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setProjectPickerOpen(true);
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
  const [themeVariant, setThemeVariant] = useState<"light" | "dark">("dark");
  useEffect(() => {
    const pref = settings?.theme ?? "dark";
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      let resolved: "light" | "dark" | "warm" = pref === "system" ? (mql.matches ? "dark" : "light") : pref;
      if (resolved === "warm") {
        document.documentElement.dataset.theme = "warm";
        setThemeVariant("dark");
        return;
      }
      document.documentElement.dataset.theme = resolved;
      setThemeVariant(resolved);
    };
    apply();
    if (pref === "system") {
      mql.addEventListener("change", apply);
      return () => mql.removeEventListener("change", apply);
    }
  }, [settings?.theme]);

  useEffect(() => {
    const accent = settings?.themeAccent ?? "blue";
    if (accent && accent !== "blue") document.documentElement.dataset.accent = accent;
    else delete document.documentElement.dataset.accent;
  }, [settings?.themeAccent]);

  // Interface font size: chat and panels scale off this CSS variable.
  useEffect(() => {
    document.documentElement.style.setProperty("--app-font-size", `${settings?.fontSize ?? 14}px`);
  }, [settings?.fontSize]);

  /** Start (or continue) the tool-calling loop for a thread in the given mode. */
  const startAgentRun = useCallback(
    async (
      thread: Thread,
      text: string,
      mode: ChatMode,
      meta?: {
        attachments?: ContextAttachment[];
        linkedThreadIds?: string[];
        /** Vision images attached to this run's user message. */
        images?: AgentImageInput[];
        /** Text-to-image model ids from the catalog (generate_image tool). */
        imageModels?: string[];
        /** Chat models from the catalog that draw inside their completion. */
        imageChatModels?: string[];
        /** Model override (e.g. a vision-capable model routed at send time). */
        model?: string;
        /** Inline notice shown next to the sent message (e.g. vision routing). */
        notice?: string;
        /** Transcript text when it differs from the agent prompt (local vision). */
        displayText?: string;
      },
    ) => {
      const attachments = meta?.attachments ?? [];
      const linkedThreadIds = meta?.linkedThreadIds ?? [];
      const { providerId: runProviderId, modelId: threadModelId } = resolveThreadModel(thread);
      const runModel = meta?.model ?? threadModelId;
      let agentPrompt = text;
      try {
        const refs = dedupeContextRefs(attachments.map((a) => ({ kind: a.kind, path: a.path })));
        const resolved = refs.length ? await window.deyin.context.resolve(refs) : [];
        const allThreads = projectsRef.current.flatMap((p) => p.threads);
        const linkedContext = buildLinkedThreadContext(allThreads, linkedThreadIds);
        agentPrompt = formatUserMessageWithContext(text, resolved, linkedContext);
      } catch {
        agentPrompt = text;
      }

      const isFirstMessage = toChatMessages(thread.events).length === 0;
      appendEvents(thread.id, [
        { kind: "user", text: meta?.displayText ?? text, attachments, linkedThreadIds },
        ...(meta?.notice ? [{ kind: "assistant" as const, text: meta.notice }] : []),
      ]);
      agentStateStore.startRun(thread.id, mode);
      if (isFirstMessage) void window.deyin.usage.record({ model: runModel, tokens: 0, newSession: true });
      if (!thread.model || thread.providerId !== runProviderId) {
        updateThread(thread.id, { model: runModel, providerId: runProviderId });
      }
      window.deyin.agent.start({
        threadId: thread.id,
        prompt: agentPrompt,
        providerId: runProviderId,
        model: runModel,
        ...resolveModelReasoning(settings ?? DEFAULT_SETTINGS, runProviderId, runModel),
        approvalMode: settings?.approvalMode ?? "full-access",
        mode,
        history: toChatMessages(thread.events),
        initialTodos: thread.todos,
        goalText: thread.goal?.status === "active" ? thread.goal.text : undefined,
        images: meta?.images,
        imageModels: meta?.imageModels,
        imageChatModels: meta?.imageChatModels,
      }).catch((err: unknown) => {
        // The host refused the run (e.g. web sandbox not connected): surface it
        // and unlock the composer instead of wedging the thread.
        const message = err instanceof Error ? err.message : String(err);
        agentStateStore.dispatch({ threadId: thread.id, event: { type: "error", message } });
        agentStateStore.dispatch({ threadId: thread.id, event: { type: "done", reason: "aborted", finalText: "" } });
      });
    },
    [appendEvents, resolveThreadModel, settings, updateThread],
  );
  startAgentRunRef.current = startAgentRun;

  useEffect(() => {
    if (!activeThreadId) {
      setPendingReview([]);
      setSecurityReport(null);
      return;
    }
    setComposerAttachments([]);
    setComposerLinked([]);
    setComposerImages([]);
    void window.deyin.review?.list(activeThreadId).then(setPendingReview);
    void window.deyin.security.listFindings(activeThreadId).then(setSecurityReport);
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeThreadId) return;
    return window.deyin.security.onFindingsChanged((threadId) => {
      if (threadId !== activeThreadId) return;
      void window.deyin.security.listFindings(threadId).then(setSecurityReport);
    });
  }, [activeThreadId]);

  const approveReview = useCallback(
    (changeId: string) => {
      if (!activeThreadId) return;
      void window.deyin.review.approve(activeThreadId, changeId);
    },
    [activeThreadId],
  );

  const rejectReview = useCallback(
    (changeId: string) => {
      if (!activeThreadId) return;
      void window.deyin.review.reject(activeThreadId, changeId);
    },
    [activeThreadId],
  );

  const approveAllReview = useCallback(() => {
    if (!activeThreadId) return;
    void window.deyin.review.approveAll(activeThreadId);
  }, [activeThreadId]);

  const rejectAllReview = useCallback(() => {
    if (!activeThreadId) return;
    void window.deyin.review.rejectAll(activeThreadId);
  }, [activeThreadId]);

  /** Abort the in-flight agent (or plain-chat) run and unlock the composer. */
  const stopRun = useCallback(() => {
    const threadId = runningThreadId;
    if (plainChatAbortRef.current) {
      plainChatAbortRef.current.abort();
      plainChatAbortRef.current = null;
      plainChatThreadIdRef.current = null;
      setStreamText(null);
      return;
    }
    if (!threadId) {
      setStreamText(null);
      return;
    }

    window.deyin.agent?.stop(threadId);
    setApprovals([]);
    setMcpAuthRequests([]);
    // Unlock the composer immediately; fold + clear still happen on `done`.
    setStreamText(null);

    if (stopWatchdogRef.current) clearTimeout(stopWatchdogRef.current);
    stopWatchdogRef.current = setTimeout(() => {
      stopWatchdogRef.current = null;
      // Main never emitted `done` — force-fold so the UI cannot stay wedged.
      // A late `done` afterwards must not double-append.
      agentStateStore.setIgnoreNextDone(threadId, true);
      const finished = agentStateStore.forceStop(threadId);
      appendEvents(threadId, finished);
      setApprovals([]);
      setMcpAuthRequests([]);

      const sendNow = pendingSendNowRef.current;
      pendingSendNowRef.current = null;
      if (sendNow) {
        setQueuedForThread(sendNow.threadId, null);
        const thread = projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === sendNow.threadId) ?? null;
        if (thread) startAgentRunRef.current(thread, sendNow.text, sendNow.mode);
        return;
      }
      const queued = queuedPromptByThreadRef.current[threadId]?.trim();
      if (queued) {
        setQueuedForThread(threadId, null);
        const thread = projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === threadId) ?? null;
        if (thread) startAgentRunRef.current(thread, queued, composerModeRef.current);
      }
    }, 3_000);
  }, [runningThreadId, appendEvents, setQueuedForThread]);

  /** Persist manual todo edits and keep the latest timeline todo card in sync. */
  const updatePlanTodos = useCallback(
    (todos: AgentTodoItem[]) => {
      if (!activeThreadId) return;
      const steps = todos.map((t) => ({ text: t.content, done: t.status === "completed", status: t.status }));
      setProjects((cur) =>
        cur.map((project) => ({
          ...project,
          threads: project.threads.map((th) => {
            if (th.id !== activeThreadId) return th;
            const events = [...th.events];
            const index = events.findLastIndex((e) => e.kind === "plan");
            if (index >= 0) events[index] = { kind: "plan", steps };
            else if (steps.length > 0) events.push({ kind: "plan", steps });
            return { ...th, todos, events };
          }),
        })),
      );
    },
    [activeThreadId],
  );

  /** Plan-ready card "Build": switch the thread to agent mode and execute the plan. */
  const buildFromPlan = useCallback(() => {
    if (!activeThread || streamText !== null || runningThreadId !== null) return;
    selectMode("agent");
    const plan = activeThread.planMarkdown?.trim();
    const prompt = plan
      ? `${BUILD_PROMPT}\n\n---\nPlan to implement:\n${plan}\n---`
      : BUILD_PROMPT;
    startAgentRun(activeThread, prompt, "agent");
    setPlanApproval(null);
    if (activeThreadId) updateThread(activeThreadId, { planApproved: true });
  }, [activeThread, activeThreadId, streamText, selectMode, startAgentRun, updateThread]);

  /** The newest plan is written but not built, and no gate is on screen: the plan
   *  card carries Build so dismissing the gate never strands the plan. */
  const planCardBuildable =
    Boolean(activeThread?.planMarkdown?.trim()) &&
    activeThread?.planApproved !== true &&
    !planApproval &&
    streamText === null &&
    runningThreadId !== activeThreadId;

  /** File card "Open": show that change in the Diff tab (when we still hold it). */
  const openFileDiff = useCallback((path: string) => {
    const fileDiff = fileDiffsRef.current.get(path);
    if (fileDiff) setDiff(fileDiff);
    openPanelTab("diff");
  }, [openPanelTab]);

  /** Markdown file refs and security findings: open in the Files panel. */
  const openWorkspaceFile = useCallback((path: string) => {
    setFilesOpenRequest({ path, seq: Date.now() });
    openPanelTab("files");
  }, [openPanelTab]);

  /** First send before any task exists: create the thread instead of dropping
   *  the click — the composer must never silently no-op. */
  const ensureThread = useCallback((): Thread => {
    const newThread: Thread = {
      ...emptyThread(),
      mode: composerMode,
      model: selectedModel,
      providerId: selectedProviderId,
    };
    setProjects((cur) => {
      if (cur.length === 0) {
        return [{ id: newId("proj"), name: "Workspace", root: null, threads: [newThread] }];
      }
      const target = cur.some((p) => p.id === activeProjectId) ? activeProjectId! : cur[0]!.id;
      return cur.map((p) => (p.id === target ? { ...p, threads: [newThread, ...p.threads] } : p));
    });
    setActiveThreadId(newThread.id);
    return newThread;
  }, [activeProjectId, composerMode, selectedModel, selectedProviderId]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !boot) return;

    // /goal is a client-side command: set (or clear, when no text follows) the
    // thread goal instead of messaging the model. Runs before queueing so it
    // also works while a run is active.
    const goal = matchGoalCommand(text);
    if (goal !== undefined) {
      const thread = activeThread ?? ensureThread();
      updateThread(thread.id, {
        goal: goal === null ? undefined : { text: goal, status: "active", setAt: new Date().toISOString() },
      });
      appendEvents(thread.id, [{ kind: "goal-set", text: goal }]);
      setInput("");
      return;
    }

    const thread = activeThread ?? ensureThread();

    // While this thread's run is active, Enter/Send queues the follow-up (Cursor-like).
    const runActiveOnThisThread =
      runningThreadId === thread.id ||
      (streamText !== null && plainChatThreadIdRef.current === thread.id);
    if (runActiveOnThisThread) {
      setQueuedForThread(thread.id, text);
      setInput("");
      return;
    }
    const { providerId: runProviderId, modelId: runModelId } = resolveThreadModel(thread);
    updateThread(thread.id, { model: runModelId, providerId: runProviderId });

    // Route to the selected provider: primary uses the Openference OAuth token,
    // custom providers use their stored base URL + API key.
    const provider = providers.find((p) => p.id === runProviderId);
    let apiBaseUrl = boot.config.apiBaseUrl;
    let token: string | null = null;
    if (!provider || provider.kind === "primary") {
      token = await window.deyin.auth.getAccessToken();
      if (!token) {
        // Keep the draft and say why nothing streamed, then start sign-in.
        appendEvents(thread.id, [
          {
            kind: "assistant",
            text: "You're signed out of Openference. Your message is still in the composer — sign in, then press send again.",
          },
        ]);
        void connect();
        return;
      }
    } else {
      apiBaseUrl = provider.baseUrl ?? apiBaseUrl;
      token = await window.deyin.providers.getKey(provider.id);
      // Local providers (Ollama) need no key; others must have one stored.
      if (!token && !provider.local) {
        appendEvents(thread.id, [
          { kind: "assistant", text: `No API key stored for ${provider.name}. Add one in Settings → Models.` },
        ]);
        return;
      }
    }

    const isFirstMessage = toChatMessages(thread.events).length === 0;
    const history = [...toChatMessages(thread.events), { role: "user" as const, content: text }];

    // Models available for the selected provider, used for image + vision routing.
    const modelList =
      runProviderId === "openference" ? models : (providers.find((p) => p.id === runProviderId)?.models ?? []);
    const imageModels = modelList.filter((m) => m.kind === "image").map((m) => m.id);
    // Chat models that draw: usable by generate_image and able to answer with a
    // picture directly, so they never count as "no image model available".
    const imageChatModels = modelList.filter((m) => m.kind !== "image" && m.imageOutput).map((m) => m.id);
    const isImageRun = modelList.find((m) => m.id === runModelId)?.kind === "image";

    if (isFirstMessage && thread.title === DEFAULT_THREAD_TITLE) {
      const provisional = deriveTitle(text);
      updateThread(thread.id, { title: provisional });
      const threadId = thread.id;
      // Skip the LLM call when the provisional title is already short enough.
      const needsLlmTitle = provisional.endsWith("…") || provisional.split(/\s+/).length > 6;
      if (needsLlmTitle) {
        const titleModel = isImageRun ? (modelList.find((m) => m.kind !== "image")?.id ?? runModelId) : runModelId;
        void generateThreadTitle({ apiBaseUrl, token: token ?? "", model: titleModel, text })
          .then((generated) => {
            if (!generated) return;
            setProjects((cur) =>
              cur.map((project) => ({
                ...project,
                threads: project.threads.map((t) =>
                  t.id === threadId && t.title === provisional && !t.archived
                    ? { ...t, title: generated }
                    : t,
                ),
              })),
            );
          })
          .catch(() => {});
      }
    }

    // Text-to-image model picked in the composer: the prompt goes straight to the
    // images endpoint — these models have no chat completion to stream. The result
    // is stored per thread and embedded with the inline-image directive.
    if (isImageRun) {
      appendEvents(thread.id, [{ kind: "user", text }]);
      setInput("");
      setComposerImages([]);
      setStreamText(`Generating image with ${runModelId}…`);
      try {
        const result = await window.deyin.images.generate({
          threadId: thread.id,
          prompt: text,
          model: runModelId,
          providerId: runProviderId,
        });
        const alt = text.slice(0, 120).replace(/"/g, "'");
        const body = result.images.map((img) => `::deyin-inline-image{file="${img.file}" alt="${alt}"}`).join("\n");
        appendEvents(thread.id, [{ kind: "assistant", text: `${body}\n\n*${runModelId}*` }]);
      } catch (err) {
        appendEvents(thread.id, [
          { kind: "assistant", text: `Image generation failed: ${err instanceof Error ? err.message : String(err)}` },
        ]);
      } finally {
        setStreamText(null);
        void window.deyin.usage.record({ model: runModelId, tokens: 0, newSession: isFirstMessage });
      }
      return;
    }

    // Agent runtime (default): run the tool-calling loop in the host process in
    // the selected composer mode; falls back to the plain text stream when
    // switched off. Images require the agent runtime (vision content parts).
    const images: AgentImageInput[] = composerImages.map(({ mediaType, base64 }) => ({ mediaType, base64 }));
    if ((settings?.agentMode ?? "agent") === "agent" && window.deyin.agent) {
      // Vision: cloud auto-route (opt-in), manual vision model pick, or Local Vision plugin.
      let runModel = runModelId;
      let visionNotice: string | undefined;
      let sendText = text;
      let sendImages = images;
      if (images.length > 0) {
        const autoRoute = settings?.autoVisionRouting ?? false;
        const route = resolveVisionModel(modelList, runModelId, { autoRoute });
        if (route) {
          runModel = route.model;
          if (route.routedTo) visionNotice = `📷 Vision: routed to ${route.routedTo} for this message.`;
        } else if (autoRoute) {
          appendEvents(thread.id, [
            {
              kind: "assistant",
              text: "Your plan doesn't include a vision-capable model yet. Remove the attached images, or pick a vision model from the model menu.",
            },
          ]);
          return;
        } else if (window.deyin.vision?.describeLocal) {
          const local = await window.deyin.vision.describeLocal(images, text);
          if (local.ok && local.descriptions?.length) {
            sendText = local.prompt ?? text;
            sendImages = [];
            visionNotice = `📷 Vision: described locally with ${local.model ?? "moondream"}.`;
          } else {
            appendEvents(thread.id, [{ kind: "assistant", text: local.error ?? visionBlockedMessage({ localVisionAvailable: true }) }]);
            return;
          }
        } else {
          appendEvents(thread.id, [{ kind: "assistant", text: visionBlockedMessage({ localVisionAvailable: Boolean(window.deyin.vision?.describeLocal) }) }]);
          return;
        }
      }
      setInput("");
      const sendMeta = {
        attachments: [...composerAttachments],
        linkedThreadIds: composerLinked.map((l) => l.threadId),
        images: sendImages,
        imageModels,
        imageChatModels,
        model: runModel,
        notice: visionNotice,
        displayText: sendImages.length < images.length ? text : undefined,
      };
      setComposerAttachments([]);
      setComposerLinked([]);
      setComposerImages([]);
      void startAgentRun(thread, sendText, composerMode, sendMeta);
      return;
    }

    if (images.length > 0) {
      appendEvents(thread.id, [
        { kind: "assistant", text: "Plain chat mode doesn't support images. Enable the agent runtime in Settings → General." },
      ]);
      return;
    }

    appendEvents(thread.id, [{ kind: "user", text }]);
    setInput("");
    setStreamText("");

    // Inactivity watchdog: a stalled SSE stream must not wedge the composer
    // (streamText stays non-null, which blocks every later send).
    let timedOut = false;
    const abort = new AbortController();
    plainChatAbortRef.current = abort;
    plainChatThreadIdRef.current = thread.id;
    const armWatchdog = () =>
      setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, 45_000);
    let watchdog = armWatchdog();

    let acc = "";
    let reportedTokens = 0;
    try {
      for await (const delta of streamChat({
        apiBaseUrl,
        token: token ?? "",
        model: runModelId,
        messages: history,
        ...resolveModelReasoning(settings ?? DEFAULT_SETTINGS, runProviderId, runModelId),
        apiFormat: provider?.apiFormat ?? "chat-completions",
        authHeader: provider?.authHeader,
        signal: abort.signal,
        onUsage: (u) => {
          reportedTokens = u.totalTokens;
        },
      })) {
        clearTimeout(watchdog);
        watchdog = armWatchdog();
        acc += delta;
        setStreamText(acc);
      }
      appendEvents(thread.id, [{ kind: "assistant", text: acc }]);
    } catch (err) {
      const msg = timedOut
        ? "Request timed out — no data from the model for 45s. Try again."
        : err instanceof Error
          ? err.message
          : String(err);
      appendEvents(thread.id, [{ kind: "assistant", text: `Request failed: ${msg}` }]);
    } finally {
      clearTimeout(watchdog);
      plainChatAbortRef.current = null;
      plainChatThreadIdRef.current = null;
      setStreamText(null);
      // Real token usage from the provider's final stream frame. Providers that
      // report none record 0 tokens; message/session counts still apply.
      void window.deyin.usage.record({ model: runModelId, tokens: reportedTokens, newSession: isFirstMessage });
    }
  }, [input, streamText, runningThreadId, activeThread, boot, models, providers, settings, composerMode, composerAttachments, composerLinked, composerImages, connect, appendEvents, startAgentRun, updateThread, ensureThread, resolveThreadModel, setQueuedForThread]);

  /** Abort the current run and send immediately (does not wait for natural completion). */
  const sendNow = useCallback(() => {
    const fromInput = input.trim();
    const text = fromInput || queuedPromptByThreadRef.current[activeThread?.id ?? ""]?.trim() || "";
    if (!text || !activeThread) return;

    // /goal never reaches the model — apply it without interrupting the run.
    const goal = matchGoalCommand(text);
    if (goal !== undefined) {
      updateThread(activeThread.id, {
        goal: goal === null ? undefined : { text: goal, status: "active", setAt: new Date().toISOString() },
      });
      appendEvents(activeThread.id, [{ kind: "goal-set", text: goal }]);
      if (fromInput) setInput("");
      else setQueuedForThread(activeThread.id, null);
      return;
    }

    setInput("");
    setQueuedForThread(activeThread.id, null);

    const runActive =
      runningThreadId === activeThread.id ||
      (streamText !== null && plainChatThreadIdRef.current === activeThread.id) ||
      (plainChatAbortRef.current !== null && plainChatThreadIdRef.current === activeThread.id);
    if (!runActive) {
      if ((settings?.agentMode ?? "agent") === "agent" && window.deyin.agent) {
        startAgentRun(activeThread, text, composerMode);
      }
      return;
    }

    pendingSendNowRef.current = { threadId: activeThread.id, text, mode: composerMode };
    stopRun();
  }, [input, activeThread, streamText, runningThreadId, settings, boot, composerMode, startAgentRun, stopRun, appendEvents, updateThread, setQueuedForThread]);

  const clearQueue = useCallback(() => {
    if (activeThreadId) setQueuedForThread(activeThreadId, null);
  }, [activeThreadId, setQueuedForThread]);

  const greetingName = useMemo(() => {
    const first = user?.name?.split(/\s+/)[0];
    return first ? `Hi ${first}` : "Afternoon";
  }, [user]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const projectName =
    activeProject?.name ?? (workspaceRoot ? workspaceRoot.split(/[\\/]/).pop() ?? "Workspace" : "No workspace");

  // Same inputs ChatView uses for its empty branch — drives the centered
  // new-chat layout (logo hero + repo chip + composer).
  const chatEvents = [...(activeThread?.events ?? []), ...(agentRunState?.runEvents ?? [])];
  // Subagent runs in this thread, oldest first — the Agent panel's source list.
  const subagentRuns = chatEvents.filter((e): e is Extract<typeof e, { kind: "subagent" }> => e.kind === "subagent");
  const chatStreamText = agentRunState?.streamText ?? streamText;
  const isChatEmpty = chatEvents.length === 0 && chatStreamText === null;

  const language = settings?.language ?? "en";

  // Signed-out desktop users see the Welcome screen first, unless they chose
  // the API-key path (persisted as settings.welcomeDismissed). While settings
  // load, keep showing Welcome to avoid a workspace flash. (Web signs in via a
  // full-page redirect, so it never sits in this state.)
  if (boot && boot.platform === "desktop" && !user && !settings?.welcomeDismissed) {
    return (
      <AppProviders language={language}>
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
      </AppProviders>
    );
  }

  if (view === "settings" && settings && boot) {
    return (
      <AppProviders language={language}>
        <div className="app">
          <SettingsView
          platform={boot?.platform === "web" ? "web" : "desktop"}
            key={settingsPage}
            initialPage={settingsPage}
            settings={settings}
            user={user}
            busy={busy}
            version={boot.version}
            workspaceRoot={workspaceRoot}
            activeThreadId={activeThreadId}
            liveModels={models}
            providers={providers}
            onProvidersChanged={handleProvidersChanged}
            onChangeSettings={patchSettings}
            onConnect={connect}
            onBack={() => {
              void window.deyin.providers.list().then(handleProvidersChanged);
              setView("workspace");
            }}
            onRefreshLiveModels={async () => {
              setModels(await window.deyin.models.refresh());
            }}
          />
        </div>
      </AppProviders>
    );
  }

  if (view === "upgrade" && boot) {
    return (
      <AppProviders language={language}>
        <PlansView
          platform={boot.platform}
          oauthIssuer={boot.config.oauthIssuer}
          userPlan={user?.plan ?? null}
          onBack={() => setView("workspace")}
          onComplete={() => {
            void window.deyin.usage.account(true);
            setView("workspace");
          }}
        />
      </AppProviders>
    );
  }

  return (
    <AppProviders language={language}>
    <div className="app">
      <TopBar
        platform={boot?.platform ?? "desktop"}
        threadId={activeThreadId}
        threadTitle={activeThread?.title ?? DEFAULT_THREAD_TITLE}
        threadPinned={activeThread?.pinned ?? false}
        projectName={projectName}
        workspaceRoot={workspaceRoot}
        panelOpen={panelVisible}
        terminalOpen={terminalVisible}
        cacheHitRate={activeCacheMetrics?.hitRate ?? null}
        sessionCacheHit={activeCacheMetrics?.sessionHit}
        sessionCacheMiss={activeCacheMetrics?.sessionMiss}
        tokenStats={sessionTokenStats}
        onOpenFolder={() => setProjectPickerOpen(true)}
        onTogglePanel={() => {
          if (panelOpen) collapsePanel();
          else openPanelTab(panelTab);
          setView("workspace");
        }}
        onToggleTerminal={() => {
          if (panelOpen && panelTab === "terminal") collapsePanel();
          else openPanelTab("terminal");
        }}
        onThreadAction={handleThreadAction}
      />
      {workspaceState?.connectionState === "error" && workspaceState.error ? (
        <div className="update-banner update-banner--error" role="alert">
          {workspaceState.error}
        </div>
      ) : null}

      <div className={`app__body${sidebarOpen ? "" : " app__body--nosidebar"}`}>
        {!sidebarOpen && (
          <NavRail
            activeView={view}
            onExpand={() => setSidebarOpen(true)}
            onNewTask={newTask}
            onOpenSearch={() => setSearchOpen(true)}
            onOpenAutomations={() => setView("automations")}
            onOpenCustomize={() => {
              setSettingsPage("appearance");
              setView("settings");
            }}
            onOpenSettings={() => {
              setSettingsPage("general");
              setView("settings");
              window.deyin.telemetry?.record("settings-opened");
            }}
          />
        )}
        {sidebarOpen && (
        <Sidebar
          platform={boot?.platform ?? "desktop"}
          activeView={view}
          projects={projects}
          activeProjectId={activeProjectId}
          activeThreadId={activeThreadId}
          renamingThreadId={renamingThreadId}
          user={user}
          settings={settings ?? DEFAULT_SETTINGS}
          busy={busy}
          connecting={connecting}
          canBack={threadHistory.canBack}
          canForward={threadHistory.canForward}
          onBack={threadHistory.back}
          onForward={threadHistory.forward}
          onCollapse={() => setSidebarOpen(false)}
          onNewTask={newTask}
          onNewProject={() => void addProjectFolder()}
          onSelectProject={(projectId) => {
            void selectProject(projectId);
            setView("workspace");
          }}
          onSelectThread={(pid, tid) => selectThread(tid, pid)}
          onOpenSearch={() => setSearchOpen(true)}
          onThreadContext={(threadId, x, y) => setThreadMenu({ threadId, x, y })}
          onProjectContext={(projectId, x, y) => setProjectMenu({ projectId, x, y })}
          onRenameSubmit={(threadId, title) => {
            updateThread(threadId, { title });
            setRenamingThreadId(null);
          }}
          onConnect={connect}
          onLogout={logout}
          onChangeSettings={patchSettings}
          onOpenUsage={() => {
            setSettingsPage("data");
            setView("settings");
          }}
          onOpenPlans={() => setView("upgrade")}
          onOpenSettings={() => {
            // The gear always lands on General; deep links (Manage models,
            // browser settings) set their page right before switching views.
            setSettingsPage("general");
            setView("settings");
            window.deyin.telemetry?.record("settings-opened");
          }}
          onOpenAutomations={() => setView("automations")}
          onOpenCustomize={() => {
            setSettingsPage("appearance");
            setView("settings");
          }}
        />
        )}

        <div className="app__center">
          {view === "automations" ? (
            <AutomationsView
              workspaceRoot={workspaceRoot}
              providers={providers}
              models={models}
              selectedModel={selectedModel}
              selectedProviderId={selectedProviderId}
              env={env}
              onBack={() => setView("workspace")}
              onOpenSshSettings={() => {
                setSettingsPage("sshHosts");
                setView("settings");
              }}
            />
          ) : (<>
          <div className="app__columns" ref={attachColumns}>
            <main className={`chat-column${isChatEmpty ? " chat-column--empty" : ""}`}>
              <div className="chat-column__bar">
                <EnvironmentBadge
                  env={env}
                  onPickShell={() => openPanelTab("terminal")}
                />
                {boot?.platform === "web" && (
                  <RepoBar
                    repoState={repoState}
                    busy={repoBusy}
                    progressLine={repoProgressLine}
                    connectOpen={repoConnectOpen}
                    onConnectOpenChange={setRepoConnectOpen}
                    onConnect={connectRepo}
                    onShip={shipRepo}
                  />
                )}
              </div>

              <ChatView
                events={chatEvents}
                streamText={chatStreamText}
                streamReasoning={agentRunState?.streamReasoning ?? null}
                greetingName={greetingName}
                threadKey={activeThreadId}
                codeDisplay={{
                  themeLight: settings?.codeThemeLight ?? "GitHub Light",
                  themeDark: settings?.codeThemeDark ?? "GitHub Dark",
                  variant: themeVariant,
                  fontSize: settings?.codeFontSize ?? 12,
                  showLineNumbers: settings?.showLineNumbers ?? true,
                  wrapLongLines: settings?.wrapLongLines ?? false,
                }}
                onOpenFile={openFileDiff}
                onOpenWorkspaceFile={openWorkspaceFile}
                workspaceRoot={workspaceRoot}
                onUndo={undoFileChange}
                onBuild={buildFromPlan}
                canBuildPlan={planCardBuildable}
                planMarkdown={activeThread?.planMarkdown ?? null}
                onOpenPlan={() => {
                  openPanelTab("plan");
                }}
                planArtifact={planArtifact}
                onOpenSubagent={(id) => {
                  setActiveSubagentId(id);
                  openPanelTab("agent");
                }}
                onForkAtEvent={(eventIndex) => {
                  if (activeThreadId) forkThreadAtEvent(activeThreadId, eventIndex);
                }}
                onMessageFeedback={(eventIndex, rating) => {
                  if (!activeThreadId) return;
                  window.deyin.telemetry.record("message-feedback", {
                    rating,
                    threadId: activeThreadId,
                    eventIndex,
                  });
                }}
                onOpenAgentTerminal={
                  agentTerminals.some((t) => t.threadId === activeThreadId)
                    ? () => openPanelTab("terminal")
                    : undefined
                }
                threadTitles={Object.fromEntries((activeProject?.threads ?? []).map((t) => [t.id, t.title]))}
              />

              {(activeThread?.todos?.length ?? 0) > 0 && (
                <div className="chat-column__tasks">
                  <TaskList
                    todos={activeThread!.todos!}
                    running={runningThreadId !== null && runningThreadId === activeThreadId}
                    title={
                      activeThread!.title !== DEFAULT_THREAD_TITLE ? activeThread!.title : undefined
                    }
                  />
                </div>
              )}

              <div className="chat-column__composer">
                {activeThread?.goal?.status === "active" && (
                  <div className="goal-card">
                    <Icon name="flag" size={14} />
                    <span>{activeThread.goal.text}</span>
                  </div>
                )}
                <ReviewBanner
                  changes={pendingReview.filter((c) => c.status === "pending")}
                  onApprove={approveReview}
                  onReject={rejectReview}
                  onApproveAll={approveAllReview}
                  onRejectAll={rejectAllReview}
                  securityFindings={
                    settings?.reviewMode === "on" ? highSeverityFindings(securityReport) : undefined
                  }
                  onOpenSecurity={() => {
                    openPanelTab("security");
                  }}
                />
                {mcpAuthRequests[0] && (
                  <McpAuthCard
                    key={mcpAuthRequests[0].requestId}
                    moduleId={mcpAuthRequests[0].moduleId}
                    serverName={mcpAuthRequests[0].serverName}
                    message={mcpAuthRequests[0].message}
                    onSkip={() =>
                      setMcpAuthRequests((cur) => cur.filter((r) => r.requestId !== mcpAuthRequests[0]!.requestId))
                    }
                  />
                )}
                {approvals[0] && (
                  <ApprovalDialog
                    key={approvals[0].requestId}
                    toolName={approvals[0].toolName}
                    summary={approvals[0].summary}
                    pendingCount={approvals.length}
                    onDecision={(decision) => {
                      const answered = approvals[0]!;
                      window.deyin.agent?.approve(answered.requestId, decision);
                      // "Allow for session" covers every queued request for the
                      // same tool, so the user is not asked N times in a row.
                      const covered =
                        decision === "allow-always"
                          ? approvals.filter((a) => a !== answered && a.toolName === answered.toolName)
                          : [];
                      for (const a of covered) window.deyin.agent?.approve(a.requestId, "allow");
                      setApprovals((cur) =>
                        cur.filter((a) => a.requestId !== answered.requestId && !covered.includes(a)),
                      );
                    }}
                  />
                )}
                {planApproval && planApproval.threadId === activeThreadId && (
                  <PlanApprovalDialog
                    title={planApproval.title}
                    overview={planApproval.overview}
                    onApprove={buildFromPlan}
                    onRevise={() => {
                      setPlanApproval(null);
                      setComposerFocus((n) => n + 1);
                    }}
                    onDismiss={() => setPlanApproval(null)}
                    onEdit={
                      planApproval.filePath
                        ? () => void window.deyin.shell.showItem(planApproval.filePath!)
                        : undefined
                    }
                  />
                )}
                {question && (
                  <AskQuestionDialog
                    title={question.title}
                    questions={question.questions}
                    onSubmit={(answers) => {
                      window.deyin.agent?.answerQuestion(question.requestId, answers);
                      setQuestion(null);
                    }}
                    onCancel={() => {
                      window.deyin.agent?.answerQuestion(question.requestId, {
                        __cancelled: "AskQuestion was cancelled before answers were returned.",
                      });
                      setQuestion(null);
                    }}
                  />
                )}
                <WorkspaceBar
                  platform={boot?.platform === "web" ? "web" : "desktop"}
                  projects={projects}
                  activeProjectId={activeProjectId}
                  projectName={projectName}
                  workspaceRoot={workspaceRoot}
                  homeDir={boot?.homeDir ?? null}
                  onSelectProject={(projectId) => void selectProject(projectId)}
                  onPickFolder={(startIn) => void addProjectFolder(startIn)}
                  wslDistros={boot?.platform === "desktop" ? (env?.wslDistros ?? []) : []}
                  onOpenSshHosts={
                    boot?.platform === "desktop"
                      ? () => {
                          setSettingsPage("sshHosts");
                          setView("settings");
                        }
                      : undefined
                  }
                  onConnectRepo={boot?.platform === "web" ? () => setRepoConnectOpen(true) : undefined}
                  onOpenSourceControl={() => {
                    openPanelTab("git");
                  }}
                />
                <Composer
                  focusSignal={composerFocus}
                  value={input}
                  models={models}
                  selectedModel={selectedModel}
                  approvalMode={settings?.approvalMode ?? "full-access"}
                  mode={(settings?.agentMode ?? "agent") === "agent" ? composerMode : undefined}
                  deliveryModeEnabled={false}
                  thinking={settings?.thinking ?? true}
                  thinkingDefault={settings?.thinking ?? true}
                  modelEfforts={settings?.modelEfforts}
                  canSend={input.trim().length > 0}
                  streaming={activeThreadStreaming}
                  runStatus={runningThreadId === activeThreadId ? agentRunState?.status ?? null : null}
                  queuedPrompt={activeQueuedPrompt}
                  hasEvents={(activeThread?.events.length ?? 0) > 0}
                  providers={providers}
                  selectedProviderId={selectedProviderId}
                  onChange={setInput}
                  onSend={() => void send()}
                  onSteer={() => void send()}
                  onSendNow={sendNow}
                  onClearQueue={clearQueue}
                  onStop={activeThreadStreaming ? stopRun : undefined}
                  onSelectModel={(id) => applyComposerModel(selectedProviderId, id)}
                  onSelectProviderModel={(providerId, modelId) => applyComposerModel(providerId, modelId)}
                  onManageModels={() => {
                    setSettingsPage("models");
                    setView("settings");
                  }}
                  onSelectApproval={(mode: ApprovalMode) => patchSettings({ approvalMode: mode })}
                  onSelectMode={selectMode}
                  onToggleThinking={(on) => patchSettings({ thinking: on })}
                  onSetModelEffort={(providerId, modelId, mode: ModelReasoningMode | undefined) => {
                    const key = modelEffortKey(providerId, modelId);
                    const next = { ...(settings?.modelEfforts ?? {}) };
                    if (mode) next[key] = mode;
                    else delete next[key];
                    patchSettings({ modelEfforts: next });
                  }}
                  contextSnapshot={activeContextSnapshot}
                  contextLength={selectedContextLength}
                  threadKey={activeThreadId}
                  compactionNotice={activeCompactionNotice}
                  attachments={composerAttachments}
                  onAttachmentsChange={setComposerAttachments}
                  images={composerImages}
                  onImagesChange={setComposerImages}
                  linkedThreads={composerLinked}
                  onLinkedThreadsChange={setComposerLinked}
                  threadsForPicker={activeProject?.threads}
                  activeThreadId={activeThreadId}
                  workspaceRoot={workspaceRoot}
                />
              </div>
            </main>

            {panelVisible && (
              <div
                className="wspanel-wrap"
                style={
                  panelOpen && panelWidthPx !== null
                    ? { flex: `0 0 ${panelWidthPx}px`, width: panelWidthPx }
                    : undefined
                }
              >
                {panelOpen && (
                  <div
                    className="wspanel-wrap__resize"
                    onPointerDown={startPanelResize}
                    onDoubleClick={() => {
                      setPanelFraction(PANEL_DEFAULT_FRACTION);
                      storePanelFraction(PANEL_DEFAULT_FRACTION);
                    }}
                    role="separator"
                    aria-orientation="vertical"
                    title="Drag to resize (double-click to reset)"
                  />
                )}
                <PanelRail
                  activeTab={panelTab}
                  collapsed={!panelOpen}
                  diffDot={Boolean(diff)}
                  agentCount={subagentRuns.filter((r) => r.status === "running").length}
                  onSelectTab={openPanelTab}
                  onDismiss={dismissPanel}
                />
                {panelOpen && (
              <WorkspacePanel
                platform={boot?.platform ?? "desktop"}
                projectName={projectName}
                workspaceRoot={workspaceRoot}
                filesRefreshKey={filesRefreshKey}
                activeTab={panelTab}
                planMarkdown={
                  livePlanStream !== null ? livePlanStream : (activeThread?.planMarkdown ?? "")
                }
                planTodos={activeThread?.todos ?? []}
                planTodosRunning={runningThreadId !== null && runningThreadId === activeThreadId}
                canBuildPlan={Boolean(activeThread?.planMarkdown?.trim()) && streamText === null && runningThreadId !== activeThreadId}
                diff={diff}
                browserUrl={browserUrl}
                browserPartition={browserPartition}
                codeDisplay={{
                  showLineNumbers: settings?.showLineNumbers ?? true,
                  wrapLongLines: settings?.wrapLongLines ?? false,
                  codeFontSize: settings?.codeFontSize ?? 12,
                  themeLight: settings?.codeThemeLight ?? "GitHub Light",
                  themeDark: settings?.codeThemeDark ?? "GitHub Dark",
                  variant: themeVariant,
                }}
                browserControlEnabled={settings?.browserControlEnabled ?? true}
                onOpenGitDiff={(d) => {
                  setDiff(d);
                  openPanelTab("diff");
                }}
                onNavigate={setBrowserUrl}
                onCollapse={collapsePanel}
                onOpenFolder={() => void addProjectFolder()}
                onOpenBrowserSettings={() => {
                  setSettingsPage("workspace");
                  setView("settings");
                }}
                onBuildPlan={buildFromPlan}
                onPlanTodosChange={updatePlanTodos}
                pendingReview={pendingReview}
                onApproveChange={approveReview}
                onRejectChange={rejectReview}
                threadId={activeThreadId}
                subagentRuns={subagentRuns}
                selectedSubagentId={activeSubagentId}
                onSelectSubagent={setActiveSubagentId}
                onOpenFile={openWorkspaceFile}
                filesOpenRequest={filesOpenRequest}
                terminalEnv={env}
                terminalDefaultShell={settings?.defaultShell ?? null}
                terminalFontSize={settings?.terminalFontSize ?? 12}
                terminalScrollback={settings?.terminalScrollback ?? 5000}
                terminalCursorStyle={settings?.terminalCursorStyle ?? "bar"}
                terminalCopyOnSelect={settings?.terminalCopyOnSelect ?? true}
                terminalTheme={themeVariant}
                terminalAttachSessions={agentTerminals
                  .filter((t) => t.threadId === activeThreadId)
                  .map((t) => ({ id: t.id, label: t.label }))}
                panelWidth={panelWidthPx}
              />
                )}
              </div>
            )}
          </div>
          </>)}
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

      {projectMenu && (() => {
        const project = projects.find((p) => p.id === projectMenu.projectId);
        if (!project) {
          return null;
        }
        return (
          <ProjectMenu
            projectName={project.name}
            chatCount={project.threads.filter((t) => !t.archived).length}
            platform={boot?.platform ?? "desktop"}
            workspaceRoot={project.root}
            position={{ x: projectMenu.x, y: projectMenu.y }}
            onAction={(action) => handleProjectAction(projectMenu.projectId, action)}
            onClose={() => setProjectMenu(null)}
          />
        );
      })()}

      {searchOpen && (
        <SearchOverlay
          projects={projects}
          onSelectThread={(_pid, tid) => {
            setActiveThreadId(tid);
            updateThread(tid, { unread: false });
            setView("workspace");
          }}
          onOpenUrl={(url) => {
            openPanelTab("browser");
            setBrowserUrl(url);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {boot?.platform === "desktop" && (
        <ProjectPicker
          open={projectPickerOpen}
          platform="desktop"
          projects={projects}
          activeProjectId={activeProjectId}
          homeDir={boot?.homeDir}
          wslDistros={env?.wslDistros}
          sshHosts={sshHosts}
          githubConnected={githubAuth.connected}
          githubLogin={githubAuth.login}
          cloneBusy={desktopCloneBusy}
          cloneProgress={desktopCloneProgress}
          onClose={() => setProjectPickerOpen(false)}
          onAction={handleProjectPickerAction}
          listDirectory={(path) => window.deyin.workspace.listDirectory(path)}
          sshBrowse={(hostId, path) => window.deyin.sshHosts!.browse(hostId, path)}
          githubConnect={async () => {
            const state = await window.deyin.github!.connect();
            setGithubAuth(state);
          }}
          githubListRepos={(query) => window.deyin.github!.listRepos(query)}
        />
      )}

      {showWhatsNew && boot && (
        <WhatsNewModal
          version={boot.version}
          onDismiss={() => {
            setShowWhatsNew(false);
            patchSettings({ whatsNewSeenVersion: boot.version });
          }}
        />
      )}
      {showBetaFeedback && <BetaFeedbackForm onClose={() => setShowBetaFeedback(false)} />}

      <BrowserOverlay />
      <ComputerUseOverlay />
      <AppApprovalDialog />
    </div>
    </AppProviders>
  );
}
