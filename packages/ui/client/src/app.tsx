import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  buildLinkedThreadContext,
  dedupeContextRefs,
  formatStoredModelRef,
  formatUserMessageWithContext,
  modelEffortKey,
  parseStoredModelRef,
  resolveModelReasoning,
  locationKey,
  projectLocation,
  detectImageGenerationIntent,
  imageGenerationBlockedMessage,
  pickImageModelForGeneration,
  imageModelParamsKey,
  resolveImageModelParams,
  detectVideoGenerationIntent,
  videoGenerationBlockedMessage,
  pickVideoModelForGeneration,
  videoModelParamsKey,
  resolveVideoModelParams,
  modelIsVideo,
 touchProjectOpened,
  addBotThread,
  botThreads,
  removeBotThreads,
  visibleProjects,
  BOT_LIMITS,
  canSitInRoom,
  insertMention,
  roomMembers,
  translate,
} from "@deyin/host-core/shared";
import type { ModelReasoningMode, ProductId, SecureFormRequest, WorkspaceLocation, ImageModelParams, VideoModelParams } from "@deyin/host-core/shared";
import { streamChat } from "./api/openference.js";
import { readClipboardText, showContextMenu, writeClipboardText } from "./clipboard.js";
import { AppProviders } from "./providers.js";
import { BotChatHeader } from "./bots/BotChatHeader.js";
import { BotEmptyState } from "./bots/BotEmptyState.js";
import { botComposerChrome } from "./bots/botComposer.js";
import { headerChips, withStarter } from "./bots/botStarters.js";
import { deliverRoutineResult } from "./bots/routineDelivery.js";
import { avatarModelChoices } from "./bots/botAvatarMaker.js";
import { BotCreateDialog } from "./bots/BotCreateDialog.js";
import { BotRoomDialog } from "./bots/BotRoomDialog.js";
import { BotDetailView } from "./bots/BotDetailView.js";
import { BotHome } from "./bots/BotHome.js";
import { BotImportDialog } from "./bots/BotImportDialog.js";
import { BotMarketplace } from "./bots/BotMarketplace.js";
import { BotRosterList } from "./bots/BotRosterList.js";
import { useBots } from "./bots/useBots.js";
import {
  PRODUCTS,
  availableProducts,
  coerceProduct,
  isProductView,
  loadProductPlaces,
  productOfThread,
  productOfView,
  rememberPlace,
  resolveProductSwitch,
  restorableView,
  saveProductPlaces,
  type ProductPlaces,
  type ProductTarget,
  type ProductView,
} from "./products.js";
import { botOfThread, routeMode, threadToOpenForBot } from "./productShell.js";
import { viewAfterPanelOpen, type View } from "./views.js";
import { ApprovalDialog } from "./components/ApprovalDialog.js";
import { AppApprovalDialog } from "./components/AppApprovalDialog.js";
import { OriginApprovalDialog } from "./components/OriginApprovalDialog.js";
import { WorkspaceTrustDialog } from "./components/WorkspaceTrustDialog.js";
import { AskQuestionDialog, type QuestionItem } from "./components/AskQuestionDialog.js";
import { SecureFormDialog } from "./bots/SecureFormDialog.js";
import { PlanApprovalDialog } from "./components/PlanApprovalDialog.js";
import { McpAuthCard } from "./components/McpAuthCard.js";
import { PromptDockSlot } from "./components/PromptDock.js";
import { BrowserOverlay } from "./components/BrowserOverlay.js";
import { ComputerUseOverlay } from "./components/ComputerUseOverlay.js";
import { ComposerDock, type ComposerHandle } from "./components/ComposerDock.js";
import { ChatView } from "./components/ChatView.js";
import { Sidebar } from "./components/Sidebar.js";
import { DraftKeeper, emptyComposerDraft, type ComposerDraftState } from "./composer-draft.js";
import { RepoBar } from "./components/RepoBar.js";
import { WorkspaceBar } from "./components/WorkspaceBar.js";
import {
  countPendingInteractionsForThread,
  pickRunningThreadToStop,
  resolveChatStreamText,
  shouldQueueFollowUp,
  shouldShowGlobalStop,
} from "./composerThreadState.js";
import { describeGoal, goalInputAction, goalPatchFromCommand, transitionGoal } from "./goal-command.js";
import { parseModeCommand } from "./modeCommand.js";
import { DEFAULT_MAX_GOAL_ROUNDS } from "@deyin/agent-core/goal-constants";
import { applyGoalToProjects, isReplacingGoal, type GoalApplyOptions } from "./threadGoal.js";
import { estimateContextFromThreadEvents } from "./contextEstimate.js";
import { SearchOverlay } from "./components/SearchOverlay.js";
import { ConductorView } from "./components/ConductorView.js";
import { ConductorRunStrip } from "./components/ConductorRunStrip.js";
import { ThreadMenu, type ThreadAction } from "./components/ThreadMenu.js";
import { ProjectMenu, type ProjectAction } from "./components/ProjectMenu.js";
import { ConversationHeader } from "./components/ConversationHeader.js";
import { SessionStatusLine } from "./components/SessionStatusLine.js";
import { TopBar } from "./components/TopBar.js";
import { Icon } from "./components/Icon.js";
import { WhatsNewModal } from "./components/WhatsNewModal.js";
import { BetaFeedbackForm } from "./components/BetaFeedbackForm.js";
import { Welcome } from "./components/Welcome.js";
import { ProjectPicker, type ProjectPickerAction } from "./components/project-picker/ProjectPicker.js";
import { NavRail } from "./components/NavRail.js";
import { WorkspacePanel, type PanelTab } from "./components/WorkspacePanel.js";
import { persistChatOnlyPageFromMarkdown } from "./chatOnlyPage.js";
import { ReviewBanner } from "./components/ReviewBanner.js";
import { highSeverityFindings } from "./components/SecurityFindingsPanel.js";
import type { FileDiff } from "./diff.js";
import { TaskList } from "./components/TaskList.js";
import { generateThreadTitle } from "./autotitle.js";
import {
  useAgentStateController,
  useAgentRunState,
  useRunningThreadId,
  useRunningThreadIds,
  useSessionTokenStats,
  agentStateStore,
  type AgentSideEffect,
} from "./hooks/useAgentState.js";
import { mergeRunningThreadIds } from "./threadActivity.js";
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
import { formatFindingFixPrompt, formatAllFindingsFixPrompt } from "./securityFixPrompt.js";
import type { ExtensionTab as ExtensionSettingsTab, SettingsPage } from "./components/SettingsView.js";
import type {
 AgentTodoItem,
 ApprovalMode,
 Bootstrap,
 CapabilityKind,
 ChatMode,
 ContextUsageSnapshot,
 ContextAttachment,
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

/**
 * How long a plain-chat reply may stay silent before the run is aborted so the
 * composer is not wedged. This must not be tighter than the transport's own
 * idle guard (host-core `readWithIdleTimeout`, same constant): a reasoning
 * model on a long conversation can think for minutes before its first visible
 * token, and a shorter UI timer reported those healthy requests as failures
 * (it was 45s). The user can always press Stop sooner.
 */
const PLAIN_CHAT_STALL_MS = DEFAULT_STREAM_IDLE_TIMEOUT_MS;

/**
 * Memo boundaries for the heavy leaves. During an agent run the root
 * re-renders on every structural event (tool start/delta/end); these only need
 * to re-render when their own props actually change, so the props below are
 * all referentially stable (useCallback/useMemo) where they were inline.
 */
const MemoSidebar = memo(Sidebar);
const MemoChatView = memo(ChatView);
const MemoWorkspacePanel = memo(WorkspacePanel);

/**
 * Secondary views (automations, superagent, conductor workflows, plans, settings) are
 * code-split: they are reachable from the sidebar but nobody opens the app to
 * land on them, so their code must not sit in the first-load bundle.
 */
const LazyPluginsView = lazy(() =>
  import("./components/PluginsView.js").then((m) => ({ default: m.PluginsView })),
);
const LazyAutomationsView = lazy(() =>
  import("./components/AutomationsView.js").then((m) => ({ default: m.AutomationsView })),
);
const LazySuperagentPage = lazy(() =>
  import("./components/superagent/SuperagentPage.js").then((m) => ({ default: m.SuperagentPage })),
);
const LazyConductorWorkflowsView = lazy(() =>
  import("./components/ConductorWorkflowsView.js").then((m) => ({ default: m.ConductorWorkflowsView })),
);
const LazyPlansView = lazy(() =>
  import("./components/PlansView.js").then((m) => ({ default: m.PlansView })),
);
const LazySettingsView = lazy(() =>
  import("./components/SettingsView.js").then((m) => ({ default: m.SettingsView })),
);
/** Stable no-op for optional handlers disabled on chat-only hosts. */
const noop = () => {};
/** Stable fallback so `todos ?? EMPTY_TODOS` keeps one identity. */
const EMPTY_TODOS: AgentTodoItem[] = [];
/** Floor for the chat column: the chat measure (820px) plus its 40px of side
 *  padding, less the slack the composer can absorb before its row overflows. */
const CHAT_MIN_PX = 560;

function clampFraction(value: number): number {
  return Math.min(0.7, Math.max(0.25, value));
}

const BUILD_PROMPT = "Implement the plan you proposed above. Follow it step by step, keep the todo list current, and report what you changed when done.";
const CONTINUE_PROMPT = "Continue the task from where you stopped. Check the todo list and workspace state first, then finish the remaining work.";

interface PendingApproval {
  requestId: string;
  toolName: string;
  summary: string;
  /** Why a person is being asked; set for a Bot. */
  reason?: string;
  /** "Always allow" is kept for the Bot, not just this conversation. */
  saved?: boolean;
}

interface PendingQuestion {
  requestId: string;
  title?: string;
  questions: QuestionItem[];
}

interface PendingSecureForm {
  requestId: string;
  form: SecureFormRequest;
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
  const chatOnlyHosted = boot?.chatOnly ?? false;
  const [user, setUser] = useState<UserProfile | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<DeyinSettings | null>(null);
  const [env, setEnv] = useState<EnvInfo | null>(null);

  const [view, setView] = useState<View>("workspace");
  const [selectedWorkflowForEdit, setSelectedWorkflowForEdit] = useState<string | null>(null);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("general");
  const [extensionTab, setExtensionTab] = useState<ExtensionSettingsTab>("mcps");
  const [skillTab, setSkillTab] = useState<CapabilityKind>("skill");
  const [mcpCount, setMcpCount] = useState<number>(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [projectsHydrated, setProjectsHydrated] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const avatarChoices = useMemo(() => avatarModelChoices(models, providers), [models, providers]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("openference");
  const [selectedModel, setSelectedModel] = useState<string>("GLM-5.2");
  const [composerMode, setComposerMode] = useState<ChatMode>("agent");
  const [pendingReview, setPendingReview] = useState<PendingChange[]>([]);
  const [securityReport, setSecurityReport] = useState<SecurityFindingsReport | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Plain-chat (and image-generation) stream text, keyed by thread. A single
   * slot let two chats clobber each other: whichever run finished first cleared
   * the other's stream and unlocked its composer.
   */
  const [plainStreamByThread, setPlainStreamByThread] = useState<Record<string, string>>({});
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  /** Bumped when the sandbox content changes outside root switches (repo connect). */
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const [showBetaFeedback, setShowBetaFeedback] = useState(false);

  // A queue, not a slot: parallel tool calls raise several permission requests
  // at once, and dropping any of them leaves its tool call awaiting a decision
  // that can never arrive (the run then hangs until the main-process timeout).
  // Per-thread pending UI (parallel chats must not share approval/question slots).
  const [approvalsByThread, setApprovalsByThread] = useState<Record<string, PendingApproval[]>>({});
  const [mcpAuthByThread, setMcpAuthByThread] = useState<Record<string, PendingMcpAuth[]>>({});
  const [questionByThread, setQuestionByThread] = useState<Record<string, PendingQuestion[]>>({});
  const [secureFormByThread, setSecureFormByThread] = useState<Record<string, PendingSecureForm[]>>({});
  /**
   * Per-thread composer drafts. Owned here (not in the dock) so they survive
   * view switches that unmount the composer; the dock restores on remount.
   */
  const draftKeeperRef = useRef(new DraftKeeper());
  const draftKeeper = draftKeeperRef.current;
  /** Imperative clear access into the dock's draft (post-send cleanup). */
  const composerRef = useRef<ComposerHandle | null>(null);
  /**
   * Pending plan approvals, keyed by thread: a plan produced in one chat must
   * not replace (or pop over) a plan awaiting approval in another.
   */
  const [planApprovalByThread, setPlanApprovalByThread] = useState<Record<string, PendingPlanApproval>>({});
  const setPlanApprovalForThread = useCallback((threadId: string, approval: PendingPlanApproval | null) => {
    setPlanApprovalByThread((cur) => {
      if (approval === null) {
        if (!(threadId in cur)) return cur;
        const next = { ...cur };
        delete next[threadId];
        return next;
      }
      return { ...cur, [threadId]: approval };
    });
  }, []);
  /** Bumped to pull focus into the composer (declining a plan hands the turn back). */
  const [composerFocus, setComposerFocus] = useState(0);
  /** Add `@handle` to the message being written, and put the cursor back in the box. */
  const mentionInComposer = useCallback((handle: string) => {
    composerRef.current?.updateInput((current) => insertMention(current, handle));
    setComposerFocus((n) => n + 1);
  }, []);
  /** Put a starter from a Bot's empty conversation in the box, and the cursor after it. */
  const startFromStarter = useCallback((text: string) => {
    composerRef.current?.updateInput((current) => withStarter(current, text));
    setComposerFocus((n) => n + 1);
  }, []);
  const sessionTokenStats = useSessionTokenStats();
  const agentRunState = useAgentRunState(activeThreadId);
  const runningThreadId = useRunningThreadId();
  const agentRunningThreadIds = useRunningThreadIds();
  /** Volatile diff contents per file path; thread events only persist the counts. */
  const fileDiffsRef = useRef(new Map<string, FileDiff>());
  /** Follow-up queued while a run is active; drained when the run finishes (per thread). */
  const [queuedPromptByThread, setQueuedPromptByThread] = useState<Record<string, string>>({});
  const queuedPromptByThreadRef = useRef<Record<string, string>>({});
  /** Synchronous mirror of plainStreamByThread, for reads inside send()/stopRun(). */
  const plainStreamRef = useRef<Record<string, string>>({});
  /** Set (or clear, with null) one thread's plain-chat stream text. */
  const setPlainStreamForThread = useCallback((threadId: string, text: string | null) => {
    const next = { ...plainStreamRef.current };
    if (text === null) delete next[threadId];
    else next[threadId] = text;
    plainStreamRef.current = next;
    setPlainStreamByThread(next);
  }, []);
  /** This thread's in-flight plain-chat stream text, or null. */
  const plainStreamFor = useCallback(
    (threadId: string | null): string | null => (threadId ? plainStreamRef.current[threadId] ?? null : null),
    [],
  );
  const setQueuedForThread = useCallback((threadId: string, text: string | null) => {
    const next = { ...queuedPromptByThreadRef.current };
    if (text === null || !text.trim()) delete next[threadId];
    else next[threadId] = text;
    queuedPromptByThreadRef.current = next;
    setQueuedPromptByThread(next);
  }, []);
  const clearPendingForThread = useCallback((threadId: string) => {
    setApprovalsByThread((cur) => {
      if (!(threadId in cur)) return cur;
      const next = { ...cur };
      delete next[threadId];
      return next;
    });
    setMcpAuthByThread((cur) => {
      if (!(threadId in cur)) return cur;
      const next = { ...cur };
      delete next[threadId];
      return next;
    });
    setQuestionByThread((cur) => {
      if (!(threadId in cur)) return cur;
      const next = { ...cur };
      delete next[threadId];
      return next;
    });
    setSecureFormByThread((cur) => {
      if (!(threadId in cur)) return cur;
      const next = { ...cur };
      delete next[threadId];
      return next;
    });
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
        changeReasons?: Array<"system" | "tools" | "prune" | "fold" | "overflow">;
      }
    >
  >({});
  /** Soft compaction warning shown above the composer. */
  const [compactionNoticeByThread, setCompactionNoticeByThread] = useState<Record<string, string | null>>({});
  /** Interrupt-and-send: start this prompt once the current run's `done` arrives (per thread). */
  const pendingSendNowByThreadRef = useRef<Record<string, { text: string; mode: ChatMode }>>({});
  /** Edit-and-resend: truncate at this user event index on the next send. */
  const pendingEditRef = useRef<{ threadId: string; eventIndex: number } | null>(null);
  const [reverting, setReverting] = useState(false);
  /** After the 3s stop watchdog force-clears, ignore the late `done` event. */
  const stopWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** In-flight plain-chat aborts, keyed by thread (parallel chats each own one). */
  const plainChatAbortsRef = useRef(new Map<string, AbortController>());
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const composerModeRef = useRef(composerMode);
  composerModeRef.current = composerMode;
  /** Latest composer model pick — updated synchronously so send() never uses a stale closure. */
  const composerModelRef = useRef({ providerId: selectedProviderId, modelId: selectedModel });
  composerModelRef.current = { providerId: selectedProviderId, modelId: selectedModel };
  const selectModeRef = useRef<(mode: ChatMode) => void>(() => undefined);
  const startAgentRunRef = useRef<(thread: Thread, text: string, mode: ChatMode) => void>(() => undefined);
  const applyGoalToThreadRef = useRef<(thread: Thread, goal: string | null, options?: GoalApplyOptions) => void>(() => undefined);
  /** Runs a `/goal` line (set, replace, status, pause, resume, clear); false when the text is not one. */
  const handleGoalInputRef = useRef<(text: string, thread: Thread, mode: ChatMode) => boolean>(() => false);
  const [browserPartition, setBrowserPartition] = useState<string | null>(null);

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("plan");
  /** Tabs open in the right panel's strip, in the order they were opened. */
  const [panelTabs, setPanelTabs] = useState<PanelTab[]>([]);
  /** The "+" Start page is showing instead of a tool tab. */
  const [panelStart, setPanelStart] = useState(false);
  /** The panel fills the whole content area (chat column hidden). */
  const [panelFullscreen, setPanelFullscreen] = useState(false);
  /** Subagent run shown in the Agent panel; null follows the newest run. */
  const [activeSubagentId, setActiveSubagentId] = useState<string | null>(null);
  const [diffByThread, setDiffByThread] = useState<Record<string, FileDiff>>({});
  /** Opens a path in the Files panel (markdown links, security findings). */
  const [filesOpenRequest, setFilesOpenRequest] = useState<{ path: string; seq: number } | null>(null);
  const [browserUrl, setBrowserUrl] = useState("");
  /** Agent PTY sessions announced via shell-session, keyed for Terminal tab attach. */
  const [agentTerminals, setAgentTerminals] = useState<{ id: string; label: string; threadId: string }[]>([]);

  const setDiffForThread = useCallback((threadId: string, fileDiff: FileDiff | null) => {
    setDiffByThread((cur) => {
      if (fileDiff === null) {
        if (!(threadId in cur)) return cur;
        const next = { ...cur };
        delete next[threadId];
        return next;
      }
      return { ...cur, [threadId]: fileDiff };
    });
  }, []);

  const openPanelTab = useCallback((tab: PanelTab) => {
    const target = chatOnlyHosted ? "preview" : tab;
    setPanelTabs((cur) => (cur.includes(target) ? cur : [...cur, target]));
    setPanelTab(target);
    setPanelStart(false);
    setPanelOpen(true);
    setView(viewAfterPanelOpen);
  }, [chatOnlyHosted]);

  const openPanelStart = useCallback(() => {
    setPanelStart(true);
    setPanelOpen(true);
    setView(viewAfterPanelOpen);
  }, []);

  /** Close one tab; the neighbour takes over, and an empty strip falls back to Start. */
  const closePanelTab = useCallback(
    (tab: PanelTab) => {
      const index = panelTabs.indexOf(tab);
      if (index === -1) return;
      const remaining = panelTabs.filter((t) => t !== tab);
      setPanelTabs(remaining);
      if (panelStart || tab !== panelTab) return;
      const neighbour = remaining[index] ?? remaining[index - 1];
      if (neighbour) setPanelTab(neighbour);
      else setPanelStart(true);
    },
    [panelTabs, panelStart, panelTab],
  );

  const collapsePanel = useCallback(() => {
    setPanelOpen(false);
    setPanelFullscreen(false);
  }, []);

  /** Header toggle: hide the panel, or reopen the last tab (Start when none are open). */
  const togglePanel = useCallback(() => {
    if (panelOpen) collapsePanel();
    else if (panelTabs.length === 0) openPanelStart();
    else if (panelStart) openPanelStart();
    else openPanelTab(panelTab);
  }, [panelOpen, panelTabs.length, panelStart, panelTab, collapsePanel, openPanelStart, openPanelTab]);

  const terminalVisible = panelOpen && !panelStart && panelTab === "terminal";

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
      const hydrated = hydrateProjects(projState.projects);
      // Bot conversations live in a reserved project that is never a workspace, so no workspace fallback may land on it.
      const workspaces = visibleProjects(hydrated);
      const restoredProjectId = workspaces.some((p) => p.id === projState.activeProjectId)
        ? projState.activeProjectId
        : (workspaces[0]?.id ?? null);
      setProjects(hydrated);
      setActiveProjectId(restoredProjectId);
      const restoredProduct = coerceProduct(s.activeProduct, b.chatOnly ?? false);
      const savedThread = hydrated.flatMap((p) => p.threads).find((t) => t.id === projState.activeThreadId);
      const productTarget = resolveProductSwitch(restoredProduct, getPlaces(), hydrated, restoredProjectId);
      setActiveThreadId(
        savedThread && productOfThread(savedThread) === restoredProduct
          ? savedThread.id
          : restoredProduct === "code"
            ? (workspaces.flatMap((p) => p.threads).find((t) => t.events.length > 0)?.id ??
              workspaces[0]?.threads[0]?.id ??
              null)
            : productTarget.threadId,
      );
      if (restoredProduct !== "code") {
        setView(restorableView(productTarget.view));
        setComposerMode(productTarget.composerMode);
      }
      productRestoredRef.current = true;
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
    const workspaces = visibleProjects(projects);
    if (workspaces.length === 0) {
      if (activeProjectId !== null) setActiveProjectId(null);
      return;
    }
    if (!workspaces.some((p) => p.id === activeProjectId)) setActiveProjectId(workspaces[0]!.id);
  }, [projects, activeProjectId]);

  const activeThread = useMemo(
    () => projects.flatMap((p) => p.threads).find((t) => t.id === activeThreadId) ?? null,
    [projects, activeThreadId],
  );

  // Products: Code, Bot and Conductor are separate shells. A product view says which one is open; a shared
  // view (Settings, Plugins, ...) keeps the one the user was in.
  const { bots, ready: botsReady, layout: botLayout, loadError: botsLoadError, actions: botActions } = useBots();
  // A Bot's routines are automations it owns; the host exposes them only in the desktop app.
  const botRoutines = useMemo(
    () => (window.deyin?.automations ? { api: window.deyin.automations, defaults: { model: selectedModel, providerId: selectedProviderId } } : undefined),
    [selectedModel, selectedProviderId],
  );
  const [botCreateOpen, setBotCreateOpen] = useState(false);
  const [botRoomOpen, setBotRoomOpen] = useState(false);
  // Adding a Bot someone shared: `text` is what a link brought, when one did.
  const [botImport, setBotImport] = useState<{ text?: string } | null>(null);
  // What a Bot's routines run on when it is added with some: the model chosen in the chat box.
  const botModelDefaults = useMemo(() => ({ model: selectedModel, providerId: selectedProviderId }), [selectedModel, selectedProviderId]);
  const [botDetailId, setBotDetailId] = useState<string | null>(null);
  // The last place the user was inside a product. A shared page (Settings, Plans, Superagent) belongs to whichever
  // product they came from, and going back from it returns there instead of to Deyin Code.
  const [lastProductView, setLastProductView] = useState<ProductView>("workspace");
  const product = productOfView(view, productOfView(lastProductView, "code"));
  const sharedBackView = restorableView(lastProductView);
  useEffect(() => {
    if (isProductView(view)) setLastProductView(view);
  }, [view]);
  const shellProducts = useMemo(() => availableProducts(chatOnlyHosted), [chatOnlyHosted]);
  const activeBot = product === "bot" ? botOfThread(activeThread, bots) : null;
  /** The other Bots shown as chips above a primary Bot's or a room's chat: the ones `@` reaches from there. */
  const botChips = useMemo(
    () => (activeBot ? headerChips(activeBot, activeBot.kind === "room" ? roomMembers(activeBot, new Map(bots.map((b) => [b.id, b]))) : [], bots) : []),
    [activeBot, bots],
  );
  /** The Bot the person talks to first, when they have one. */
  const primaryBot = useMemo(() => bots.find((b) => b.isPrimary && !b.archived && b.kind === "agent"), [bots]);
  /** With no primary Bot, the next one made is it: the store promotes the oldest active Bot, so the dialog says so. */
  const nextBotIsPrimary = primaryBot === undefined;
  /** Where the user last was in each product, kept so switching back lands there. */
  const placesRef = useRef<ProductPlaces | null>(null);
  const getPlaces = useCallback((): ProductPlaces => (placesRef.current ??= loadProductPlaces(localStorage)), []);
  /** False until the saved product has been applied, so startup never overwrites it with the default. */
  const productRestoredRef = useRef(false);

  const activeQueuedPrompt =
    activeThreadId !== null ? queuedPromptByThread[activeThreadId]?.trim() ?? null : null;
  /** The active thread's own plain-chat stream text — never another thread's. */
  const streamText = activeThreadId !== null ? plainStreamByThread[activeThreadId] ?? null : null;
  const planApproval = activeThreadId !== null ? planApprovalByThread[activeThreadId] ?? null : null;
  const activeThreadStreaming =
    activeThreadId !== null && ((agentRunState?.running ?? false) || streamText !== null);
  const showGlobalStop = shouldShowGlobalStop({
    runningThreadId,
    isActiveThreadStreaming: activeThreadStreaming,
  });
  const activeDiff = activeThreadId !== null ? (diffByThread[activeThreadId] ?? null) : null;
  const pendingByThread = useMemo(() => {
    const ids = new Set([
      ...Object.keys(approvalsByThread),
      ...Object.keys(mcpAuthByThread),
      ...Object.keys(questionByThread),
      ...Object.keys(secureFormByThread),
    ]);
    const pending = { approvalsByThread, questionByThread, mcpAuthByThread, secureFormByThread };
    const out: Record<string, number> = {};
    for (const id of ids) {
      const count = countPendingInteractionsForThread(id, pending);
      if (count > 0) out[id] = count;
    }
    return out;
  }, [approvalsByThread, mcpAuthByThread, questionByThread, secureFormByThread]);
  /** Sessions with work in flight, for the sidebar spinner: agent runs plus plain chat and media streams. */
  const runningThreadIds = useMemo(
    () => mergeRunningThreadIds(agentRunningThreadIds, plainStreamByThread),
    [agentRunningThreadIds, plainStreamByThread],
  );
  const activeApprovals = activeThreadId !== null ? (approvalsByThread[activeThreadId] ?? []) : [];
  const activeMcpAuthRequests = activeThreadId !== null ? (mcpAuthByThread[activeThreadId] ?? []) : [];
  const activeQuestion =
    activeThreadId !== null ? (questionByThread[activeThreadId]?.[0] ?? null) : null;
  const activeSecureForm =
    activeThreadId !== null ? (secureFormByThread[activeThreadId]?.[0] ?? null) : null;

  const selectedContextLength = useMemo(() => {
    const fromModels = models.find((m) => m.id === selectedModel)?.contextLength;
    if (fromModels) return fromModels;
    const provider = providers.find((p) => p.id === selectedProviderId);
    return provider?.models.find((m) => m.id === selectedModel)?.contextLength;
  }, [models, providers, selectedModel, selectedProviderId]);

  const selectedModelKind = useMemo(() => {
    const entry = models.find((m) => m.id === selectedModel);
    if (entry?.kind === "video" || modelIsVideo(selectedModel, entry?.kind)) return "video" as const;
    return entry?.kind;
  }, [models, selectedModel]);

  const savedImageParams = useMemo(() => {
    const key = imageModelParamsKey(selectedProviderId, selectedModel);
    return settings?.imageModelParams?.[key];
  }, [selectedProviderId, selectedModel, settings?.imageModelParams]);

  const savedVideoParams = useMemo(() => {
    const key = videoModelParamsKey(selectedProviderId, selectedModel);
    return settings?.videoModelParams?.[key];
  }, [selectedProviderId, selectedModel, settings?.videoModelParams]);

  const activeContextSnapshot = useMemo((): ContextUsageSnapshot | null => {
    if (activeThreadId === null) return null;
    const fromThread = contextByThread[activeThreadId];
    if (fromThread) return fromThread;
    const fromRun = agentRunState?.contextSnapshot ?? null;
    if (fromRun) return fromRun;
    const events = activeThread?.events ?? [];
    if (events.length === 0 || !selectedContextLength) return null;
    return estimateContextFromThreadEvents(events, selectedContextLength);
  }, [
    activeThread?.events,
    activeThreadId,
    agentRunState?.contextSnapshot,
    contextByThread,
    selectedContextLength,
  ]);
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
  const livePlanStream = agentRunState?.running ? (agentRunState.planStream ?? null) : null;
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

  useEffect(() => {
    setActiveSubagentId(null);
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
  const [connectError, setConnectError] = useState<string | null>(null);

  const refreshSession = useCallback(async () => {
 const profile = await window.deyin.auth.getUser();
 setUser(profile);
 if (profile) {
 setModels(await window.deyin.models.list());
 // Provider status (e.g. the Openference plan card) derives from auth
 // state on the main side; re-pull so the UI reflects it immediately.
 setProviders(await window.deyin.providers.list());
 }
 }, []);

  const connect = useCallback(async () => {
    setConnectError(null);
    setBusy(true);
    setConnecting(true);
    try {
      const profile = await window.deyin.auth.connect();
      if (profile) {
 setUser(profile);
 setModels(await window.deyin.models.list());
 setProviders(await window.deyin.providers.list());
 setConnecting(false);
 }
    } catch (err) {
      console.error("Connect failed", err);
      setConnectError(err instanceof Error ? err.message : "Sign-in failed. Try again.");
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
        if (state.connected) setWorkspaceRoot(state.location?.kind === "remote" ? state.location.root : state.label);
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
          setWorkspaceRoot(state.location?.kind === "remote" ? state.location.root : state.label);
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
        if (agentStateStore.isRunning(thread.id)) {
          window.deyin.agent?.stop(thread.id);
        }
        const plainAbort = plainChatAbortsRef.current.get(thread.id);
        if (plainAbort) {
          plainAbort.abort();
          plainChatAbortsRef.current.delete(thread.id);
        }
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

  const updateThread = useCallback((threadId: string, patch: Partial<Project["threads"][number]>) => {
    setProjects((cur) =>
      cur.map((project) => ({
        ...project,
        threads: project.threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread)),
      })),
    );
  }, []);

  /** A chat or generation finished: flag it for the sidebar dot unless the user is looking at it. */
  const markUnreadIfAway = useCallback(
    (threadId: string) => {
      if (threadId !== activeThreadIdRef.current) updateThread(threadId, { unread: true });
    },
    [updateThread],
  );

  const registerChatOnlyPage = useCallback(
    async (threadId: string, markdown: string) => {
      if (!chatOnlyHosted) return;
      const artifact = await persistChatOnlyPageFromMarkdown(threadId, markdown);
      if (!artifact) return;
      updateThread(threadId, { pageTitle: artifact.title, pageFileName: artifact.fileName });
      appendEvents(threadId, [
        { kind: "page-ready", title: artifact.title, fileName: artifact.fileName, preview: artifact.preview },
      ]);
      if (threadId === activeThreadIdRef.current) openPanelTab("preview");
    },
    [appendEvents, chatOnlyHosted, openPanelTab, updateThread],
  );

  const showRevertToast = useCallback((result: import("@deyin/contract").RevertResult) => {
    if (!activeThreadIdRef.current) return;
    const msg = result.ok
      ? `Reverted ${result.revertedPaths.length} file(s)`
      : result.error ?? "Revert failed — no files were changed";
    setCompactionNoticeByThread((cur) => ({ ...cur, [activeThreadIdRef.current!]: msg }));
    setTimeout(() => {
      setCompactionNoticeByThread((cur) => {
        if (cur[activeThreadIdRef.current!] !== msg) return cur;
        const next = { ...cur };
        delete next[activeThreadIdRef.current!];
        return next;
      });
    }, 4000);
  }, []);

  const undoFileChange = useCallback(
    async (path: string, checkpointId: string) => {
      if (!activeThreadId || !window.deyin.checkpoints) return;
      setReverting(true);
      try {
        const result = await window.deyin.checkpoints.revertFile(activeThreadId, checkpointId, path);
        showRevertToast(result);
        if (result.ok) setDiffForThread(activeThreadId, null);
      } finally {
        setReverting(false);
      }
    },
    [activeThreadId, setDiffForThread, showRevertToast],
  );

  const revertRunChanges = useCallback(
    async (checkpointId: string) => {
      if (!activeThreadId || !window.deyin.checkpoints) return;
      setReverting(true);
      try {
        const result = await window.deyin.checkpoints.revertRun(activeThreadId, checkpointId);
        showRevertToast(result);
        if (result.ok) setDiffForThread(activeThreadId, null);
      } finally {
        setReverting(false);
      }
    },
    [activeThreadId, setDiffForThread, showRevertToast],
  );

  const editMessageAtEvent = useCallback(
    (eventIndex: number) => {
      if (!activeThreadId || chatOnlyHosted) return;
      const thread = projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === activeThreadId);
      const event = thread?.events[eventIndex];
      if (!event || event.kind !== "user") return;
      pendingEditRef.current = { threadId: activeThreadId, eventIndex };
      composerRef.current?.setDraft({
        input: event.text,
        attachments: event.attachments ?? [],
        linked: (event.linkedThreadIds ?? []).map((threadId) => ({
          threadId,
          title:
            projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === threadId)?.title ?? "thread",
        })),
      });
      setComposerFocus((n) => n + 1);
    },
    [activeThreadId, chatOnlyHosted],
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
          // Opt-in only: a shell call must not steal the right panel from what
          // the user is reading. The session is registered above either way, so
          // it is waiting in the Terminal tab whenever they choose to look.
          // Never yank the panel for a run in a chat the user is not looking at.
          if (
            settingsRef.current?.revealTerminalOnAgentCommand === true &&
            effect.threadId === activeThreadIdRef.current
          ) {
            openPanelTab("terminal");
          }
          break;
        }
        case "file-change": {
          // pendingReview and the Diff tab show the *active* thread. A background
          // run's edits are re-read from the host when that thread is opened.
          const isActive = effect.threadId === activeThreadIdRef.current;
          if (effect.renderable) {
            const fileDiff: FileDiff = { fileName: effect.path, before: effect.before, after: effect.after };
            fileDiffsRef.current.set(effect.path, fileDiff);
            setDiffForThread(effect.threadId, fileDiff);
            // Diff tab follows the active thread only.
          }
          if (isActive) {
            setPendingReview((cur) => cur.filter((c) => c.path !== effect.path || c.status !== "pending"));
          }
          break;
        }
        case "pending-change": {
          const fileDiff: FileDiff = { fileName: effect.change.path, before: effect.change.before, after: effect.change.after };
          fileDiffsRef.current.set(effect.change.path, fileDiff);
          setDiffForThread(effect.threadId, fileDiff);
          if (effect.threadId !== activeThreadIdRef.current) break;
          setPendingReview((cur) => [...cur.filter((c) => c.id !== effect.change.id), effect.change]);
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
              threads: p.threads.map((th) => {
                if (th.id !== effect.threadId) return th;
                const incoming = effect.goal ?? undefined;
                // A stopped run can still report on a goal the user has since replaced or
                // cleared; goals are only ever created by the user, never by a host update.
                if (incoming && (!th.goal || (incoming.id && th.goal.id && incoming.id !== th.goal.id))) return th;
                // Updates are partial (no id on some hosts): keep what the card already knows.
                const goal = incoming ? { ...th.goal, ...incoming } : undefined;
                // The agent restated the objective: the "Goal set" note follows the new wording.
                const restated = incoming?.rewrittenFrom;
                if (incoming && restated !== undefined && restated !== incoming.text) {
                  const at = th.events.findLastIndex((e) => e.kind === "goal-set" && e.text === restated);
                  const prior = at >= 0 ? th.events[at] : undefined;
                  if (prior?.kind === "goal-set") {
                    const events = [...th.events];
                    events[at] = { ...prior, text: incoming.text };
                    return { ...th, goal, events };
                  }
                }
                return { ...th, goal };
              }),
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
          if (effect.threadId !== activeThreadIdRef.current) {
            updateThread(effect.threadId, { unread: true });
          }
          setApprovalsByThread((cur) => {
            const list = cur[effect.threadId] ?? [];
            if (list.some((a) => a.requestId === effect.requestId)) return cur;
            return {
              ...cur,
              [effect.threadId]: [
                ...list,
                {
                  requestId: effect.requestId,
                  toolName: effect.toolName,
                  summary: effect.summary,
                  ...(effect.reason ? { reason: effect.reason } : {}),
                  ...(effect.saved ? { saved: true } : {}),
                },
              ],
            };
          });
          break;
        case "mcp-auth-needed":
          setMcpAuthByThread((cur) => {
            const list = cur[effect.threadId] ?? [];
            if (list.some((r) => r.moduleId === effect.moduleId)) return cur;
            return {
              ...cur,
              [effect.threadId]: [
                ...list,
                {
                  requestId: effect.requestId,
                  moduleId: effect.moduleId,
                  serverName: effect.serverName,
                  message: effect.message,
                },
              ],
            };
          });
          break;
        case "secure-form-request":
          if (effect.threadId !== activeThreadIdRef.current) {
            updateThread(effect.threadId, { unread: true });
          }
          setSecureFormByThread((cur) => {
            const list = cur[effect.threadId] ?? [];
            if (list.some((f) => f.requestId === effect.requestId)) return cur;
            return { ...cur, [effect.threadId]: [...list, { requestId: effect.requestId, form: effect.form }] };
          });
          break;
        case "question-request":
          if (effect.threadId !== activeThreadIdRef.current) {
            updateThread(effect.threadId, { unread: true });
          }
          setQuestionByThread((cur) => {
            const list = cur[effect.threadId] ?? [];
            if (list.some((q) => q.requestId === effect.requestId)) return cur;
            return {
              ...cur,
              [effect.threadId]: [
                ...list,
                {
                  requestId: effect.requestId,
                  title: effect.title,
                  questions: effect.questions,
                },
              ],
            };
          });
          break;
        case "plan-created": {
          const planTitle = effect.name || planTitleFromMarkdown(effect.plan);
          if (effect.threadId === activeThreadIdRef.current) openPanelTab("plan");
          setPlanApprovalForThread(effect.threadId, {
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
        case "page-created":
          if (effect.threadId === activeThreadIdRef.current) openPanelTab("preview");
          setProjects((cur) =>
            cur.map((project) => ({
              ...project,
              threads: project.threads.map((th) =>
                th.id === effect.threadId
                  ? {
                      ...th,
                      pageTitle: effect.title,
                      pageFileName: effect.fileName,
                    }
                  : th,
              ),
            })),
          );
          break;
        case "plan-panel-open":
          if (effect.threadId === activeThreadIdRef.current) openPanelTab("plan");
          break;
        case "page-panel-open":
          if (effect.threadId === activeThreadIdRef.current) openPanelTab("preview");
          break;
        case "mode-changed":
          updateThread(effect.threadId, { mode: effect.mode });
          if (effect.threadId === activeThreadIdRef.current) {
            selectModeRef.current(effect.mode);
          }
          break;
        case "run-complete": {
          const { fold } = effect;
          if (fold.threadId !== activeThreadIdRef.current) {
            updateThread(fold.threadId, { unread: true });
          }
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
            if (fold.planFinished && fold.threadId === activeThreadIdRef.current) {
              openPanelTab("plan");
            }
          }
          clearPendingForThread(fold.threadId);
          markOnboard("taskRun");
          void window.deyin.usage.record({ model: selectedModel, tokens: fold.tokens, newSession: false });

          // Interrupt-and-send takes priority over a queued follow-up.
          const sendNow = pendingSendNowByThreadRef.current[fold.threadId];
          if (sendNow) {
            const nextPending = { ...pendingSendNowByThreadRef.current };
            delete nextPending[fold.threadId];
            pendingSendNowByThreadRef.current = nextPending;
            setQueuedForThread(fold.threadId, null);
            const thread =
              projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === fold.threadId) ?? null;
            if (thread) {
              // Defer: the store marks the run finished only after this handler returns, and
              // main must have removed this thread from `active` before a restart. A goal
              // command run now would still see the old run and interrupt it a second time.
              queueMicrotask(() => {
                if (!handleGoalInputRef.current(sendNow.text, thread, sendNow.mode)) {
                  startAgentRunRef.current(thread, sendNow.text, sendNow.mode);
                }
              });
            }
            break;
          }
          const queued = queuedPromptByThreadRef.current[fold.threadId]?.trim();
          if (queued) {
            setQueuedForThread(fold.threadId, null);
            const thread = projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === fold.threadId) ?? null;
            if (thread) {
              const mode = thread.mode ?? "agent";
              queueMicrotask(() => {
                if (!handleGoalInputRef.current(queued, thread, mode)) {
                  startAgentRunRef.current(thread, queued, mode);
                }
              });
            }
          }
          break;
        }
        default:
          break;
      }
    },
    [appendEvents, markOnboard, openPanelTab, selectedModel, setQueuedForThread, clearPendingForThread, setPlanApprovalForThread, updateThread, setDiffForThread],
  );
  useAgentStateController({ onSideEffect: handleAgentSideEffect });

  // Main asks us to surface the Browser tab when agent browser tools need a target.
  useEffect(() => {
    if (!window.deyin.browserControl) return;
    const offEnsure = window.deyin.browserControl.onEnsure(() => {
      openPanelTab("browser");
      setBrowserUrl((cur) => cur || "about:blank");
    });
    const offTab = window.deyin.browserControl.onTabCommand?.((cmd) => {
      openPanelTab("browser");
      if (cmd.action === "open" && cmd.url) {
        setBrowserUrl(cmd.url);
      } else if (cmd.action === "close") {
        setBrowserUrl("");
      }
    });
    return () => {
      offEnsure();
      offTab?.();
    };
  }, [openPanelTab]);

  // Per-workspace persistent browser profile partition.
  useEffect(() => {
    if (boot?.platform !== "desktop" || !window.deyin.browserControl) return;
    void window.deyin.browserControl.getPartition().then(setBrowserPartition);
  }, [boot, workspaceRoot]);

  const automationWorkspaces = useMemo(
    () =>
      projects.flatMap((p) =>
        p.root && (!p.location || p.location.kind === "local") ? [{ name: p.name, root: p.root }] : [],
      ),
    [projects],
  );

  const newTask = useCallback((modeOverride?: ChatMode, viewOverride?: View, projectIdOverride?: string, initialDraft?: string) => {
    void (async () => {
      // No workspace yet on desktop: the folder picked here becomes the project.
      let createdProject: Project | null = null;
      if (visibleProjects(projects).length === 0 && boot?.platform === "desktop") {
        const root = await window.deyin.workspace.openFolder();
        if (root) {
          const location: WorkspaceLocation = { kind: "local", root };
          createdProject = ensureFolderProject(location, root);
          setWorkspaceRoot(root);
        }
      }
      const effectiveMode = modeOverride ?? composerMode;
      const thread: Thread = { ...emptyThread(), mode: effectiveMode };
      const createdId = createdProject?.id ?? null;
      setProjects((cur) => {
        const workspaces = visibleProjects(cur);
        if (workspaces.length === 0) {
          // The first workspace goes before the Bots project so it stays first in the list.
          const first: Project = { id: newId("proj"), name: chatOnlyHosted || boot?.platform === "web" ? "Chat" : "Workspace", root: null, threads: [thread] };
          return [first, ...cur];
        }
        const target =
          createdId && workspaces.some((p) => p.id === createdId)
            ? createdId
            : projectIdOverride && workspaces.some((p) => p.id === projectIdOverride)
              ? projectIdOverride
              : workspaces.some((p) => p.id === activeProjectId)
                ? activeProjectId!
                : workspaces[0]!.id;
        return cur.map((p) => (p.id === target ? { ...p, threads: [thread, ...p.threads] } : p));
      });
      if (initialDraft) draftKeeper.save(thread.id, { ...emptyComposerDraft(), input: initialDraft });
      setActiveThreadId(thread.id);
      setView(viewOverride ?? (effectiveMode === "conductor" ? "conductor" : "workspace"));
      if (modeOverride) setComposerMode(modeOverride);
    })();
  }, [projects, activeProjectId, activeThreadId, boot, ensureFolderProject, composerMode, chatOnlyHosted, draftKeeper]);

  const applyGoalToThread = useCallback(
    (thread: Thread, goal: string | null, options?: GoalApplyOptions) => {
      let createdProjectId: string | undefined;
      setProjects((cur) => {
        const result = applyGoalToProjects(
          cur,
          thread,
          goal,
          activeProjectId,
          chatOnlyHosted || boot?.platform === "web" ? "Chat" : "Workspace",
          options,
        );
        createdProjectId = result.createdProjectId;
        return result.projects;
      });
      setActiveThreadId(thread.id);
      if (createdProjectId) setActiveProjectId(createdProjectId);
    },
    [activeProjectId],
  );
  applyGoalToThreadRef.current = applyGoalToThread;

  /** Pause or resume the goal loop in place, keeping the objective text. */
  const setGoalStatus = useCallback((threadId: string, status: "active" | "paused") => {
    setProjects((cur) =>
      cur.map((project) => ({
        ...project,
        threads: project.threads.map((t) => {
          if (t.id !== threadId || !t.goal) return t;
          return {
            ...t,
            goal: transitionGoal(t.goal, status === "active" ? "resume" : "pause"),
            updatedAt: Date.now(),
          };
        }),
      })),
    );
  }, []);

  /** Clear the goal on a thread. */
  const clearGoal = useCallback((threadId: string) => {
    setProjects((cur) =>
      cur.map((project) => ({
        ...project,
        threads: project.threads.map((t) => {
          if (t.id !== threadId) return t;
          return { ...t, goal: undefined, updatedAt: Date.now() };
        }),
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
  }, [activeThreadId]);

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
    (thread: Thread | null | undefined): { providerId: string; modelId: string } => {
      if (thread && thread.id !== activeThreadIdRef.current && thread.model) {
        return { providerId: thread.providerId ?? "openference", modelId: thread.model };
      }
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
      const targetThread = projects.flatMap((p) => p.threads).find((t) => t.id === threadId);
      const threadProduct = targetThread ? productOfThread(targetThread) : "code";
      // A Bot's conversation is not in a workspace, so opening it must not switch the workspace.
      if (owner && owner !== activeProjectId && threadProduct !== "bot") void selectProject(owner);
      setActiveThreadId(threadId);
      updateThread(threadId, { unread: false });
      const home = PRODUCTS[threadProduct].homeView;
      if (view !== home) setView(home);
    },
    [projects, activeProjectId, selectProject, updateThread, view],
  );

  /** Make a product's shell current: its view, its conversation, and the composer mode that goes with it. */
  const applyProductTarget = useCallback(
    (target: ProductTarget) => {
      // The detail page and the marketplace are visits, not places to return to; land on the Bot's chat or home.
      setView(restorableView(target.view));
      setActiveThreadId(target.threadId);
      // Only Code and Conductor have workspaces; a Bot's conversation belongs to no folder.
      if (target.product !== "bot" && target.projectId && target.projectId !== activeProjectId) void selectProject(target.projectId);
      setComposerMode(target.composerMode);
    },
    [activeProjectId, selectProject],
  );

  const selectProduct = useCallback(
    (to: ProductId) => {
      // Picking the product you are in still leaves a shared page (Settings, Plugins) for the product's own view.
      if (to === product && isProductView(view)) return;
      applyProductTarget(resolveProductSwitch(to, getPlaces(), projectsRef.current, activeProjectId));
    },
    [product, view, activeProjectId, applyProductTarget, getPlaces],
  );

  const createBotConversation = useCallback((botId: string) => {
    const thread: Thread = { ...emptyThread(), mode: "agent", botId };
    setProjects((cur) => addBotThread(cur, thread));
    setActiveThreadId(thread.id);
  }, []);

  /** Open a Bot: its newest conversation, or a fresh one when it has none yet. */
  const openBot = useCallback(
    (botId: string) => {
      const existing = threadToOpenForBot(projectsRef.current, botId);
      if (existing) {
        setActiveThreadId(existing.id);
        updateThread(existing.id, { unread: false });
      } else {
        createBotConversation(botId);
      }
      setComposerMode("agent");
      setView("bot");
    },
    [createBotConversation, updateThread],
  );

  const openBotDetails = useCallback((botId: string) => {
    setBotDetailId(botId);
    setView("botDetail");
  }, []);

  // A shared Bot's link opened the app (or arrived while it is open): show what it carries and ask. Nothing is added by the link.
  useEffect(() => {
    const templates = window.deyin?.botTemplates;
    if (!templates) return;
    let current = true;
    const show = (link: string): void => {
      if (current) setBotImport({ text: link });
    };
    void templates
      .takeLink()
      .then((link) => {
        if (link) show(link);
      })
      .catch(() => undefined);
    const stop = templates.onLink((link) => {
      show(link);
      // The window has it now; it must not be shown again the next time the app asks.
      void templates.takeLink().catch(() => undefined);
    });
    return () => {
      current = false;
      stop();
    };
  }, []);

  const handleBotDeleted = useCallback(
    (botId: string) => {
      const wasOpen = activeThread?.botId === botId;
      setProjects((cur) => removeBotThreads(cur, botId));
      if (wasOpen) setActiveThreadId(null);
      setBotDetailId((cur) => (cur === botId ? null : cur));
      setView("bot");
    },
    [activeThread?.botId],
  );

  /** What Code and Conductor list: every project except the one reserved for Bot conversations. */
  const workspaceProjects = useMemo(() => visibleProjects(projects), [projects]);

  /** The open Bot's conversations, listed under its roster row. */
  const activeBotConversations = useMemo(
    () => (activeBot ? botThreads(projects, activeBot.id).map((t) => ({ id: t.id, title: t.title })) : []),
    [projects, activeBot],
  );
  const selectBotConversation = useCallback((threadId: string) => selectThread(threadId), [selectThread]);

  const botSidebarBody = useMemo(
    () => (
      <BotRosterList
        bots={bots}
        layout={botLayout}
        ready={botsReady}
        loadError={botsLoadError}
        activeBotId={activeBot?.id ?? null}
        conversations={activeBotConversations}
        activeThreadId={activeThreadId}
        onSelectConversation={selectBotConversation}
        actions={botActions}
        onSelect={openBot}
        onDetails={openBotDetails}
        onDeleted={handleBotDeleted}
        onNewRoom={() => setBotRoomOpen(true)}
        {...(window.deyin?.botTemplates ? { onBrowse: () => setView("botMarket") } : {})}
      />
    ),
    [bots, botLayout, botsReady, botsLoadError, activeBot?.id, activeBotConversations, activeThreadId, selectBotConversation, botActions, openBot, openBotDetails, handleBotDeleted],
  );

  // Remember where the user was in this product so switching back lands there; only product-owned views are kept.
  useEffect(() => {
    if (!projectsHydrated || !isProductView(view)) return;
    const owned = activeThread && productOfThread(activeThread) === product ? activeThread : null;
    const projectId = owned ? (projects.find((p) => p.threads.some((t) => t.id === owned.id))?.id ?? null) : null;
    const next = rememberPlace(getPlaces(), product, { view, projectId, threadId: owned?.id ?? null });
    if (next !== placesRef.current) {
      placesRef.current = next;
      saveProductPlaces(localStorage, next);
    }
  }, [projectsHydrated, view, product, activeThread, projects, getPlaces]);

  // The open product is a setting, so the app reopens in it. Not before the saved one has been applied.
  useEffect(() => {
    if (!projectsHydrated || !productRestoredRef.current || !settings || settings.activeProduct === product) return;
    patchSettings({ activeProduct: product });
  }, [projectsHydrated, product, settings, patchSettings]);

  /** The sidebar's primary action: a session, a Bot or a run, whichever the open product makes. */
  const newItem = useCallback(() => {
    switch (product) {
      case "code":
      case "conductor":
        newTask();
        return;
      case "bot":
        setBotCreateOpen(true);
        return;
      default: {
        const unhandled: never = product;
        throw new Error(`Unhandled product: ${String(unhandled)}`);
      }
    }
  }, [product, newTask]);

  const threadHistory = useThreadHistory(activeThreadId, allThreadIds, selectThread);

  /** Composer mode change: remembered app-wide and stamped on the active thread. */
  const selectMode = useCallback(
    (mode: ChatMode) => {
      // Conductor is its own product: choosing its mode moves there, and any other mode moves back to Code.
      // Conductor runs pipelines and external agent CLIs through a local shell and git, which a chat-only
      // host does not have, so it refuses the switch.
      const route = routeMode(mode, product, !chatOnlyHosted);
      switch (route.kind) {
        case "ignore":
          return;
        case "set-mode":
          setComposerMode(route.mode);
          if (activeThreadId) updateThread(activeThreadId, { mode: route.mode });
          return;
        case "switch-product": {
          const target = resolveProductSwitch(route.product, getPlaces(), projectsRef.current, activeProjectId);
          applyProductTarget({ ...target, composerMode: route.mode });
          if (target.threadId) updateThread(target.threadId, { mode: route.mode });
          return;
        }
        default: {
          const unhandled: never = route;
          throw new Error(`Unhandled mode route: ${JSON.stringify(unhandled)}`);
        }
      }
    },
    [product, activeThreadId, activeProjectId, updateThread, chatOnlyHosted, applyProductTarget, getPlaces],
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
          if (agentStateStore.isRunning(threadId)) {
            window.deyin.agent?.stop(threadId);
          }
          const plainAbort = plainChatAbortsRef.current.get(threadId);
          if (plainAbort) {
            plainAbort.abort();
            plainChatAbortsRef.current.delete(threadId);
          }
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

  // Global shortcuts: Ctrl/Cmd+K search, Ctrl/Cmd+N new task, Ctrl/Cmd+B toggle sidebar, Ctrl+` / Ctrl/Cmd+J toggle terminal.
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
        newItem();
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
      if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") ||
        (e.ctrlKey && e.key === "`")
      ) {
        e.preventDefault();
        if (terminalVisible) collapsePanel();
        else openPanelTab("terminal");
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        selectMode(composerMode === "conductor" ? "agent" : "conductor");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newItem, terminalVisible, collapsePanel, openPanelTab, composerMode, selectMode]);

  // Right-click menu for text the renderer owns.
  //
  // Electron draws no menu of its own: a packaged build has no application menu
  // and the web content is not an editable field, so a right-click used to do
  // nothing at all except inside a textarea. This adds the standard edit menu
  // for an editable field or a selection, and deliberately steps aside when a
  // component already drew its own menu (a thread row, a message card) — those
  // call preventDefault themselves before the event reaches here.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      // A component that wants its own menu has already handled the event.
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // The terminal panel owns its own menu; it needs canvas-aware actions.
      if (target.closest(".terminal-panel")) return;

      const field = target.closest<HTMLInputElement | HTMLTextAreaElement | HTMLElement>(
        "input, textarea, [contenteditable='true']",
      );
      const isField =
        !!field && !(field as HTMLInputElement).disabled && !(field as HTMLInputElement).readOnly;

      const selection = window.getSelection?.()?.toString() ?? "";
      // No native menu exists in the browser host, so leave the platform alone.
      if (!window.deyin?.contextMenu) return;

      // Both an editable field and a plain-text selection get the menu. Plain
      // content with nothing selected still gets one — Copy simply reports
      // itself unavailable — because a right-click that does nothing at all
      // reads as a broken app, not as "there is nothing to copy here".
      e.preventDefault();
      void showContextMenu({
        kind: "text",
        editable: isField,
        hasSelection: isField
          ? selection.length > 0 ||
            (!!field &&
              (field as HTMLInputElement).selectionStart !== (field as HTMLInputElement).selectionEnd)
          : selection.length > 0,
        x: e.clientX,
        y: e.clientY,
      }).then((command) => {
        if (!command) return;
        // execCommand still drives the field's own undo stack, which keeps a
        // paste or cut reversible with Ctrl+Z. The menu stole focus, so the
        // field is re-focused before acting on it.
        if (command === "copy" && !isField) {
          if (selection) void writeClipboardText(selection);
          return;
        }
        if (command === "selectAll") {
          if (isField) {
            (field as HTMLInputElement).focus();
            (field as HTMLInputElement).select();
            return;
          }
          const range = document.createRange();
          const container = target.closest(".chat, .markdown, .ui-flat-card") ?? document.body;
          range.selectNodeContents(container);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
          return;
        }
        if (!isField) return;
        (field as HTMLInputElement).focus();
        if (command === "paste") {
          void readClipboardText().then((text) => {
            if (text) document.execCommand("insertText", false, text);
          });
          return;
        }
        document.execCommand(command);
      });
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Interface theme: apply the setting to <html data-theme>; "system" follows the OS.
  const [themeVariant, setThemeVariant] = useState<"light" | "dark" | "obsidian">("dark");
  useEffect(() => {
    const pref = settings?.theme ?? "dark";
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved: "light" | "dark" | "warm" | "obsidian" | "reference" = pref === "system" ? (mql.matches ? "dark" : "light") : pref;
      if (resolved === "warm" || resolved === "obsidian" || resolved === "reference") {
        document.documentElement.dataset.theme = resolved;
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

  // Active MCP server count: queries the daemon on mount.
  useEffect(() => {
    if (window.deyin?.mcp?.list) {
      window.deyin.mcp
        .list()
        .then((servers) => setMcpCount(servers.filter((s) => s.enabled).length))
        .catch(() => setMcpCount(0));
    }
  }, []);

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
        /** Transcript text when it differs from the agent prompt (local vision). */
        displayText?: string;
        /** The prompt is a freshly typed /goal objective: the host restates it before work starts. */
        goalRewrite?: boolean;
      },
    ) => {
      const attachments = meta?.attachments ?? [];
      const linkedThreadIds = meta?.linkedThreadIds ?? [];
      const { providerId: runProviderId, modelId: threadModelId } = resolveThreadModel(thread);
      const runModel = meta?.model ?? threadModelId;
      let agentPrompt = text;
      if (agentStateStore.isRunning(thread.id)) return;
      const liveThread =
        projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === thread.id) ?? thread;
      const isFirstMessage = toChatMessages(liveThread.events).length === 0;
      appendEvents(thread.id, [
        { kind: "user", text: meta?.displayText ?? text, attachments, linkedThreadIds },
      ]);
      const runId = agentStateStore.startRun(thread.id, mode);
      try {
        const refs = dedupeContextRefs(attachments.map((a) => ({ kind: a.kind, path: a.path })));
        const resolved = refs.length ? await window.deyin.context.resolve(refs) : [];
        const allThreads = projectsRef.current.flatMap((p) => p.threads);
        const linkedContext = buildLinkedThreadContext(allThreads, linkedThreadIds);
        agentPrompt = formatUserMessageWithContext(text, resolved, linkedContext);
      } catch {
        agentPrompt = text;
      }
      if (isFirstMessage) void window.deyin.usage.record({ model: runModel, tokens: 0, newSession: true });
      if (!thread.model || thread.providerId !== runProviderId) {
        updateThread(thread.id, { model: runModel, providerId: runProviderId });
      }
      const historyThread =
        projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === thread.id) ?? liveThread;
      window.deyin.agent.start({
        threadId: thread.id,
        runId,
        prompt: agentPrompt,
        providerId: runProviderId,
        model: runModel,
        contextLength: selectedContextLength,
        ...resolveModelReasoning(settings ?? DEFAULT_SETTINGS, runProviderId, runModel),
        approvalMode: settings?.approvalMode ?? "full-access",
        mode,
        ...(thread.botId ? { botId: thread.botId } : {}),
        history: toChatMessages(historyThread.events),
        initialTodos: thread.todos,
        goalText: thread.goal?.status === "active" ? thread.goal.text : undefined,
        ...(thread.goal?.id ? { goalId: thread.goal.id } : {}),
        ...(thread.goal?.maxRounds !== undefined ? { goalMaxRounds: thread.goal.maxRounds } : {}),
        ...(meta?.goalRewrite && thread.goal?.status === "active" ? { goalRewrite: true } : {}),
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
    [appendEvents, resolveThreadModel, selectedContextLength, settings, updateThread],
  );
  startAgentRunRef.current = startAgentRun;

  useEffect(() => {
    if (!activeThreadId) {
      setPendingReview([]);
      setSecurityReport(null);
      return;
    }
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
    const isActiveComposerBusy = streamText !== null;
    const threadId = pickRunningThreadToStop({
      activeThreadId,
      runningThreadId,
      isActiveThreadRunning: agentRunState?.running ?? false,
      isActiveComposerBusy,
    });
    // Stop only *this* chat's plain-chat stream; other threads keep running.
    const activeAbort = activeThreadId ? plainChatAbortsRef.current.get(activeThreadId) : undefined;
    if (activeAbort && activeThreadId) {
      activeAbort.abort();
      plainChatAbortsRef.current.delete(activeThreadId);
      setPlainStreamForThread(activeThreadId, null);
      return;
    }
    if (!threadId) {
      if (activeThreadId) setPlainStreamForThread(activeThreadId, null);
      return;
    }

    window.deyin.agent?.stop(threadId);
    clearPendingForThread(threadId);
    setPlainStreamForThread(threadId, null);

    if (stopWatchdogRef.current) clearTimeout(stopWatchdogRef.current);
    stopWatchdogRef.current = setTimeout(() => {
      stopWatchdogRef.current = null;
      // Main never emitted `done` — force-fold so the UI cannot stay wedged.
      // A late `done` afterwards must not double-append.
      agentStateStore.setIgnoreNextDone(threadId, true);
      const finished = agentStateStore.forceStop(threadId);
      appendEvents(threadId, finished);
      clearPendingForThread(threadId);

      const sendNow = pendingSendNowByThreadRef.current[threadId];
      if (sendNow) {
        const nextPending = { ...pendingSendNowByThreadRef.current };
        delete nextPending[threadId];
        pendingSendNowByThreadRef.current = nextPending;
        setQueuedForThread(threadId, null);
        const thread = projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === threadId) ?? null;
        if (thread && !handleGoalInputRef.current(sendNow.text, thread, sendNow.mode)) {
          startAgentRunRef.current(thread, sendNow.text, sendNow.mode);
        }
        return;
      }
      const queued = queuedPromptByThreadRef.current[threadId]?.trim();
      if (queued) {
        setQueuedForThread(threadId, null);
        const thread = projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === threadId) ?? null;
        if (thread && !handleGoalInputRef.current(queued, thread, thread.mode ?? "agent")) {
          startAgentRunRef.current(thread, queued, thread.mode ?? "agent");
        }
      }
    }, 3_000);
  }, [
    activeThreadId,
    runningThreadId,
    agentRunState?.running,
    streamText,
    appendEvents,
    setQueuedForThread,
    clearPendingForThread,
    setPlainStreamForThread,
  ]);

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

  const activeComposerBusy = streamText !== null;

  /** Plan-ready card "Build": switch the thread to agent mode and execute the plan. */
  const buildFromPlan = useCallback(() => {
    if (!activeThread || activeComposerBusy || agentRunState?.running) return;
    selectMode("agent");
    const plan = activeThread.planMarkdown?.trim();
    const prompt = plan
      ? `${BUILD_PROMPT}\n\n---\nPlan to implement:\n${plan}\n---`
      : BUILD_PROMPT;
    startAgentRun(activeThread, prompt, "agent");
    if (activeThreadId) {
      setPlanApprovalForThread(activeThreadId, null);
      updateThread(activeThreadId, { planApproved: true });
    }
  }, [activeThread, activeThreadId, activeComposerBusy, agentRunState?.running, selectMode, startAgentRun, updateThread, setPlanApprovalForThread]);

  /** Step-limit divider "Continue": resume the interrupted run with a nudge. */
const continueFromStepLimit = useCallback(() => {
 if (!activeThread || activeComposerBusy || agentRunState?.running) return;
 startAgentRun(activeThread, CONTINUE_PROMPT, activeThread.mode ?? "agent");
}, [activeThread, activeComposerBusy, agentRunState?.running, startAgentRun]);

/** The newest plan is written but not built, and no gate is on screen: the plan
   *  card carries Build so dismissing the gate never strands the plan. */
  const planCardBuildable =
    Boolean(activeThread?.planMarkdown?.trim()) &&
    activeThread?.planApproved !== true &&
    !planApproval &&
    !activeComposerBusy &&
    !(agentRunState?.running ?? false);

  /** File card "Open": show that change in the Diff tab (when we still hold it). */
  const openFileDiff = useCallback((path: string) => {
    if (!activeThreadId) return;
    const fileDiff = fileDiffsRef.current.get(path);
    if (fileDiff) setDiffForThread(activeThreadId, fileDiff);
    openPanelTab("diff");
  }, [activeThreadId, openPanelTab, setDiffForThread]);

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
    let createdProjectId: string | undefined;
    setProjects((cur) => {
      if (cur.length === 0) {
        createdProjectId = newId("proj");
        return [{ id: createdProjectId, name: chatOnlyHosted || boot?.platform === "web" ? "Chat" : "Workspace", root: null, threads: [newThread] }];
      }
      const target = cur.some((p) => p.id === activeProjectId) ? activeProjectId! : cur[0]!.id;
      return cur.map((p) => (p.id === target ? { ...p, threads: [newThread, ...p.threads] } : p));
    });
    setActiveThreadId(newThread.id);
    if (createdProjectId) setActiveProjectId(createdProjectId);
    return newThread;
  }, [activeProjectId, composerMode, selectedModel, selectedProviderId]);

  /**
   * Run a `/goal` line on `thread`; returns false when `text` is not one, so the
   * caller sends it as an ordinary message. Goal commands never reach the model
   * as chat text:
   *  - `/goal <objective>` arms (or replaces) the goal and starts work. The host
   *    restates the objective as a checkable one before the first round. While a
   *    run is active it is stopped first, so the loop never keeps working on the
   *    goal that was just replaced.
   *  - bare `/goal` only reports status; `/goal clear|pause|resume` act on the
   *    goal that exists.
   */
  const handleGoalInput = useCallback(
    (text: string, thread: Thread, mode: ChatMode): boolean => {
      const action = goalInputAction(text);
      if (action.kind === "not-goal") return false;
      const live = projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === thread.id);

      switch (action.kind) {
        case "status":
        case "clear":
        case "pause":
        case "resume": {
          const goal = live?.goal;
          if (action.kind !== "status" && !goal) {
            appendEvents((live ?? ensureThread()).id, [{ kind: "goal-status", text: describeGoal(undefined) }]);
          } else if (action.kind === "status") {
            appendEvents((live ?? ensureThread()).id, [{ kind: "goal-status", text: describeGoal(goal) }]);
          } else if (live) {
            if (action.kind === "clear") applyGoalToThreadRef.current(live, null);
            else setGoalStatus(live.id, action.kind === "pause" ? "paused" : "active");
          }
          return true;
        }
        case "set": {
          if (agentStateStore.isRunning(thread.id)) {
            // Interrupt, then let the fold handler re-enter here once the run is idle.
            pendingSendNowByThreadRef.current = {
              ...pendingSendNowByThreadRef.current,
              [thread.id]: { text, mode },
            };
            stopRun();
            return true;
          }
          const base = live ?? thread;
          const armed = goalPatchFromCommand(action.objective, {
            id: newId("goal"),
            maxRounds: DEFAULT_MAX_GOAL_ROUNDS,
          }).goal;
          if (!armed) return true;
          const replaced = isReplacingGoal(base.goal);
          applyGoalToThreadRef.current(base, action.objective, { armed, recordEvent: false });
          const canRun = (settings?.agentMode ?? "agent") === "agent" && !!window.deyin.agent && !chatOnlyHosted;
          if (canRun) {
            if (base.title === DEFAULT_THREAD_TITLE && toChatMessages(base.events).length === 0) {
              updateThread(base.id, { title: deriveTitle(action.objective) });
            }
            // The user bubble shows what they typed; the host sees the objective as the prompt.
            void startAgentRun({ ...base, goal: armed }, action.objective, mode, {
              displayText: `/goal ${action.objective}`,
              goalRewrite: true,
            });
          }
          // After the run's user bubble, so the timeline reads: typed command, then the goal note.
          appendEvents(base.id, [
            { kind: "goal-set", text: action.objective, ...(replaced ? { replaced: true } : {}) },
          ]);
          return true;
        }
        default: {
          const unreachable: never = action;
          return unreachable;
        }
      }
    },
    [appendEvents, chatOnlyHosted, ensureThread, setGoalStatus, settings?.agentMode, startAgentRun, stopRun, updateThread],
  );
  handleGoalInputRef.current = handleGoalInput;

  /**
   * Switch the composer/thread mode for a typed mode command. Unlike `selectMode`
   * this never navigates: `/conductor <task>` should run the task in this thread, not
   * carry the user off to the Conductor page.
   */
  const applyModeCommand = useCallback(
    (mode: ChatMode) => {
      setComposerMode(mode);
      if (activeThreadId) updateThread(activeThreadId, { mode });
    },
    [activeThreadId, updateThread],
  );

  /**
   * Parse a composer line as a mode command, refusing the modes this host cannot
   * run. A chat-only host has no shell or git, so a typed `/conductor` falls through
   * and is sent as ordinary text instead of switching to a mode that cannot work.
   */
  const parseComposerModeCommand = useCallback(
    (text: string) => {
      const parsed = parseModeCommand(text);
      if (parsed?.mode === "conductor" && chatOnlyHosted) return null;
      return parsed;
    },
    [chatOnlyHosted],
  );

  const send = useCallback(async (text: string, draft: ComposerDraftState) => {
    if (!text || !boot) return;

    // /plan, /ask, /conductor (alias /bot) and /agent are client-side mode commands: a bare command
    // switches the mode and stops there; a command with text runs that text in
    // the new mode. Handled before queueing so it works mid-run too.
    const modeCommand = parseComposerModeCommand(text);
    let runText = text;
    if (modeCommand) {
      applyModeCommand(modeCommand.mode);
      if (modeCommand.prompt.length === 0) {
        composerRef.current?.clearInput();
        return;
      }
      runText = modeCommand.prompt;
    }

    const draftThread =
      activeThread ??
      ({
        ...emptyThread(),
        mode: composerMode,
        model: selectedModel,
        providerId: selectedProviderId,
      } satisfies Thread);
    if (handleGoalInput(runText, draftThread, modeCommand?.mode ?? composerMode)) {
      composerRef.current?.clearInput();
      return;
    }

    const thread = activeThread ?? ensureThread();

    const pendingEdit = pendingEditRef.current;
    if (pendingEdit?.threadId === thread.id && window.deyin.checkpoints && window.deyin.agent.resetSession) {
      pendingEditRef.current = null;
      const liveThread =
        projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === thread.id) ?? thread;
      setReverting(true);
      try {
        const result = await window.deyin.checkpoints.revertAfterEvent(
          thread.id,
          pendingEdit.eventIndex,
          liveThread.events,
        );
        showRevertToast(result);
        const truncated = liveThread.events.slice(0, pendingEdit.eventIndex);
        updateThread(thread.id, {
          events: truncated,
          ...(truncated.every((e) => e.kind !== "plan-ready") ? { planMarkdown: undefined, planFilePath: undefined, planApproved: undefined } : {}),
          ...(truncated.every((e) => e.kind !== "page-ready") ? { pageTitle: undefined, pageFileName: undefined } : {}),
        });
        await window.deyin.agent.resetSession(thread.id);
      } finally {
        setReverting(false);
      }
    }

    const { providerId: runProviderId, modelId: runModelId } = resolveThreadModel(thread);

    // While this thread's run is active, Enter/Send queues the follow-up (Cursor-like).
    if (
      shouldQueueFollowUp({
        threadId: thread.id,
        isThreadRunning: agentStateStore.isRunning(thread.id),
        streamText: plainStreamFor(thread.id),
        busyThreadId: thread.id,
      })
    ) {
      setQueuedForThread(thread.id, runText);
      composerRef.current?.clearInput();
      return;
    }
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
    const history = [...toChatMessages(thread.events), { role: "user" as const, content: runText }];

    // Models available for the selected provider, used for image + vision routing.
    const modelList =
      runProviderId === "openference" ? models : (providers.find((p) => p.id === runProviderId)?.models ?? []);
    const imageModels = modelList.filter((m) => m.kind === "image").map((m) => m.id);
    // Chat models that draw: usable by generate_image and able to answer with a
    // picture directly, so they never count as "no image model available".
    const imageChatModels = modelList.filter((m) => m.kind !== "image" && m.kind !== "video" && m.imageOutput).map((m) => m.id);
    const selectedEntry = modelList.find((m) => m.id === runModelId);
    const isImageRun = selectedEntry?.kind === "image";
    const isVideoRun = modelIsVideo(runModelId, selectedEntry?.kind);

    if (isFirstMessage && thread.title === DEFAULT_THREAD_TITLE) {
      const provisional = deriveTitle(runText);
      updateThread(thread.id, { title: provisional });
      const threadId = thread.id;
      // Skip the LLM call when the provisional title is already short enough.
      const needsLlmTitle = provisional.endsWith("…") || provisional.split(/\s+/).length > 6;
      if (needsLlmTitle) {
        const titleModel =
          isImageRun || isVideoRun
            ? (modelList.find((m) => m.kind !== "image" && m.kind !== "video")?.id ?? runModelId)
            : runModelId;
        void generateThreadTitle({ apiBaseUrl, token: token ?? "", model: titleModel, text: runText })
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

    // Text-to-video model picked in the composer, or auto-routed from video intent:
    // the prompt goes straight to POST /v1/videos — these models have no chat
    // completion to stream. The result is stored per thread and embedded with the
    // inline-video directive.
    const autoVideoGen = settings?.autoVideoGeneration ?? true;
    const videoIntent =
      !isVideoRun && !isImageRun && autoVideoGen && draft.images.length === 0
        ? detectVideoGenerationIntent(runText)
        : null;
    const autoVideoModel = videoIntent ? pickVideoModelForGeneration(modelList) : undefined;
    const directVideoModelId = isVideoRun ? runModelId : autoVideoModel;
    const directVideoPrompt = isVideoRun ? runText : videoIntent?.prompt;

    if (directVideoModelId && directVideoPrompt) {
      appendEvents(thread.id, [{ kind: "user", text: runText }]);
      composerRef.current?.clearInput();
      composerRef.current?.clearImages();
      setPlainStreamForThread(thread.id, `Generating video with ${directVideoModelId}…`);
      try {
        const videoParams = resolveVideoModelParams(
          directVideoModelId,
          settings?.videoModelParams?.[videoModelParamsKey(runProviderId, directVideoModelId)],
        );
        const inputImages =
          draft.images.length > 0
            ? draft.images.map(({ mediaType, base64 }) => ({ mediaType, base64 }))
            : undefined;
        const result = await window.deyin.videos.generate({
          threadId: thread.id,
          prompt: directVideoPrompt,
          model: directVideoModelId,
          providerId: runProviderId,
          aspectRatio: videoParams.aspectRatio,
          seconds: videoParams.seconds,
          size: videoParams.size,
          seed: videoParams.seed,
          mode: videoParams.mode,
          inputImages,
        });
        const body = `::deyin-inline-video{file="${result.video.file}"}`;
        appendEvents(thread.id, [{ kind: "assistant", text: body }]);
      } catch (err) {
        appendEvents(thread.id, [
          { kind: "assistant", text: `Video generation failed: ${err instanceof Error ? err.message : String(err)}` },
        ]);
      } finally {
        setPlainStreamForThread(thread.id, null);
        markUnreadIfAway(thread.id);
        void window.deyin.usage.record({ model: directVideoModelId, tokens: 0, newSession: isFirstMessage });
      }
      return;
    }

    if (videoIntent && !autoVideoModel) {
      appendEvents(thread.id, [{ kind: "assistant", text: videoGenerationBlockedMessage() }]);
      return;
    }

    // Text-to-image model picked in the composer, or auto-routed from image intent:
    // the prompt goes straight to the images endpoint — these models have no chat
    // completion to stream. The result is stored per thread and embedded with the
    // inline-image directive.
    const autoImageGen = settings?.autoImageGeneration ?? true;
    const imageIntent =
      !isImageRun && autoImageGen && draft.images.length === 0 ? detectImageGenerationIntent(runText) : null;
    const autoImageModel = imageIntent ? pickImageModelForGeneration(modelList) : undefined;
    const directImageModelId = isImageRun ? runModelId : autoImageModel?.id;
    const directImagePrompt = isImageRun ? runText : imageIntent?.prompt;

    if (directImageModelId && directImagePrompt) {
      appendEvents(thread.id, [{ kind: "user", text: runText }]);
      composerRef.current?.clearInput();
      composerRef.current?.clearImages();
      setPlainStreamForThread(thread.id, `Generating image with ${directImageModelId}…`);
      try {
        const imageParams = resolveImageModelParams(directImageModelId, savedImageParams);
        const result = await window.deyin.images.generate({
          threadId: thread.id,
          prompt: directImagePrompt,
          model: directImageModelId,
          providerId: runProviderId,
          size: imageParams.size,
          negativePrompt: imageParams.negativePrompt,
          numSteps: imageParams.numSteps,
          guidance: imageParams.guidance,
          seed: imageParams.seed,
        });
        const body = result.images.map((img) => `::deyin-inline-image{file="${img.file}"}`).join("\n");
        appendEvents(thread.id, [{ kind: "assistant", text: body }]);
      } catch (err) {
        appendEvents(thread.id, [
          { kind: "assistant", text: `Image generation failed: ${err instanceof Error ? err.message : String(err)}` },
        ]);
      } finally {
        setPlainStreamForThread(thread.id, null);
        markUnreadIfAway(thread.id);
        void window.deyin.usage.record({ model: directImageModelId, tokens: 0, newSession: isFirstMessage });
      }
      return;
    }

    if (imageIntent && !autoImageModel) {
      appendEvents(thread.id, [{ kind: "assistant", text: imageGenerationBlockedMessage() }]);
      return;
    }

    // Agent runtime (default): run the tool-calling loop in the host process in
    // the selected composer mode; falls back to the plain text stream when
    // switched off. Images require the agent runtime (vision content parts).
    const images: AgentImageInput[] = draft.images.map(({ mediaType, base64 }) => ({ mediaType, base64 }));
    if ((settings?.agentMode ?? "agent") === "agent" && window.deyin.agent && !chatOnlyHosted) {
      // Images always go to the model the user picked. Capability metadata is a
 // hint, never a gate: a provider that can't take images returns its own
 // error, which surfaces in the timeline like any other provider failure.
 composerRef.current?.clearComposerState();
      const sendMeta = {
        attachments: [...draft.attachments],
        linkedThreadIds: draft.linked.map((l) => l.threadId),
        images,
        imageModels,
        imageChatModels,
        model: runModelId,
      };
      void startAgentRun(thread, runText, modeCommand?.mode ?? composerMode, sendMeta);
      return;
    }

    if (images.length > 0) {
      appendEvents(thread.id, [
        { kind: "assistant", text: "Plain chat mode doesn't support images. Enable the agent runtime in Settings → General." },
      ]);
      return;
    }

    // Last-resort guard: never POST a video model to chat completions.
    if (modelIsVideo(runModelId, selectedEntry?.kind) && runText.trim()) {
      appendEvents(thread.id, [{ kind: "user", text: runText }]);
      composerRef.current?.clearInput();
      composerRef.current?.clearImages();
      setPlainStreamForThread(thread.id, `Generating video with ${runModelId}…`);
      try {
        const videoParams = resolveVideoModelParams(
          runModelId,
          settings?.videoModelParams?.[videoModelParamsKey(runProviderId, runModelId)],
        );
        const result = await window.deyin.videos.generate({
          threadId: thread.id,
          prompt: runText,
          model: runModelId,
          providerId: runProviderId,
          aspectRatio: videoParams.aspectRatio,
          seconds: videoParams.seconds,
          size: videoParams.size,
          seed: videoParams.seed,
          mode: videoParams.mode,
        });
        appendEvents(thread.id, [{ kind: "assistant", text: `::deyin-inline-video{file="${result.video.file}"}` }]);
      } catch (err) {
        appendEvents(thread.id, [
          { kind: "assistant", text: `Video generation failed: ${err instanceof Error ? err.message : String(err)}` },
        ]);
      } finally {
        setPlainStreamForThread(thread.id, null);
        markUnreadIfAway(thread.id);
        void window.deyin.usage.record({ model: runModelId, tokens: 0, newSession: isFirstMessage });
      }
      return;
    }

    appendEvents(thread.id, [{ kind: "user", text: runText }]);
    composerRef.current?.clearInput();
    setPlainStreamForThread(thread.id, "");

    // Inactivity watchdog: a stalled SSE stream must not wedge the composer
    // (streamText stays non-null, which blocks every later send).
    let timedOut = false;
    const abort = new AbortController();
    plainChatAbortsRef.current.set(thread.id, abort);
    const armWatchdog = () =>
      setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, PLAIN_CHAT_STALL_MS);
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
        setPlainStreamForThread(thread.id, acc);
      }
      appendEvents(thread.id, [{ kind: "assistant", text: acc }]);
      if (acc.trim()) void registerChatOnlyPage(thread.id, acc);
    } catch (err) {
      const msg = timedOut
        ? `Request timed out — no data from the model for ${Math.round(PLAIN_CHAT_STALL_MS / 1000)}s. Try again.`
        : err instanceof Error
          ? err.message
          : String(err);
      appendEvents(thread.id, [{ kind: "assistant", text: `Request failed: ${msg}` }]);
    } finally {
      clearTimeout(watchdog);
      // Only drop this thread's controller: a concurrent chat owns its own.
      if (plainChatAbortsRef.current.get(thread.id) === abort) plainChatAbortsRef.current.delete(thread.id);
      setPlainStreamForThread(thread.id, null);
      markUnreadIfAway(thread.id);
      // Real token usage from the provider's final stream frame. Providers that
      // report none record 0 tokens; message/session counts still apply.
      void window.deyin.usage.record({ model: runModelId, tokens: reportedTokens, newSession: isFirstMessage });
    }
  }, [activeThread, boot, models, providers, settings, composerMode, applyModeCommand, parseComposerModeCommand, connect, appendEvents, registerChatOnlyPage, startAgentRun, updateThread, ensureThread, handleGoalInput, resolveThreadModel, setQueuedForThread, plainStreamFor, setPlainStreamForThread, markUnreadIfAway]);

  /** Abort the current run and send immediately (does not wait for natural completion). */
  const sendNow = useCallback(
    (text: string, fromInput: boolean) => {
      if (!text) return;

      // A typed mode command applies without interrupting the run.
      const modeCommand = parseComposerModeCommand(text);
      if (modeCommand) {
        applyModeCommand(modeCommand.mode);
        if (modeCommand.prompt.length === 0) {
          if (fromInput) composerRef.current?.clearInput();
          else setQueuedForThread(activeThread?.id ?? "", null);
          return;
        }
        text = modeCommand.prompt;
      }

      const draftThread =
        activeThread ??
        ({
          ...emptyThread(),
          mode: composerMode,
          model: selectedModel,
          providerId: selectedProviderId,
        } satisfies Thread);

      // /goal never reaches the model — apply it without interrupting the run.
      if (handleGoalInput(text, draftThread, modeCommand?.mode ?? composerMode)) {
        if (fromInput) composerRef.current?.clearInput();
        else setQueuedForThread(draftThread.id, null);
        return;
      }

      if (!activeThread) return;

      composerRef.current?.clearInput();
      setQueuedForThread(activeThread.id, null);

    const runActive =
      agentStateStore.isRunning(activeThread.id) || plainStreamFor(activeThread.id) !== null;
    const runMode = modeCommand?.mode ?? composerMode;
    if (!runActive) {
      if ((settings?.agentMode ?? "agent") === "agent" && window.deyin.agent && !chatOnlyHosted) {
        startAgentRun(activeThread, text, runMode);
      }
      return;
    }

    pendingSendNowByThreadRef.current = {
      ...pendingSendNowByThreadRef.current,
      [activeThread.id]: { text, mode: runMode },
    };
    stopRun();
  }, [activeThread, settings, boot, composerMode, applyModeCommand, parseComposerModeCommand, selectedModel, selectedProviderId, startAgentRun, stopRun, handleGoalInput, setQueuedForThread, plainStreamFor]);

  const clearQueue = useCallback(() => {
    if (activeThreadId) setQueuedForThread(activeThreadId, null);
  }, [activeThreadId, setQueuedForThread]);

  /** Run the queued follow-up in a new thread while the current run continues. */
  const startMultitasking = useCallback(() => {
    const raw = queuedPromptByThreadRef.current[activeThread?.id ?? ""]?.trim();
    if (!raw || !activeThread) return;
    setQueuedForThread(activeThread.id, null);
    const modeCommand = parseComposerModeCommand(raw);
    if (modeCommand && modeCommand.prompt.length === 0) {
      applyModeCommand(modeCommand.mode);
      return;
    }
    const text = modeCommand?.prompt ?? raw;
    const mode = modeCommand?.mode ?? composerMode;
    const newThread = ensureThread();
    if (handleGoalInput(text, newThread, mode)) return;
    void startAgentRun(newThread, text, mode);
  }, [activeThread, composerMode, applyModeCommand, parseComposerModeCommand, ensureThread, handleGoalInput, setQueuedForThread, startAgentRun]);

  const greetingName = useMemo(() => {
    const first = user?.name?.split(/\s+/)[0];
    return first ? `Hi ${first}` : "Afternoon";
  }, [user]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const projectName =
    activeProject?.name ??
    (workspaceRoot ? workspaceRoot.split(/[\\/]/).pop() ?? (chatOnlyHosted ? "Chat" : "Workspace") : chatOnlyHosted ? "Chat" : "No workspace");

  // Same inputs ChatView uses for its empty branch — drives the centered
  // new-chat layout (logo hero + repo chip + composer). Memoized: a fresh
  // array here would defeat both ChatView's groups memo and its React.memo
  // boundary on every unrelated root re-render.
  const chatEvents = useMemo(
    () => [...(activeThread?.events ?? []), ...(agentRunState?.runEvents ?? [])],
    [activeThread, agentRunState],
  );
  // Subagent runs in this thread, oldest first — the Agent panel's source list.
  const subagentRuns = useMemo(
    () => chatEvents.filter((e): e is Extract<typeof e, { kind: "subagent" }> => e.kind === "subagent"),
    [chatEvents],
  );
  const chatStreamText = resolveChatStreamText({
    activeThreadId,
    agentStreamText: agentRunState?.streamText ?? null,
    streamText,
    busyThreadId: activeThreadId,
  });
  const isChatEmpty = chatEvents.length === 0 && chatStreamText === null;
  // A Bot's empty conversation says how to set it up, not what to build. Memoized for the same reason as above.
  const botEmptyState = useMemo(
    () => (activeBot ? <BotEmptyState bot={activeBot} onStarter={startFromStarter} /> : undefined),
    [activeBot, startFromStarter],
  );

  const language = settings?.language ?? "en";

  // A Bot's routine runs with nobody in the chat, so its result is put in the Bot's conversation when it finishes.
  // Each run is posted once, even if the host reports it again.
  const postedRuns = useRef(new Set<string>());
  useEffect(() => {
    const api = window.deyin?.automations;
    if (!api) return;
    let live = true;
    const stop = api.onRunFinished(({ run }) => {
      if (postedRuns.current.has(run.id)) return;
      void api
        .list()
        .then((list) => {
          const routine = list.find((automation) => automation.id === run.automationId);
          if (!live || !routine?.botId || postedRuns.current.has(run.id)) return;
          const botId = routine.botId;
          const words = {
            posted: translate(language, "bot.routine.posted"),
            failed: translate(language, "bot.routine.failed"),
            noReason: translate(language, "bot.routine.noReason"),
          };
          const delivery = { botId, name: routine.name, run, words, activeThreadId: activeThreadIdRef.current, now: Date.now() };
          postedRuns.current.add(run.id);
          setProjects((cur) => deliverRoutineResult(cur, delivery) ?? cur);
        })
        .catch(() => undefined);
    });
    return () => {
      live = false;
      stop();
    };
  }, [language]);

  // Referentially stable props for the memoized leaves below: inline arrows
  // and object literals would defeat the memo boundaries on every root render.
  const chatCodeDisplay = useMemo(
    () => ({
      themeLight: settings?.codeThemeLight ?? "GitHub Light",
      themeDark: settings?.codeThemeDark ?? "GitHub Dark",
      variant: themeVariant === "light" ? ("light" as const) : ("dark" as const),
      fontSize: settings?.codeFontSize ?? 12,
      showLineNumbers: settings?.showLineNumbers ?? true,
      wrapLongLines: settings?.wrapLongLines ?? false,
    }),
    [settings?.codeThemeLight, settings?.codeThemeDark, themeVariant, settings?.codeFontSize, settings?.showLineNumbers, settings?.wrapLongLines],
  );
  const panelCodeDisplay = useMemo(
    () => ({
      showLineNumbers: settings?.showLineNumbers ?? true,
      wrapLongLines: settings?.wrapLongLines ?? false,
      codeFontSize: settings?.codeFontSize ?? 12,
      themeLight: settings?.codeThemeLight ?? "GitHub Light",
      themeDark: settings?.codeThemeDark ?? "GitHub Dark",
      variant: themeVariant === "light" ? ("light" as const) : ("dark" as const),
    }),
    [settings?.showLineNumbers, settings?.wrapLongLines, settings?.codeFontSize, settings?.codeThemeLight, settings?.codeThemeDark, themeVariant],
  );
  const threadTitles = useMemo(
    () => Object.fromEntries((activeProject?.threads ?? []).map((t) => [t.id, t.title])),
    [activeProject?.threads],
  );
  const openPlanPanel = useCallback(() => openPanelTab("plan"), [openPanelTab]);
  const openPreviewPanel = useCallback(() => openPanelTab("preview"), [openPanelTab]);
  const openSubagentPanel = useCallback(
    (id: string) => {
      setActiveSubagentId(id);
      openPanelTab("agent");
    },
    [openPanelTab],
  );
  const forkAtEvent = useCallback(
    (eventIndex: number) => {
      if (activeThreadId) forkThreadAtEvent(activeThreadId, eventIndex);
    },
    [activeThreadId, forkThreadAtEvent],
  );
  const messageFeedback = useCallback(
    (eventIndex: number, rating: "up" | "down", removed = false) => {
      if (!activeThreadId) return;
      window.deyin.telemetry.record("message-feedback", {
        rating,
        removed,
        threadId: activeThreadId,
        eventIndex,
      });
    },
    [activeThreadId],
  );
  const hasAgentTerminal = agentTerminals.some((t) => t.threadId === activeThreadId);
  const openAgentTerminal = useCallback(() => openPanelTab("terminal"), [openPanelTab]);
  const panelPlanTodos = activeThread?.todos ?? EMPTY_TODOS;

  // Stable Sidebar handlers (memo boundary).
  const sidebarNewProject = useCallback(() => void addProjectFolder(), [addProjectFolder]);
  const sidebarNewTaskInProject = useCallback(
    (projectId: string) => {
      void selectProject(projectId);
      newTask(undefined, undefined, projectId);
    },
    [selectProject, newTask],
  );
  const sidebarSelectProject = useCallback(
    (projectId: string) => {
      void selectProject(projectId);
      if (view !== "conductor" && view !== "workflows") {
        setView("workspace");
      }
    },
    [selectProject, view],
  );
  const handleSelectTargetRepository = useCallback(
    async (projectId: string) => {
      await selectProject(projectId);
      setView("conductor");
      setComposerMode("conductor");
      const targetProj = projects.find((p) => p.id === projectId);
      const isAlreadyInTarget = targetProj?.threads.some((t) => t.id === activeThreadId && t.mode === "conductor");
      if (!isAlreadyInTarget) {
        const latestConductorMission = (targetProj?.threads ?? []).find((t) => t.mode === "conductor" && !t.archived);
        setActiveThreadId(latestConductorMission?.id ?? null);
      }
    },
    [selectProject, projects, activeThreadId],
  );
  const sidebarSelectThread = useCallback((pid: string, tid: string) => selectThread(tid, pid), [selectThread]);
  const sidebarOpenSearch = useCallback(() => setSearchOpen(true), []);
  const sidebarThreadContext = useCallback(
    (threadId: string, x: number, y: number) => setThreadMenu({ threadId, x, y }),
    [],
  );
  const sidebarProjectContext = useCallback(
    (projectId: string, x: number, y: number) => setProjectMenu({ projectId, x, y }),
    [],
  );
  const sidebarRenameSubmit = useCallback(
    (threadId: string, title: string) => {
      updateThread(threadId, { title });
      setRenamingThreadId(null);
    },
    [updateThread],
  );
  const sidebarOpenUsage = useCallback(() => {
    setSettingsPage("data");
    setView("settings");
  }, []);
  const sidebarOpenPlans = useCallback(() => setView("upgrade"), []);
  const sidebarOpenSettings = useCallback(() => {
    // The gear always lands on General; deep links (Manage models,
    // browser settings) set their page right before switching views.
    setSettingsPage("general");
    setView("settings");
    window.deyin.telemetry?.record("settings-opened");
  }, []);
  const sidebarOpenPlugins = useCallback(() => setView("plugins"), []);
  const openExtensionSettings = useCallback((tab: ExtensionSettingsTab, kind?: CapabilityKind) => {
    setExtensionTab(tab);
    if (kind) setSkillTab(kind);
    setSettingsPage("extensions");
    setView("settings");
  }, []);
  const sidebarOpenAutomations = useCallback(() => setView("automations"), []);
  const sidebarOpenSuperagent = useCallback(() => setView("superagent"), []);
  const sidebarOpenWorkflows = useCallback((workflowId?: string | null) => {
    setSelectedWorkflowForEdit(workflowId ?? null);
    setView("workflows");
    setComposerMode("conductor");
  }, []);
  const sidebarOpenCustomize = useCallback(() => {
    setSettingsPage("appearance");
    setView("settings");
  }, []);

  // Stable WorkspacePanel handlers/objects (memo boundary).
  const openGitDiff = useCallback(
    (d: Parameters<typeof setDiffForThread>[1]) => {
      if (activeThreadId) setDiffForThread(activeThreadId, d);
      openPanelTab("diff");
    },
    [activeThreadId, openPanelTab, setDiffForThread],
  );
  const openFolder = useCallback(() => void addProjectFolder(), [addProjectFolder]);
  const openBrowserSettings = useCallback(() => {
    setSettingsPage("workspace");
    setView("settings");
  }, []);
  const fixSecurityFinding = useCallback(
    (finding: import("@deyin/contract").SecurityFinding) => {
      const prompt = formatFindingFixPrompt(finding);
      const newThread = ensureThread();
      void startAgentRun(newThread, prompt, "agent");
    },
    [ensureThread, startAgentRun],
  );
  const fixAllSecurityFindings = useCallback(
    (findings: import("@deyin/contract").SecurityFinding[]) => {
      if (!findings.length) return;
      const prompt = formatAllFindingsFixPrompt(findings);
      const newThread = ensureThread();
      void startAgentRun(newThread, prompt, "agent");
    },
    [ensureThread, startAgentRun],
  );
  const terminalAttachSessions = useMemo(
    () =>
      agentTerminals
        .filter((t) => t.threadId === activeThreadId)
        .map((t) => ({ id: t.id, label: t.label })),
    [agentTerminals, activeThreadId],
  );

  // Signed-out users see Welcome first. Desktop can skip via API-key path
  // (settings.welcomeDismissed). Hosted chat-only web always requires sign-in.
  const showWelcome =
    boot &&
    !user &&
    (boot.chatOnly || (boot.platform === "desktop" && !settings?.welcomeDismissed));
  if (showWelcome) {
    return (
      <AppProviders language={language}>
        <Welcome
          busy={busy}
          connecting={connecting}
          connectError={connectError}
          onConnect={() => void connect()}
          onUseApiKey={
            boot.chatOnly
              ? undefined
              : () => {
                  patchSettings({ welcomeDismissed: true });
                  setSettingsPage("models");
                  setView("settings");
                }
          }
          footerHint={
            boot.chatOnly ? (
              <>
                Chat on the web. For coding agents, terminal, and git — use the{" "}
                <a href="https://github.com/DeYinAI/deyin-desktop/releases" target="_blank" rel="noreferrer">
                  Deyin desktop app
                </a>
                .
              </>
            ) : undefined
          }
        />
      </AppProviders>
    );
  }

  if (view === "settings" && settings && boot) {
    return (
      <AppProviders language={language}>
        <div className="app">
          <Suspense fallback={<div className="app" />}>
          <LazySettingsView
          platform={boot?.platform === "web" ? "web" : "desktop"}
          chatOnly={boot?.chatOnly}
            key={settingsPage}
            initialPage={settingsPage}
            initialExtensionTab={extensionTab}
            initialSkillTab={skillTab}
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
            onOpenPlans={() => setView("upgrade")}
            onBack={() => {
              void window.deyin.providers.list().then(handleProvidersChanged);
              setView(sharedBackView);
            }}
            onRefreshLiveModels={async () => {
              setModels(await window.deyin.models.refresh());
            }}
          />
          </Suspense>
        </div>
      </AppProviders>
    );
  }

  if (view === "upgrade" && boot) {
    return (
      <AppProviders language={language}>
        <Suspense fallback={<div className="app" />}>
        <LazyPlansView
          platform={boot.platform}
          oauthIssuer={boot.config.oauthIssuer}
          userPlan={user?.plan ?? null}
          onBack={() => setView(sharedBackView)}
          onComplete={() => {
            void window.deyin.usage.account(true);
            setView(sharedBackView);
          }}
        />
        </Suspense>
      </AppProviders>
    );
  }

  const composerNode = (
    <div className="chat-column__composer">
      <PromptDockSlot />
      {!chatOnlyHosted && activeThread?.goal && activeThread.goal.status !== "done" && activeThread.goal.status !== "met" && (
        <div className={`goal-card goal-card--${activeThread.goal.status}`}>
          <Icon name="flag" size={14} />
          <span className="goal-card__text">{activeThread.goal.text}</span>
          {activeThread.goal.maxRounds !== undefined && (
            <span className="goal-card__rounds" title="Continuation rounds used">
              {activeThread.goal.rounds ?? 0}/{activeThread.goal.maxRounds}
            </span>
          )}
          {activeThread.goal.status === "active" && activeThreadId && (
            <button
              type="button"
              className="goal-card__action"
              title="Pause the goal loop"
              onClick={() => setGoalStatus(activeThreadId, "paused")}
            >
              <Icon name="pause" size={12} />
            </button>
          )}
          {activeThread.goal.status === "paused" && activeThreadId && (
            <button
              type="button"
              className="goal-card__action"
              title="Resume the goal loop"
              onClick={() => setGoalStatus(activeThreadId, "active")}
            >
              <Icon name="play" size={12} />
            </button>
          )}
          {activeThreadId && (
            <button
              type="button"
              className="goal-card__action"
              title="Clear the goal"
              onClick={() => clearGoal(activeThreadId)}
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
      )}
      {!chatOnlyHosted && (
        <>
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
          {activeMcpAuthRequests[0] && activeThreadId && (
            <McpAuthCard
              key={activeMcpAuthRequests[0].requestId}
              moduleId={activeMcpAuthRequests[0].moduleId}
              serverName={activeMcpAuthRequests[0].serverName}
              message={activeMcpAuthRequests[0].message}
              onSkip={() =>
                setMcpAuthByThread((cur) => ({
                  ...cur,
                  [activeThreadId]: (cur[activeThreadId] ?? []).filter(
                    (r) => r.requestId !== activeMcpAuthRequests[0]!.requestId,
                  ),
                }))
              }
            />
          )}
          {activeApprovals[0] && activeThreadId && (
            <ApprovalDialog
              key={activeApprovals[0].requestId}
              toolName={activeApprovals[0].toolName}
              summary={activeApprovals[0].summary}
              reason={activeApprovals[0].reason}
              saved={activeApprovals[0].saved}
              pendingCount={activeApprovals.length}
              onDecision={(decision) => {
                const answered = activeApprovals[0]!;
                window.deyin.agent?.approve(answered.requestId, decision);
                const covered =
                  decision === "allow-always"
                    ? activeApprovals.filter((a) => a !== answered && a.toolName === answered.toolName)
                    : [];
                for (const a of covered) window.deyin.agent?.approve(a.requestId, "allow");
                setApprovalsByThread((cur) => ({
                  ...cur,
                  [activeThreadId]: (cur[activeThreadId] ?? []).filter(
                    (a) => a.requestId !== answered.requestId && !covered.includes(a),
                  ),
                }));
              }}
            />
          )}
          {planApproval && planApproval.threadId === activeThreadId && (
            <PlanApprovalDialog
              title={planApproval.title}
              overview={planApproval.overview}
              onApprove={buildFromPlan}
              onRevise={() => {
                setPlanApprovalForThread(activeThreadId, null);
                setComposerFocus((n) => n + 1);
              }}
              onDismiss={() => setPlanApprovalForThread(activeThreadId, null)}
              onEdit={
                planApproval.filePath
                  ? () => void window.deyin.shell.showItem(planApproval.filePath!)
                  : undefined
              }
            />
          )}
          {activeSecureForm && activeThreadId && (
            <SecureFormDialog
              key={activeSecureForm.requestId}
              request={activeSecureForm.form}
              onSubmit={(values) => {
                window.deyin.agent?.answerSecureForm?.(activeSecureForm.requestId, values);
                setSecureFormByThread((cur) => ({
                  ...cur,
                  [activeThreadId]: (cur[activeThreadId] ?? []).filter((f) => f.requestId !== activeSecureForm.requestId),
                }));
              }}
              onCancel={() => {
                window.deyin.agent?.answerSecureForm?.(activeSecureForm.requestId, null);
                setSecureFormByThread((cur) => ({
                  ...cur,
                  [activeThreadId]: (cur[activeThreadId] ?? []).filter((f) => f.requestId !== activeSecureForm.requestId),
                }));
              }}
            />
          )}
          {activeQuestion && activeThreadId && (
            <AskQuestionDialog
              title={activeQuestion.title}
              questions={activeQuestion.questions}
              onSubmit={(answers) => {
                window.deyin.agent?.answerQuestion(activeQuestion.requestId, answers);
                setQuestionByThread((cur) => ({
                  ...cur,
                  [activeThreadId]: (cur[activeThreadId] ?? []).filter(
                    (q) => q.requestId !== activeQuestion.requestId,
                  ),
                }));
              }}
              onCancel={() => {
                window.deyin.agent?.answerQuestion(activeQuestion.requestId, {
                  __cancelled: "AskQuestion was cancelled before answers were returned.",
                });
                setQuestionByThread((cur) => ({
                  ...cur,
                  [activeThreadId]: (cur[activeThreadId] ?? []).filter(
                    (q) => q.requestId !== activeQuestion.requestId,
                  ),
                }));
              }}
            />
          )}
        </>
      )}
      <ComposerDock
        ref={composerRef}
        threadId={activeThreadId}
        keeper={draftKeeper}
        chatOnly={chatOnlyHosted}
        steerActive={activeThreadStreaming}
        queued={activeQueuedPrompt}
        onSend={send}
        onSendNow={sendNow}
        onStartMultitasking={startMultitasking}
        onClearQueue={clearQueue}
        plainChat={chatOnlyHosted}
        botChat={activeBot ? botComposerChrome(activeBot, botChips.length > 0, (key) => translate(language, key), () => openBotDetails(activeBot.id)) : undefined}
        conductorModeAvailable={!chatOnlyHosted && product !== "bot"}
        focusSignal={composerFocus}
        models={models}
        selectedModel={selectedModel}
        approvalMode={settings?.approvalMode ?? "full-access"}
        mode={
          chatOnlyHosted
            ? undefined
            : (settings?.agentMode ?? "agent") === "agent"
              ? composerMode
              : undefined
        }
        deliveryModeEnabled={false}
        thinking={settings?.thinking ?? true}
        thinkingDefault={settings?.thinking ?? true}
        modelEfforts={settings?.modelEfforts}
        streaming={activeThreadStreaming}
        hasEvents={(activeThread?.events.length ?? 0) > 0}
        providers={providers}
        selectedProviderId={selectedProviderId}
        onStop={showGlobalStop ? stopRun : undefined}
        onSelectModel={(id) => applyComposerModel(selectedProviderId, id)}
        onSelectProviderModel={(providerId, modelId) => applyComposerModel(providerId, modelId)}
        onManageModels={() => {
          setSettingsPage("models");
          setView("settings");
        }}
        onOpenUsage={
          chatOnlyHosted
            ? undefined
            : () => {
                setSettingsPage("data");
                setView("settings");
              }
        }
        onSelectApproval={
          chatOnlyHosted ? () => {} : (mode: ApprovalMode) => patchSettings({ approvalMode: mode })
        }
        onSelectMode={chatOnlyHosted || product === "bot" ? undefined : selectMode}
        onToggleThinking={(on) => patchSettings({ thinking: on })}
        onSetModelEffort={(providerId, modelId, mode: ModelReasoningMode | undefined) => {
          const key = modelEffortKey(providerId, modelId);
          const next = { ...(settings?.modelEfforts ?? {}) };
          if (mode) next[key] = mode;
          else delete next[key];
          patchSettings({ modelEfforts: next });
        }}
        imageModelSettings={
          selectedModelKind === "image"
            ? {
                providerId: selectedProviderId,
                modelId: selectedModel,
                saved: savedImageParams,
                onChange: (providerId, modelId, params: ImageModelParams) => {
                  const key = imageModelParamsKey(providerId, modelId);
                  const next = { ...(settings?.imageModelParams ?? {}) };
                  if (Object.keys(params).length === 0) delete next[key];
                  else next[key] = params;
                  patchSettings({ imageModelParams: next });
                },
              }
            : undefined
        }
        videoModelSettings={
          selectedModelKind === "video"
            ? {
                providerId: selectedProviderId,
                modelId: selectedModel,
                saved: savedVideoParams,
                onChange: (providerId, modelId, params: VideoModelParams) => {
                  const key = videoModelParamsKey(providerId, modelId);
                  const next = { ...(settings?.videoModelParams ?? {}) };
                  if (Object.keys(params).length === 0) delete next[key];
                  else next[key] = params;
                  patchSettings({ videoModelParams: next });
                },
              }
            : undefined
        }
        contextSnapshot={activeContextSnapshot}
        contextLength={selectedContextLength}
        threadKey={activeThreadId}
        compactionNotice={chatOnlyHosted ? null : activeCompactionNotice}
        threadsForPicker={activeProject?.threads}
        activeThreadId={activeThreadId}
        workspaceRoot={workspaceRoot}
        goalText={
          chatOnlyHosted
            ? null
            : activeThread?.goal?.status === "active"
              ? activeThread.goal.text
              : null
        }
        onSetGoal={
          chatOnlyHosted
            ? undefined
            : (text) => {
                const thread =
                  activeThread ??
                  ({
                    ...emptyThread(),
                    mode: composerMode,
                    model: selectedModel,
                    providerId: selectedProviderId,
                  } satisfies Thread);
                applyGoalToThreadRef.current(thread, text);
              }
        }
      >
        {/* A Bot works in its own folder, so a coding session's workspace is not the Bot's to pick. */}
        {activeBot ? null : (
          <WorkspaceBar
            platform={boot?.platform === "web" ? "web" : "desktop"}
            projects={workspaceProjects}
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
        )}
      </ComposerDock>
    </div>
  );

  const conversationHeaderNode = (
    <ConversationHeader
      platform={boot?.platform ?? "desktop"}
      chatOnly={chatOnlyHosted}
      mode={composerMode}
      onModeChange={selectMode}
      threadId={activeThreadId}
      threadTitle={activeThread?.title ?? DEFAULT_THREAD_TITLE}
      threadPinned={activeThread?.pinned ?? false}
      workspaceRoot={workspaceRoot}
      panelOpen={panelOpen}
      terminalOpen={terminalVisible}
      mcpCount={mcpCount}
      onOpenMcp={() => {
        setSettingsPage("extensions");
        setView("settings");
      }}
      onTogglePanel={togglePanel}
      onToggleTerminal={() => {
        if (terminalVisible) collapsePanel();
        else openPanelTab("terminal");
      }}
      onThreadAction={handleThreadAction}
      trailing={
        <>
          {boot?.platform === "web" && !chatOnlyHosted && (
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
        </>
      }
    />
  );

  const taskListNode =
    !chatOnlyHosted && (activeThread?.todos?.length ?? 0) > 0 ? (
      <div className="chat-column__tasks">
        <TaskList
          todos={activeThread!.todos!}
          running={agentRunState?.running ?? false}
          title={
            activeThread!.title !== DEFAULT_THREAD_TITLE ? activeThread!.title : undefined
          }
        />
      </div>
    ) : null;

  /** Strips docked above the composer: the task list and the pipeline run. */
  const dockNode = (
    <>
      {taskListNode}
      {!chatOnlyHosted && <ConductorRunStrip onOpen={() => openPanelTab("conductorflow")} />}
    </>
  );

  const panelNode = panelOpen ? (
    <div
      className="wspanel-wrap"
      style={
        panelFullscreen
          ? { flex: "1 1 auto", width: "auto" }
          : panelWidthPx !== null
            ? { flex: `0 0 ${panelWidthPx}px`, width: panelWidthPx }
            : undefined
      }
    >
      {!panelFullscreen && (
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
      <MemoWorkspacePanel
        platform={boot?.platform ?? "desktop"}
        projectName={projectName}
        workspaceRoot={workspaceRoot}
        onOpenWorkflows={sidebarOpenWorkflows}
        filesRefreshKey={filesRefreshKey}
        activeTab={panelTab}
        openTabs={panelTabs}
        startActive={panelStart}
        previewOnly={chatOnlyHosted}
        fullscreen={panelFullscreen}
        onSelectTab={openPanelTab}
        onCloseTab={closePanelTab}
        onAddTab={openPanelStart}
        onToggleFullscreen={() => setPanelFullscreen((v) => !v)}
        planMarkdown={
          livePlanStream !== null ? livePlanStream : (activeThread?.planMarkdown ?? "")
        }
        pageTitle={activeThread?.pageTitle}
        pageFileName={activeThread?.pageFileName}
        planTodos={panelPlanTodos}
        planTodosRunning={agentRunState?.running ?? false}
        canBuildPlan={Boolean(activeThread?.planMarkdown?.trim()) && !activeComposerBusy && !(agentRunState?.running ?? false)}
        diff={activeDiff}
        browserUrl={browserUrl}
        browserPartition={browserPartition}
        codeDisplay={panelCodeDisplay}
        browserControlEnabled={settings?.browserControlEnabled ?? true}
        onOpenGitDiff={openGitDiff}
        onNavigate={setBrowserUrl}
        onCollapse={collapsePanel}
        onOpenFolder={openFolder}
        onOpenBrowserSettings={openBrowserSettings}
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
        onFixSecurityFinding={fixSecurityFinding}
        onFixAllSecurityFindings={fixAllSecurityFindings}
        filesOpenRequest={filesOpenRequest}
        terminalEnv={env}
        terminalDefaultShell={settings?.defaultShell ?? null}
        terminalFontSize={settings?.terminalFontSize ?? 12}
        terminalScrollback={settings?.terminalScrollback ?? 5000}
        terminalCursorStyle={settings?.terminalCursorStyle ?? "bar"}
        terminalCopyOnSelect={settings?.terminalCopyOnSelect ?? true}
        terminalTheme={themeVariant}
        terminalAttachSessions={terminalAttachSessions}
        panelWidth={panelWidthPx}
      />
    </div>
  ) : null;

  const botHeaderNode = activeBot ? (
    <BotChatHeader
      bot={activeBot}
      onDetails={() => openBotDetails(activeBot.id)}
      onNewConversation={() => createBotConversation(activeBot.id)}
      members={botChips}
      onMention={mentionInComposer}
    />
  ) : null;

  return (
    <AppProviders
      language={language}
      onConductorRunStarted={() => {
        // Show the monitor for a new run, but never pull the user out of Settings or another page.
        if (chatOnlyHosted || (view !== "workspace" && view !== "conductor")) return;
        openPanelTab("conductorflow");
      }}
    >
    <div className="app">
      <TopBar
        platform={boot?.platform ?? "desktop"}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        canBack={threadHistory.canBack}
        canForward={threadHistory.canForward}
        onBack={threadHistory.back}
        onForward={threadHistory.forward}
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
            platform={boot?.platform ?? "desktop"}
            products={shellProducts}
            activeProduct={product}
            onSelectProduct={selectProduct}
            onNewItem={newItem}
            onOpenPlugins={sidebarOpenPlugins}
            onOpenSearch={() => setSearchOpen(true)}
            onOpenAutomations={() => setView("automations")}
            onOpenSuperagent={sidebarOpenSuperagent}
            onOpenWorkflows={() => sidebarOpenWorkflows(null)}
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
        <MemoSidebar
          platform={boot?.platform ?? "desktop"}
          activeView={view}
          products={shellProducts}
          activeProduct={product}
          onSelectProduct={selectProduct}
          botBody={botSidebarBody}
          projects={workspaceProjects}
          activeProjectId={activeProjectId}
          activeThreadId={activeThreadId}
          renamingThreadId={renamingThreadId}
          user={user}
          settings={settings ?? DEFAULT_SETTINGS}
          busy={busy}
          connecting={connecting}
          onNewTask={newItem}
          onNewTaskInProject={sidebarNewTaskInProject}
          onNewProject={sidebarNewProject}
          onSelectProject={sidebarSelectProject}
          onSelectTargetRepository={handleSelectTargetRepository}
          onSelectThread={sidebarSelectThread}
          onOpenSearch={sidebarOpenSearch}
          onThreadContext={sidebarThreadContext}
          onProjectContext={sidebarProjectContext}
          onRenameSubmit={sidebarRenameSubmit}
          onConnect={connect}
          onLogout={logout}
          onChangeSettings={patchSettings}
          onOpenUsage={sidebarOpenUsage}
          onOpenPlans={sidebarOpenPlans}
          onOpenSettings={sidebarOpenSettings}
          onOpenPlugins={sidebarOpenPlugins}
          onOpenAutomations={sidebarOpenAutomations}
          onOpenSuperagent={sidebarOpenSuperagent}
          onOpenWorkflows={sidebarOpenWorkflows}
          onOpenCustomize={sidebarOpenCustomize}
          pendingByThread={pendingByThread}
          runningThreadIds={runningThreadIds}
        />
        )}

        <div className="app__center">
          <Suspense fallback={<div className="app__center" />}>
          {view === "plugins" ? (
            <LazyPluginsView
              onOpenMcpSettings={() => openExtensionSettings("mcps")}
              onOpenCapabilitySettings={(kind) => openExtensionSettings("skills", kind)}
            />
          ) : view === "automations" ? (
            <LazyAutomationsView
              workspaceRoot={workspaceRoot}
              workspaces={automationWorkspaces}
              models={models}
              selectedModel={selectedModel}
              selectedProviderId={selectedProviderId}
              env={env}
              onOpenSshSettings={() => {
                setSettingsPage("sshHosts");
                setView("settings");
              }}
              onCreateInSession={(prompt) => newTask(undefined, undefined, undefined, prompt)}
            />
          ) : view === "superagent" ? (
            <LazySuperagentPage
              models={models}
              selectedProviderId={selectedProviderId}
              onBack={() => setView(sharedBackView)}
              // Agent mode: the setup tools save settings, which Ask and Plan do not allow.
              onSetupInChat={() => newTask("agent", "workspace", undefined, "/superagent ")}
            />
          ) : view === "workflows" ? (
            <LazyConductorWorkflowsView
              workspaceRoot={workspaceRoot}
              initialWorkflowId={selectedWorkflowForEdit}
              onBack={() => setView(composerMode === "conductor" ? "conductor" : "workspace")}
              onRunWorkflow={() => {
                // The run is already started; show it where it is monitored.
                setComposerMode("conductor");
                setView("conductor");
                openPanelTab("conductorflow");
              }}
              onCreateInChat={() => newTask("conductor", "conductor", undefined, "/pipeline ")}
            />
          ) : view === "botDetail" ? (
            <BotDetailView
              bot={bots.find((b) => b.id === botDetailId) ?? null}
              actions={botActions}
              routines={botRoutines}
              permissions={window.deyin.botPermissions}
              servers={window.deyin.engines}
              skills={window.deyin.botSkills ? { api: window.deyin.botSkills, ...(window.deyin.botTeach ? { teach: window.deyin.botTeach } : {}) } : undefined}
              files={window.deyin.botFiles}
              templates={window.deyin.botTemplates}
              connections={window.deyin.botSurfaces}
              avatarMaker={window.deyin.botAvatar ? { api: window.deyin.botAvatar, choices: avatarChoices } : undefined}
              roster={bots}
              onOpenServers={() => {
                setSettingsPage("botServers");
                setView("settings");
              }}
              onOpenVault={
                window.deyin.vault
                  ? () => {
                      setSettingsPage("vault");
                      setView("settings");
                    }
                  : undefined
              }
              onBack={() => (botDetailId ? openBot(botDetailId) : setView("bot"))}
              onDeleted={handleBotDeleted}
            />
          ) : view === "botMarket" && window.deyin.botTemplates ? (
            <BotMarketplace
              api={window.deyin.botTemplates}
              defaults={botModelDefaults}
              onOpenBot={openBot}
              onImport={() => setBotImport({})}
              onBack={() => setView("bot")}
            />
          ) : view === "bot" && !activeBot ? (
            botsReady ? (
              <BotHome
                activeCount={bots.filter((b) => !b.archived).length}
                onCreate={() => setBotCreateOpen(true)}
                {...(primaryBot ? { primary: primaryBot, onOpenPrimary: () => openBot(primaryBot.id) } : { onCreatePrimary: () => setBotCreateOpen(true) })}
                {...(bots.filter(canSitInRoom).length >= BOT_LIMITS.minRoomMembers ? { onCreateRoom: () => setBotRoomOpen(true) } : {})}
                {...(window.deyin.botTemplates ? { onBrowse: () => setView("botMarket"), onImport: () => setBotImport({}) } : {})}
              />
            ) : (
              <div className="bot-home" aria-busy="true" />
            )
          ) : view === "conductor" ? (
            <div className={`app__columns${panelOpen && panelFullscreen ? " app__columns--panel-full" : ""}`} ref={attachColumns}>
              <ConductorView
                workspaceRoot={workspaceRoot}
                activeThreadId={activeThreadId}
                chatEvents={chatEvents}
                chatStreamText={chatStreamText}
                chatStreamReasoning={chatOnlyHosted ? null : (agentRunState?.streamReasoning ?? null)}
                greetingName={greetingName}
                agentRunState={agentRunState}
                chatCodeDisplay={chatCodeDisplay}
                onOpenFile={chatOnlyHosted ? noop : openFileDiff}
                onOpenWorkspaceFile={chatOnlyHosted ? undefined : openWorkspaceFile}
                homeDir={boot?.homeDir ?? null}
                onUndo={chatOnlyHosted ? noop : undoFileChange}
                onRevertRun={chatOnlyHosted ? undefined : revertRunChanges}
                onEditMessage={chatOnlyHosted ? undefined : editMessageAtEvent}
                onForkAtEvent={forkAtEvent}
                onMessageFeedback={messageFeedback}
                onOpenAgentTerminal={
                  chatOnlyHosted
                    ? undefined
                    : hasAgentTerminal
                      ? openAgentTerminal
                      : undefined
                }
                threadTitles={threadTitles}
                header={conversationHeaderNode}
                dock={dockNode}
                composerNode={composerNode}
              />
              {panelNode}
            </div>
          ) : (<>
          <div className={`app__columns${panelOpen && panelFullscreen ? " app__columns--panel-full" : ""}`} ref={attachColumns}>
            <main className={`chat-column${isChatEmpty ? " chat-column--empty" : ""}`}>
              {activeBot ? botHeaderNode : conversationHeaderNode}

              <MemoChatView
                events={chatEvents}
                streamText={chatStreamText}
                streamReasoning={chatOnlyHosted ? null : (agentRunState?.streamReasoning ?? null)}
                greetingName={greetingName}
                emptyState={botEmptyState}
                threadKey={activeThreadId}
                codeDisplay={chatCodeDisplay}
                onOpenFile={chatOnlyHosted ? noop : openFileDiff}
                onOpenWorkspaceFile={chatOnlyHosted ? undefined : openWorkspaceFile}
                workspaceRoot={workspaceRoot}
                homeDir={boot?.homeDir ?? null}
                onUndo={chatOnlyHosted ? noop : undoFileChange}
                onRevertRun={chatOnlyHosted ? undefined : revertRunChanges}
                onEditMessage={chatOnlyHosted ? undefined : editMessageAtEvent}
                agentRunning={agentRunState?.running ?? false}
                reverting={reverting}
                onBuild={chatOnlyHosted ? undefined : buildFromPlan}
                canBuildPlan={chatOnlyHosted ? false : planCardBuildable}
                planMarkdown={chatOnlyHosted ? null : (activeThread?.planMarkdown ?? null)}
                onOpenPlan={chatOnlyHosted ? undefined : openPlanPanel}
                onOpenPreview={openPreviewPanel}
                planArtifact={chatOnlyHosted ? null : planArtifact}
                onOpenSubagent={chatOnlyHosted ? undefined : openSubagentPanel}
                onContinue={chatOnlyHosted ? undefined : continueFromStepLimit}
                onForkAtEvent={forkAtEvent}
                onMessageFeedback={messageFeedback}
                onOpenAgentTerminal={
                  chatOnlyHosted
                    ? undefined
                    : hasAgentTerminal
                      ? openAgentTerminal
                      : undefined
                }
                threadTitles={threadTitles}
              />

              {dockNode}

              {composerNode}
              {!chatOnlyHosted && (
                <SessionStatusLine
                  events={chatEvents}
                  tokenStats={sessionTokenStats}
                  cacheHitRate={activeCacheMetrics?.hitRate ?? null}
                />
              )}
            </main>

            {panelNode}
          </div>
          </>)}
          </Suspense>
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

      {botImport && window.deyin.botTemplates && (
        <BotImportDialog
          api={window.deyin.botTemplates}
          defaults={botModelDefaults}
          {...(botImport.text ? { initialText: botImport.text } : {})}
          onOpenBot={(bot) => {
            setBotImport(null);
            openBot(bot.id);
          }}
          onClose={() => setBotImport(null)}
        />
      )}

      {botCreateOpen && (
        <BotCreateDialog
          primary={nextBotIsPrimary}
          onCreate={botActions.create}
          onCreated={(bot) => {
            setBotCreateOpen(false);
            openBot(bot.id);
          }}
          onCancel={() => setBotCreateOpen(false)}
        />
      )}

      {botRoomOpen && (
        <BotRoomDialog
          bots={bots}
          onCreate={botActions.create}
          onCreated={(room) => {
            setBotRoomOpen(false);
            openBot(room.id);
          }}
          onCancel={() => setBotRoomOpen(false)}
        />
      )}

      {searchOpen && (
        <SearchOverlay
          projects={projects}
          onSelectThread={(_pid, tid) => {
            setActiveThreadId(tid);
            updateThread(tid, { unread: false });
            // Open it in its own product's shell: a Bot's chat is not a Code conversation.
            const found = projects.flatMap((p) => p.threads).find((t) => t.id === tid);
            setView(PRODUCTS[found ? productOfThread(found) : "code"].homeView);
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
          projects={workspaceProjects}
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

      <div className="agent-activity">
        <BrowserOverlay />
        <ComputerUseOverlay />
      </div>
      <AppApprovalDialog />
      <OriginApprovalDialog />
        <WorkspaceTrustDialog />
    </div>
    </AppProviders>
  );
}
