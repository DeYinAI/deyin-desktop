import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_SETTINGS, buildLinkedThreadContext, dedupeContextRefs, formatUserMessageWithContext } from "@deyin/host-core/shared";
import { streamChat } from "./api/openference.js";
import { I18nProvider } from "./i18n.js";
import { ApprovalDialog } from "./components/ApprovalDialog.js";
import { AskQuestionDialog, type QuestionItem } from "./components/AskQuestionDialog.js";
import { PlanApprovalDialog } from "./components/PlanApprovalDialog.js";
import { ComputerUseOverlay } from "./components/ComputerUseOverlay.js";
import { ChromeConsentDialog } from "./components/ChromeConsentDialog.js";
import { BrowserOverlay } from "./components/BrowserOverlay.js";
import { ChatView } from "./components/ChatView.js";
import { Composer } from "./components/Composer.js";
import { EnvironmentBadge } from "./components/EnvironmentBadge.js";
import { GitBranchBadge } from "./components/GitBranchBadge.js";
import { SearchOverlay } from "./components/SearchOverlay.js";
import { PlansView } from "./components/PlansView.js";
import { SettingsView } from "./components/SettingsView.js";
import { AutomationsView } from "./components/AutomationsView.js";
import { Sidebar } from "./components/Sidebar.js";
import { TerminalPanel } from "./components/TerminalPanel.js";
import { ThreadMenu, type ThreadAction } from "./components/ThreadMenu.js";
import { TopBar } from "./components/TopBar.js";
import { Icon } from "./components/Icon.js";
import { UpdateBanner } from "./components/UpdateBanner.js";
import { WhatsNewModal } from "./components/WhatsNewModal.js";
import { ReasonixOnboardModal } from "./components/ReasonixOnboardModal.js";
import { BetaFeedbackForm } from "./components/BetaFeedbackForm.js";
import { Welcome } from "./components/Welcome.js";
import { WorkspacePanel, type PanelTab } from "./components/WorkspacePanel.js";
import { ReviewBanner } from "./components/ReviewBanner.js";
import { highSeverityFindings } from "./components/SecurityFindingsPanel.js";
import { computeLineDiff, diffSnippet, type FileDiff } from "./diff.js";
import { TaskList } from "./components/TaskList.js";
import { generateThreadTitle } from "./autotitle.js";
import {
  useAgentStateController,
  useAgentRunState,
  useSessionTokenStats,
  agentStateStore,
} from "./hooks/useAgentState.js";
import {
  DEFAULT_THREAD_TITLE,
  deriveTitle,
  emptyThread,
  hydrateProjects,
  isBetterPlanDoc,
  looksLikePlan,
  newId,
  planFileNameFromTitle,
  planTitleFromMarkdown,
  toChatMessages,
  type Project,
  type Thread,
  type ThreadEvent,
} from "./threads.js";
import type { SettingsPage } from "./components/SettingsView.js";
import type {
 AgentEventEnvelope,
 AgentTodoItem,
 ApprovalMode,
 Bootstrap,
 ChatMode,
 ContextUsageSnapshot,
 ContextAttachment,
 LinkedThreadRef,
 PendingChange,
 DeyinSettings,
 DiffSnippetLine,
 EnvInfo,
 ModelInfo,
 ProviderInfo,
 UserProfile,
 SecurityFindingsReport,
} from "../shared/types.js";
import { TOOL_RESULT_UI_CAP, truncateToolResultUi } from "../shared/types.js";

/** Above this size we skip diff rendering (LCS is quadratic) but keep the card. */
const DIFF_MAX_LINES = 2000;

/** Adds/dels counts for a file card; falls back to a cheap estimate on big files. */
function diffStats(before: string, after: string): { adds: number; dels: number; renderable: boolean } {
  if (before === "" && after === "") return { adds: 0, dels: 0, renderable: false };
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of b) {
      const left = counts.get(line) ?? 0;
      if (left > 0) {
        common += 1;
        counts.set(line, left - 1);
      }
    }
    return { adds: b.length - common, dels: a.length - common, renderable: false };
  }
  let adds = 0;
  let dels = 0;
  for (const line of computeLineDiff(before, after)) {
    if (line.type === "add") adds += 1;
    else if (line.type === "del") dels += 1;
  }
  return { adds, dels, renderable: true };
}

const BUILD_PROMPT = "Implement the plan you proposed above. Follow it step by step, keep the todo list current, and report what you changed when done.";

type View = "workspace" | "settings" | "automations" | "upgrade";

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

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("openference");
  const [selectedModel, setSelectedModel] = useState<string>("GLM-5.2");
  const [composerMode, setComposerMode] = useState<ChatMode>("agent");
  const [input, setInput] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<ContextAttachment[]>([]);
  const [composerLinked, setComposerLinked] = useState<LinkedThreadRef[]>([]);
  const [pendingReview, setPendingReview] = useState<PendingChange[]>([]);
  const [securityReport, setSecurityReport] = useState<SecurityFindingsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const [showReasonixOnboard, setShowReasonixOnboard] = useState(false);
  const [showBetaFeedback, setShowBetaFeedback] = useState(false);

  const [agentThreadId, setAgentThreadId] = useState<string | null>(null);
  const [runEvents, setRunEvents] = useState<ThreadEvent[]>([]);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [question, setQuestion] = useState<PendingQuestion | null>(null);
  const [planApproval, setPlanApproval] = useState<PendingPlanApproval | null>(null);
  const [streamReasoning, setStreamReasoning] = useState<string | null>(null);
  const [planStream, setPlanStream] = useState<string | null>(null);
  const runToolIndex = useRef(new Map<string, number>());
  const runTextRef = useRef("");
  const planDocRef = useRef("");
  const planArtifactRef = useRef(false);
  const runTokensRef = useRef(0);
  const runOptimizationRef = useRef<Extract<ThreadEvent, { kind: "optimization" }> | null>(null);
  const runReasoningRef = useRef("");
  const reasoningStartRef = useRef(0);
  const runModeRef = useRef<ChatMode>("agent");
  const sessionTokenStats = useSessionTokenStats();
  const agentRunState = useAgentRunState(activeThreadId);
  useAgentStateController();
  /** Volatile diff contents per file path; thread events only persist the counts. */
  const fileDiffsRef = useRef(new Map<string, FileDiff>());
  /** Follow-up queued while a run is active; drained when the run finishes. */
  const [queuedPrompt, setQueuedPrompt] = useState<string | null>(null);
  const queuedPromptRef = useRef<string | null>(null);
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
  const ignoreNextDoneRef = useRef(false);
  const stopWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const plainChatAbortRef = useRef<AbortController | null>(null);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const composerModeRef = useRef(composerMode);
  composerModeRef.current = composerMode;
  const selectModeRef = useRef<(mode: ChatMode) => void>(() => undefined);
  const startAgentRunRef = useRef<(thread: Thread, text: string, mode: ChatMode) => void>(() => undefined);
  const [browserPartition, setBrowserPartition] = useState<string | null>(null);

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("plan");
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [browserUrl, setBrowserUrl] = useState("");
  const [terminalOpen, setTerminalOpen] = useState(false);
 /** Agent PTY sessions announced via shell-session, keyed for TerminalPanel attach. */
 const [agentTerminals, setAgentTerminals] = useState<{ id: string; label: string; threadId: string }[]>([]);

 const [searchOpen, setSearchOpen] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [threadMenu, setThreadMenu] = useState<{ threadId: string; x: number; y: number } | null>(null);

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
      if (!s.reasonixOnboardComplete) setShowReasonixOnboard(true);
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

  // Persist the project tree + selection once hydrated (the host owns workspaceRoot,
  // so it is intentionally not part of this patch).
  useEffect(() => {
    if (!projectsHydrated) return;
    void window.deyin.projects.set({ projects, activeProjectId, activeThreadId });
  }, [projectsHydrated, projects, activeProjectId, activeThreadId]);

  useEffect(() => {
    if (settings && !settings.enableDeliveryMode && composerMode === "delivery") {
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
  const planArtifact = useMemo(() => {
    if (planStream === null || agentThreadId === null || agentThreadId !== activeThreadId) return null;
    if (!planStream.trim()) return null;
    const title = planTitleFromMarkdown(planStream);
    return { title, fileName: planFileNameFromTitle(title) };
  }, [planStream, agentThreadId, activeThreadId]);

  // Restore the thread's composer mode when switching tasks.
  useEffect(() => {
    const thread = projects.flatMap((p) => p.threads).find((t) => t.id === activeThreadId);
    if (thread) setComposerMode(thread.mode ?? "agent");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  const patchSettings = useCallback((patch: Partial<DeyinSettings>) => {
    setSettings((cur) => (cur ? { ...cur, ...patch } : cur));
    void window.deyin.settings.set(patch).then(setSettings);
  }, []);

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
    if (terminalOpen) markOnboard("terminalUsed");
  }, [terminalOpen, markOnboard]);

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

  /** Find or create the folder-backed project for a workspace root. */
  const ensureFolderProject = useCallback(
    (root: string): Project => {
      const existing = projects.find((p) => p.root === root);
      if (existing) return existing;
      const project: Project = {
        id: newId("proj"),
        name: root.split(/[\\/]/).filter(Boolean).pop() ?? root,
        root,
        threads: [],
      };
      setProjects((cur) => (cur.some((p) => p.root === root) ? cur : [...cur, project]));
      return project;
    },
    [projects],
  );

  /** "+" / TopBar folder button: pick a folder; it becomes the active project. */
  const addProjectFolder = useCallback(async () => {
    const root = await window.deyin.workspace.openFolder();
    if (!root) return;
    const project = ensureFolderProject(root);
    setActiveProjectId(project.id);
    setWorkspaceRoot(root);
    markOnboard("workspaceOpened");
  }, [ensureFolderProject, markOnboard]);

  const selectProject = useCallback(
    async (projectId: string) => {
      setActiveProjectId(projectId);
      const root = projects.find((p) => p.id === projectId)?.root;
      if (root) {
        await window.deyin.workspace.setRoot(root);
        setWorkspaceRoot(root);
      }
    },
    [projects],
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

  /* Agent runtime: subscribe to main-process events for the active run. */
  useEffect(() => {
    if (!window.deyin.agent) return;
    const off = window.deyin.agent.onEvent((envelope: AgentEventEnvelope) => {
      const { threadId, event } = envelope;
      const flushReasoning = () => {
        const text = runReasoningRef.current;
        if (text.trim().length === 0) return;
        const seconds = Math.max(1, Math.round((Date.now() - reasoningStartRef.current) / 1000));
        runReasoningRef.current = "";
        setStreamReasoning(null);
        setRunEvents((cur) => [...cur, { kind: "reasoning", text, seconds }]);
      };
      const flushText = () => {
        flushReasoning();
        const text = runTextRef.current;
        runTextRef.current = "";
        setStreamText("");
        if (runModeRef.current === "plan") {
          // Only structured plan documents belong in the Plan tab.
          if (looksLikePlan(text) && isBetterPlanDoc(text, planDocRef.current)) {
            planDocRef.current = text;
            setPlanStream(planDocRef.current || null);
            return;
          }
          setPlanStream(planDocRef.current || null);
          if (text.trim().length > 0) setRunEvents((cur) => [...cur, { kind: "assistant", text }]);
          return;
        }
        setPlanStream(null);
        if (text.trim().length > 0) setRunEvents((cur) => [...cur, { kind: "assistant", text }]);
      };
      switch (event.type) {
        case "reasoning-delta":
          if (runReasoningRef.current.length === 0) reasoningStartRef.current = Date.now();
          runReasoningRef.current += event.delta;
          setStreamReasoning(runReasoningRef.current);
          break;
        case "text-delta":
          // The model moved from thinking to answering: fold the thought away.
          flushReasoning();
          runTextRef.current += event.delta;
          if (runModeRef.current === "plan") {
            const live = runTextRef.current;
            if (looksLikePlan(live)) {
              if (live === event.delta) {
                setPanelOpen(true);
                setPanelTab("plan");
              }
              if (isBetterPlanDoc(live, planDocRef.current)) {
                planDocRef.current = live;
              }
              setPlanStream(planDocRef.current || null);
            } else {
              setStreamText(live);
            }
          } else {
            setStreamText(runTextRef.current);
          }
          break;
        case "tool-start": {
          flushText();
          setRunEvents((cur) => {
            runToolIndex.current.set(event.callId, cur.length);
            return [...cur, { kind: "tool", name: event.name, summary: event.summary }];
          });
          break;
        }
        case "tool-delta": {
          setRunEvents((cur) => {
            const index = runToolIndex.current.get(event.callId);
            if (index === undefined || !cur[index] || cur[index]!.kind !== "tool") return cur;
            const prev = cur[index] as Extract<ThreadEvent, { kind: "tool" }>;
            let result = (prev.result ?? "") + event.delta;
            if (result.length > TOOL_RESULT_UI_CAP) {
              result = truncateToolResultUi(result);
            }
            const next = [...cur];
            next[index] = { ...prev, result };
            return next;
          });
          break;
        }
        case "tool-end": {
          setRunEvents((cur) => {
            const index = runToolIndex.current.get(event.callId);
            if (index === undefined || !cur[index] || cur[index]!.kind !== "tool") return cur;
            const next = [...cur];
            next[index] = { ...(next[index] as Extract<ThreadEvent, { kind: "tool" }>), result: event.result, ok: event.ok, denied: event.denied };
            return next;
          });
          break;
        }
        case "shell-session": {
          setAgentTerminals((cur) => {
            if (cur.some((t) => t.id === event.terminalId)) return cur;
            return [...cur, { id: event.terminalId, label: event.label, threadId }];
          });
          if (settingsRef.current?.revealTerminalOnAgentCommand !== false) {
            setTerminalOpen(true);
          }
          break;
        }
        case "file-change": {
          const stats = diffStats(event.before, event.after);
          let snippet: { snippet?: DiffSnippetLine[]; snippetMore?: number } = {};
          if (stats.renderable) {
            const fileDiff: FileDiff = { fileName: event.path, before: event.before, after: event.after };
            fileDiffsRef.current.set(event.path, fileDiff);
            setDiff(fileDiff); // Diff tab always shows the latest change.
            const excerpt = diffSnippet(event.before, event.after);
            if (excerpt.lines.length > 0) snippet = { snippet: excerpt.lines, snippetMore: excerpt.more };
          }
          const name = event.path.split(/[\\/]/).pop() ?? event.path;
          setRunEvents((cur) => [
            ...cur,
            { kind: "file", name, subtitle: event.path, adds: stats.adds, dels: stats.dels, ...snippet },
          ]);
          setPendingReview((cur) => cur.filter((c) => c.path !== event.path || c.status !== "pending"));
          break;
        }
        case "pending-change": {
          setPendingReview((cur) => [...cur.filter((c) => c.id !== event.change.id), event.change]);
          const fileDiff: FileDiff = { fileName: event.change.path, before: event.change.before, after: event.change.after };
          fileDiffsRef.current.set(event.change.path, fileDiff);
          setDiff(fileDiff);
          setPanelOpen(true);
          setPanelTab("diff");
          break;
        }
        case "pending-change-resolved": {
          setPendingReview((cur) => cur.filter((c) => c.id !== event.changeId));
          break;
        }
        case "goal-updated": {
          setProjects((cur) =>
            cur.map((p) => ({
              ...p,
              threads: p.threads.map((th) =>
                th.id === threadId ? { ...th, goal: event.goal ?? undefined } : th,
              ),
            })),
          );
          break;
        }
        case "todos": {
          const steps = event.todos.map((t) => ({
            text: t.content,
            done: t.status === "completed",
            status: t.status,
            acceptanceCriteria: t.acceptanceCriteria,
            signedOff: t.signedOff,
          }));
          setRunEvents((cur) => {
            const index = cur.findIndex((e) => e.kind === "plan");
            if (index >= 0) {
              const next = [...cur];
              next[index] = { kind: "plan", steps };
              return next;
            }
            return [...cur, { kind: "plan", steps }];
          });
          // Persist on the thread: the pinned task list survives run folding
          // and app restarts.
          setProjects((cur) =>
            cur.map((project) => ({
              ...project,
              threads: project.threads.map((th) => (th.id === threadId ? { ...th, todos: event.todos } : th)),
            })),
          );
          break;
        }
        case "evidence-gate":
          setRunEvents((cur) => [...cur, { kind: "evidence-gate", code: event.code, message: event.message }]);
          break;
        case "evidence-sign-off": {
          setRunEvents((cur) => [
            ...cur,
            {
              kind: "evidence-sign-off",
              stepId: event.stepId,
              verificationCommand: event.verificationCommand,
              diffSummary: event.diffSummary,
              reviewNotes: event.reviewNotes,
            },
          ]);
          setProjects((cur) =>
            cur.map((project) => ({
              ...project,
              threads: project.threads.map((th) =>
                th.id === threadId
                  ? {
                      ...th,
                      todos: th.todos?.map((todo) =>
                        todo.id === event.stepId ? { ...todo, signedOff: true, signOffNotes: event.reviewNotes } : todo,
                      ),
                    }
                  : th,
              ),
            })),
          );
          break;
        }
        case "usage":
          runTokensRef.current = event.totalTokens;
          break;
        case "optimization": {
          const cacheHitRate = event.cacheHitRate;
          const cachePatch =
            cacheHitRate !== undefined &&
            event.sessionCacheHit !== undefined &&
            event.sessionCacheMiss !== undefined
              ? {
                  hitRate: cacheHitRate,
                  sessionHit: event.sessionCacheHit,
                  sessionMiss: event.sessionCacheMiss,
                  prefixChanged: event.prefixChanged,
                  changeReasons: event.changeReasons,
                }
              : null;
          if (cachePatch) {
            setCacheByThread((cur) => ({ ...cur, [threadId]: cachePatch }));
            setContextByThread((cur) => {
              const snap = cur[threadId];
              if (!snap) return cur;
              return { ...cur, [threadId]: { ...snap, cache: cachePatch } };
            });
          }
          runOptimizationRef.current = {
            kind: "optimization",
            originalInputTokens: event.originalInputTokens,
            compressedInputTokens: event.compressedInputTokens,
            compressionRatio: event.compressionRatio,
            cachedPromptTokens: event.cachedPromptTokens,
            toolCacheHits: event.toolCacheHits,
            toolCacheMisses: event.toolCacheMisses,
            responseCacheHits: event.responseCacheHits,
            responseCacheMisses: event.responseCacheMisses,
            estimatedCostSavingsUsd: event.estimatedCostSavingsUsd,
            sessionCacheHit: event.sessionCacheHit,
            sessionCacheMiss: event.sessionCacheMiss,
            cacheHitRate: event.cacheHitRate,
            prefixChanged: event.prefixChanged,
            changeReasons: event.changeReasons,
          };
          break;
        }
        case "compaction": {
          if (event.softWarning) {
            setCompactionNoticeByThread((cur) => ({
              ...cur,
              [threadId]:
                "Context is over 50% full. Compaction will run soon if usage keeps growing — earlier messages may be summarized.",
            }));
          } else if (event.droppedMessages > 0 || event.truncatedToolResults > 0 || event.truncatedToolArgs > 0) {
            const parts: string[] = [];
            if (event.droppedMessages > 0) parts.push(`${event.droppedMessages} messages summarized`);
            if (event.truncatedToolResults > 0) parts.push(`${event.truncatedToolResults} tool results shortened`);
            if (event.truncatedToolArgs > 0) parts.push(`${event.truncatedToolArgs} tool args trimmed`);
            setCompactionNoticeByThread((cur) => ({
              ...cur,
              [threadId]: `Context compacted (${parts.join(", ")}). Prefix cache was refreshed.`,
            }));
            setRunEvents((cur) => [
              ...cur,
              {
                kind: "compaction-notice",
                softWarning: false,
                truncatedToolResults: event.truncatedToolResults,
                truncatedToolArgs: event.truncatedToolArgs,
                droppedMessages: event.droppedMessages,
              },
            ]);
          }
          break;
        }
        case "context-snapshot":
          setContextByThread((cur) => {
            const prevCache = cur[threadId]?.cache;
            return {
              ...cur,
              [threadId]: prevCache ? { ...event.snapshot, cache: prevCache } : event.snapshot,
            };
          });
          break;
        case "permission-request":
          setApproval({ requestId: event.requestId, toolName: event.toolName, summary: event.summary });
          break;
        case "question-request":
          setQuestion({ requestId: event.requestId, title: event.title, questions: event.questions });
          break;
        case "plan-created": {
          const planTitle = planTitleFromMarkdown(event.plan);
          planDocRef.current = event.plan;
          planArtifactRef.current = true;
          setPlanStream(event.plan);
          setPanelOpen(true);
          setPanelTab("plan");
          setPlanApproval({
            threadId,
            title: event.name || planTitle,
            overview: event.overview,
            plan: event.plan,
            filePath: event.filePath,
          });
          setProjects((cur) =>
            cur.map((project) => ({
              ...project,
              threads: project.threads.map((th) =>
                th.id === threadId
                  ? {
                      ...th,
                      planMarkdown: event.plan,
                      planFilePath: event.filePath,
                      planApproved: false,
                    }
                  : th,
              ),
            })),
          );
          setRunEvents((cur) => [
            ...cur,
            {
              kind: "plan-ready",
              title: event.name || planTitle,
              fileName: planFileNameFromTitle(event.name || planTitle),
            },
          ]);
          break;
        }
        case "mode-changed":
          if (event.mode) selectModeRef.current(event.mode);
          break;
        case "subagent-start":
          flushText();
          setRunEvents((cur) => [...cur, { kind: "thought", label: `Subagent ${event.name} started` }]);
          break;
        case "subagent-end":
          setRunEvents((cur) => [...cur, { kind: "thought", label: `Subagent ${event.name} ${event.ok ? "finished" : "failed"}` }]);
          break;
        case "phase":
          setRunEvents((cur) => [...cur, { kind: "thought", label: event.detail ? `${event.text}: ${event.detail}` : event.text }]);
          break;
        case "coordinator-routing":
          setRunEvents((cur) => [
            ...cur,
            { kind: "thought", label: `Coordinator → ${event.route} (${event.reason})` },
          ]);
          break;
        case "background-job":
          setRunEvents((cur) => [
            ...cur,
            { kind: "thought", label: `Background job ${event.label ?? event.jobId}: ${event.status}` },
          ]);
          break;
        case "error":
          setRunEvents((cur) => [...cur, { kind: "error", text: event.message }]);
          break;
        case "done": {
          if (ignoreNextDoneRef.current) {
            ignoreNextDoneRef.current = false;
            break;
          }
          // Fold the run into the persisted thread: run events + final text.
          const text = runTextRef.current.trim().length > 0 ? runTextRef.current : event.finalText;
          const reasoning = runReasoningRef.current;
          const reasoningSeconds = Math.max(1, Math.round((Date.now() - reasoningStartRef.current) / 1000));
          runTextRef.current = "";
          runReasoningRef.current = "";
          // Plan mode: keep the best plan document in the Plan tab; chat only
          // gets a compact plan-file card. Aborted plans still land in the tab.
          let planText = planDocRef.current;
          if (runModeRef.current === "plan" && looksLikePlan(text) && isBetterPlanDoc(text, planText)) {
            planText = text;
          }
          planDocRef.current = "";
          const planRun =
            runModeRef.current === "plan" && planText.trim().length > 0 && looksLikePlan(planText);
          const planFinished = planRun && event.reason === "completed";
          const planTitle = planRun ? planTitleFromMarkdown(planText) : undefined;
          if (stopWatchdogRef.current) {
            clearTimeout(stopWatchdogRef.current);
            stopWatchdogRef.current = null;
          }
          setRunEvents((cur) => {
            const finished: ThreadEvent[] = [...cur];
            if (reasoning.trim().length > 0) finished.push({ kind: "reasoning", text: reasoning, seconds: reasoningSeconds });
            if (text.trim().length > 0 && !planRun) finished.push({ kind: "assistant", text });
            if (planFinished && !planArtifactRef.current) {
              finished.push({
                kind: "plan-ready",
                title: planTitle,
                fileName: planFileNameFromTitle(planTitle ?? "plan"),
              });
            }
            if (event.reason === "aborted") finished.push({ kind: "thought", label: "Run stopped" });
            if (event.reason === "max-steps") finished.push({ kind: "thought", label: "Stopped after reaching the step limit" });
            // Optimization summary: surface when compression or caches saved anything.
            const opt = runOptimizationRef.current;
            if (
              opt &&
              (opt.originalInputTokens > opt.compressedInputTokens ||
                opt.cachedPromptTokens > 0 ||
                opt.toolCacheHits > 0 ||
                opt.responseCacheHits > 0 ||
                (opt.cacheHitRate ?? 0) > 0)
            ) {
              finished.push(opt);
            }
            runOptimizationRef.current = null;
            appendEvents(threadId, finished);
            return [];
          });
          if (planRun) {
            setProjects((cur) =>
              cur.map((project) => ({
                ...project,
                threads: project.threads.map((th) => (th.id === threadId ? { ...th, planMarkdown: planText } : th)),
              })),
            );
            if (planFinished) {
              setPanelOpen(true);
              setPanelTab("plan");
            }
          }
          runToolIndex.current.clear();
          setStreamText(null);
          setStreamReasoning(null);
          setPlanStream(null);
          setAgentThreadId(null);
          agentStateStore.clearRun(threadId);
          setApproval(null);
          setQuestion(null);
          markOnboard("taskRun");
          void window.deyin.usage.record({ model: selectedModel, tokens: runTokensRef.current, newSession: false });
          runTokensRef.current = 0;

          // Interrupt-and-send takes priority over a queued follow-up.
          const sendNow = pendingSendNowRef.current;
          pendingSendNowRef.current = null;
          if (sendNow) {
            queuedPromptRef.current = null;
            setQueuedPrompt(null);
            const thread =
              projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === sendNow.threadId) ?? null;
            if (thread) {
              // Defer so main has removed this thread from `active` before restart.
              queueMicrotask(() => startAgentRunRef.current(thread, sendNow.text, sendNow.mode));
            }
            break;
          }
          const queued = queuedPromptRef.current;
          if (queued) {
            queuedPromptRef.current = null;
            setQueuedPrompt(null);
            const thread = projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === threadId) ?? null;
            if (thread) {
              const mode = composerModeRef.current;
              queueMicrotask(() => startAgentRunRef.current(thread, queued, mode));
            }
          }
          break;
        }
      }
    });
    return off;
  }, [appendEvents, markOnboard, selectedModel]);

  // Main asks us to surface the Browser tab when agent browser tools need a target.
  useEffect(() => {
    if (!window.deyin.browserControl) return;
    const off = window.deyin.browserControl.onEnsure(() => {
      setPanelOpen(true);
      setPanelTab("browser");
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
          createdProject = ensureFolderProject(root);
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
  const [themeVariant, setThemeVariant] = useState<"light" | "dark">("dark");
  useEffect(() => {
    const pref = settings?.theme ?? "dark";
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const variant = pref === "system" ? (mql.matches ? "dark" : "light") : pref;
      document.documentElement.dataset.theme = variant;
      setThemeVariant(variant);
    };
    apply();
    if (pref === "system") {
      mql.addEventListener("change", apply);
      return () => mql.removeEventListener("change", apply);
    }
  }, [settings?.theme]);

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
      meta?: { attachments?: ContextAttachment[]; linkedThreadIds?: string[] },
    ) => {
      const attachments = meta?.attachments ?? [];
      const linkedThreadIds = meta?.linkedThreadIds ?? [];
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
      appendEvents(thread.id, [{ kind: "user", text, attachments, linkedThreadIds }]);
      setStreamText("");
      setStreamReasoning(null);
      setPlanStream(null);
      setAgentThreadId(thread.id);
      agentStateStore.startRun(thread.id, mode);
      setRunEvents([]);
      runToolIndex.current.clear();
      runTextRef.current = "";
      planDocRef.current = "";
      planArtifactRef.current = false;
      runReasoningRef.current = "";
      runTokensRef.current = 0;
      runOptimizationRef.current = null;
      runModeRef.current = mode;
      ignoreNextDoneRef.current = false;
      if (isFirstMessage) void window.deyin.usage.record({ model: selectedModel, tokens: 0, newSession: true });
      void window.deyin.agent.start({
        threadId: thread.id,
        prompt: agentPrompt,
        providerId: selectedProviderId,
        model: selectedModel,
        thinking: settings?.thinking ?? true,
        approvalMode: settings?.approvalMode ?? "full-access",
        mode,
        history: toChatMessages(thread.events),
        initialTodos: thread.todos,
        goalText: thread.goal?.status === "active" ? thread.goal.text : undefined,
      });
    },
    [appendEvents, selectedModel, selectedProviderId, settings],
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
    const threadId = agentThreadId;
    if (plainChatAbortRef.current) {
      plainChatAbortRef.current.abort();
      plainChatAbortRef.current = null;
      setStreamText(null);
      return;
    }
    if (!threadId) {
      setStreamText(null);
      setStreamReasoning(null);
      return;
    }

    window.deyin.agent?.stop(threadId);
    setApproval(null);
    // Unlock the composer immediately; fold + clear still happen on `done`.
    setStreamText(null);
    setStreamReasoning(null);

    if (stopWatchdogRef.current) clearTimeout(stopWatchdogRef.current);
    stopWatchdogRef.current = setTimeout(() => {
      stopWatchdogRef.current = null;
      // Main never emitted `done` — force-clear so the UI cannot stay wedged.
      ignoreNextDoneRef.current = true;
      setRunEvents((cur) => {
        const finished = [...cur, { kind: "thought" as const, label: "Run stopped" }];
        appendEvents(threadId, finished);
        return [];
      });
      runToolIndex.current.clear();
      runTextRef.current = "";
      runReasoningRef.current = "";
      runOptimizationRef.current = null;
      setStreamText(null);
      setStreamReasoning(null);
      setPlanStream(null);
      setAgentThreadId(null);
      setApproval(null);

      const sendNow = pendingSendNowRef.current;
      pendingSendNowRef.current = null;
      if (sendNow) {
        queuedPromptRef.current = null;
        setQueuedPrompt(null);
        const thread = projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === sendNow.threadId) ?? null;
        if (thread) startAgentRunRef.current(thread, sendNow.text, sendNow.mode);
        return;
      }
      const queued = queuedPromptRef.current;
      if (queued) {
        queuedPromptRef.current = null;
        setQueuedPrompt(null);
        const thread = projectsRef.current.flatMap((p) => p.threads).find((t) => t.id === threadId) ?? null;
        if (thread) startAgentRunRef.current(thread, queued, composerModeRef.current);
      }
    }, 3_000);
  }, [agentThreadId, appendEvents]);

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
    if (!activeThread || streamText !== null) return;
    selectMode("agent");
    const plan = activeThread.planMarkdown?.trim();
    const prompt = plan
      ? `${BUILD_PROMPT}\n\n---\nPlan to implement:\n${plan}\n---`
      : BUILD_PROMPT;
    startAgentRun(activeThread, prompt, "agent");
    setPlanApproval(null);
    if (activeThreadId) updateThread(activeThreadId, { planApproved: true });
  }, [activeThread, activeThreadId, streamText, selectMode, startAgentRun, updateThread]);

  const rejectPlan = useCallback(() => {
    setPlanApproval(null);
    if (!activeThread || streamText !== null || agentThreadId !== null) return;
    selectMode("plan");
    startAgentRun(activeThread, "Please revise the plan based on my feedback.", "plan");
  }, [activeThread, agentThreadId, streamText, selectMode, startAgentRun]);

  /** File card "Open": show that change in the Diff tab (when we still hold it). */
  const openFileDiff = useCallback((path: string) => {
    const fileDiff = fileDiffsRef.current.get(path);
    if (fileDiff) setDiff(fileDiff);
    setPanelOpen(true);
    setPanelTab("diff");
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !boot) return;

    // While a run is active, Enter/Send queues the follow-up (Cursor-like).
    const runActive = streamText !== null || agentThreadId !== null;
    if (runActive) {
      queuedPromptRef.current = text;
      setQueuedPrompt(text);
      setInput("");
      return;
    }

    // First send before any task exists: create the thread instead of dropping
    // the click — the composer must never silently no-op.
    let thread = activeThread;
    if (!thread) {
      const newThread: Thread = { ...emptyThread(), mode: composerMode };
      setProjects((cur) => {
        if (cur.length === 0) {
          return [{ id: newId("proj"), name: "Workspace", root: null, threads: [newThread] }];
        }
        const target = cur.some((p) => p.id === activeProjectId) ? activeProjectId! : cur[0]!.id;
        return cur.map((p) => (p.id === target ? { ...p, threads: [newThread, ...p.threads] } : p));
      });
      setActiveThreadId(newThread.id);
      thread = newThread;
    }

    // Route to the selected provider: primary uses the Openference OAuth token,
    // custom providers use their stored base URL + API key.
    const provider = providers.find((p) => p.id === selectedProviderId);
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
      if (!token) {
        appendEvents(thread.id, [
          { kind: "assistant", text: `No API key stored for ${provider.name}. Add one in Settings → Model settings.` },
        ]);
        return;
      }
    }

    const isFirstMessage = toChatMessages(thread.events).length === 0;
    const history = [...toChatMessages(thread.events), { role: "user" as const, content: text }];

    if (isFirstMessage && thread.title === DEFAULT_THREAD_TITLE) {
      const provisional = deriveTitle(text);
      updateThread(thread.id, { title: provisional });
      const threadId = thread.id;
      // Skip the LLM call when the provisional title is already short enough.
      const needsLlmTitle = provisional.endsWith("…") || provisional.split(/\s+/).length > 6;
      if (needsLlmTitle) {
        void generateThreadTitle({ apiBaseUrl, token, model: selectedModel, text })
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

    // Agent runtime (default on desktop): run the tool-calling loop in the main
    // process in the selected composer mode; falls back to the plain text
    // stream when switched off (or on the web, which has no agent host yet).
    if ((settings?.agentMode ?? "agent") === "agent" && boot.platform === "desktop" && window.deyin.agent) {
      setInput("");
      const sendMeta = {
        attachments: [...composerAttachments],
        linkedThreadIds: composerLinked.map((l) => l.threadId),
      };
      setComposerAttachments([]);
      setComposerLinked([]);
      void startAgentRun(thread, text, composerMode, sendMeta);
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
        token,
        model: selectedModel,
        messages: history,
        thinking: settings?.thinking,
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
      setStreamText(null);
      // Real token usage from the provider's final stream frame. Providers that
      // report none record 0 tokens; message/session counts still apply.
      void window.deyin.usage.record({ model: selectedModel, tokens: reportedTokens, newSession: isFirstMessage });
    }
  }, [input, streamText, agentThreadId, activeThread, activeProjectId, boot, providers, selectedProviderId, selectedModel, settings, composerMode, composerAttachments, composerLinked, connect, appendEvents, startAgentRun, updateThread]);

  /** Abort the current run and send immediately (does not wait for natural completion). */
  const sendNow = useCallback(() => {
    const fromInput = input.trim();
    const text = fromInput || queuedPromptRef.current?.trim() || "";
    if (!text || !activeThread) return;

    setInput("");
    queuedPromptRef.current = null;
    setQueuedPrompt(null);

    const runActive = streamText !== null || agentThreadId !== null || plainChatAbortRef.current !== null;
    if (!runActive) {
      if ((settings?.agentMode ?? "agent") === "agent" && boot?.platform === "desktop" && window.deyin.agent) {
        startAgentRun(activeThread, text, composerMode);
      }
      return;
    }

    pendingSendNowRef.current = { threadId: activeThread.id, text, mode: composerMode };
    stopRun();
  }, [input, activeThread, streamText, agentThreadId, settings, boot, composerMode, startAgentRun, stopRun]);

  const clearQueue = useCallback(() => {
    queuedPromptRef.current = null;
    setQueuedPrompt(null);
  }, []);

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

  const language = settings?.language ?? "en";

  // Signed-out desktop users see the Welcome screen first, unless they chose
  // the API-key path (persisted as settings.welcomeDismissed). While settings
  // load, keep showing Welcome to avoid a workspace flash. (Web signs in via a
  // full-page redirect, so it never sits in this state.)
  if (boot && boot.platform === "desktop" && !user && !settings?.welcomeDismissed) {
    return (
      <I18nProvider language={language}>
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
      </I18nProvider>
    );
  }

  if (view === "settings" && settings && boot) {
    return (
      <I18nProvider language={language}>
        <div className="app">
          {boot.platform === "desktop" ? <UpdateBanner /> : null}
          <SettingsView
            key={settingsPage}
            initialPage={settingsPage}
            settings={settings}
            user={user}
            busy={busy}
            version={boot.version}
            workspaceRoot={workspaceRoot}
            activeThreadId={activeThreadId}
            liveModels={models}
            onChangeSettings={patchSettings}
            onConnect={connect}
            onBack={() => setView("workspace")}
            onOpenFolder={() => void addProjectFolder()}
            onOpenTerminal={() => {
              setView("workspace");
              setTerminalOpen(true);
            }}
            onRefreshLiveModels={async () => {
              setModels(await window.deyin.models.refresh());
            }}
          />
        </div>
      </I18nProvider>
    );
  }

  if (view === "upgrade" && boot) {
    return (
      <I18nProvider language={language}>
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
      </I18nProvider>
    );
  }

  return (
    <I18nProvider language={language}>
    <div className="app">
      <TopBar
        platform={boot?.platform ?? "desktop"}
        threadId={activeThreadId}
        threadTitle={activeThread?.title ?? DEFAULT_THREAD_TITLE}
        threadPinned={activeThread?.pinned ?? false}
        projectName={projectName}
        workspaceRoot={workspaceRoot}
        panelOpen={panelOpen}
        terminalOpen={terminalOpen}
        cacheHitRate={activeCacheMetrics?.hitRate ?? null}
        sessionCacheHit={activeCacheMetrics?.sessionHit}
        sessionCacheMiss={activeCacheMetrics?.sessionMiss}
        tokenStats={sessionTokenStats}
        onOpenFolder={() => void addProjectFolder()}
        onTogglePanel={() => {
          setPanelOpen((v) => !v);
          setView("workspace");
        }}
        onToggleTerminal={() => {
          setTerminalOpen((v) => !v);
          setView("workspace");
        }}
        onThreadAction={handleThreadAction}
      />
      {boot?.platform === "desktop" ? <UpdateBanner /> : null}

      <div className="app__body">
        <Sidebar
          platform={boot?.platform ?? "desktop"}
          projects={projects}
          activeProjectId={activeProjectId}
          activeThreadId={activeThreadId}
          renamingThreadId={renamingThreadId}
          user={user}
          settings={settings ?? DEFAULT_SETTINGS}
          busy={busy}
          connecting={connecting}
          onNewTask={newTask}
          onNewProject={() => void addProjectFolder()}
          onSelectProject={(projectId) => {
            void selectProject(projectId);
            setView("workspace");
          }}
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
          onChangeSettings={patchSettings}
          onOpenUsage={() => {
            setSettingsPage("usage");
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
        />

        <div className="app__center">
          {view === "automations" && settings && boot?.platform === "desktop" ? (
            <AutomationsView
              workspaceRoot={workspaceRoot}
              providers={providers}
              models={models}
              selectedModel={selectedModel}
              selectedProviderId={selectedProviderId}
              onOpenSshSettings={() => {
                setSettingsPage("sshHosts");
                setView("settings");
              }}
            />
          ) : (
            <>
          <div className="app__columns">
            <main className="chat-column">
              <div className="chat-column__bar">
                <EnvironmentBadge
                  env={env}
                  onPickShell={() => setTerminalOpen(true)}
                />
                <GitBranchBadge
                  workspaceRoot={workspaceRoot}
                  onOpenSourceControl={() => {
                    setPanelOpen(true);
                    setPanelTab("git");
                  }}
                />
              </div>

              <ChatView
                events={[
                  ...(activeThread?.events ?? []),
                  ...(agentThreadId !== null && agentThreadId === activeThreadId ? runEvents : []),
                ]}
                streamText={agentThreadId === null || agentThreadId === activeThreadId ? streamText : null}
                streamReasoning={agentThreadId === null || agentThreadId === activeThreadId ? streamReasoning : null}
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
                onUndo={() => setDiff(null)}
                onBuild={buildFromPlan}
                onRevisePlan={rejectPlan}
                onEditPlan={() => {
                  if (planApproval?.filePath) void window.deyin.shell.showItem(planApproval.filePath);
                  setPlanApproval(null);
                }}
                pendingPlan={planApproval && planApproval.threadId === activeThreadId ? planApproval : null}
                onOpenPlan={() => {
                  setPanelOpen(true);
                  setPanelTab("plan");
                }}
                planArtifact={planArtifact}
                onOpenAgentTerminal={
                  agentTerminals.some((t) => t.threadId === activeThreadId)
                    ? () => setTerminalOpen(true)
                    : undefined
                }
                threadTitles={Object.fromEntries((activeProject?.threads ?? []).map((t) => [t.id, t.title]))}
              />

              {(activeThread?.todos?.length ?? 0) > 0 && (
                <div className="chat-column__tasks">
                  <TaskList
                    todos={activeThread!.todos!}
                    running={agentThreadId !== null && agentThreadId === activeThreadId}
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
                    setPanelOpen(true);
                    setPanelTab("security");
                  }}
                />
                {approval && (
                  <ApprovalDialog
                    toolName={approval.toolName}
                    summary={approval.summary}
                    onDecision={(decision) => {
                      window.deyin.agent?.approve(approval.requestId, decision);
                      setApproval(null);
                    }}
                  />
                )}
                {planApproval && (
                  <PlanApprovalDialog
                    title={planApproval.title}
                    overview={planApproval.overview}
                    onApprove={buildFromPlan}
                    onReject={rejectPlan}
                    onEdit={() => {
                      if (planApproval.filePath) void window.deyin.shell.showItem(planApproval.filePath);
                      setPlanApproval(null);
                    }}
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
                <Composer
                  value={input}
                  models={models}
                  selectedModel={selectedModel}
                  approvalMode={settings?.approvalMode ?? "full-access"}
                  mode={
                    boot?.platform === "desktop" && (settings?.agentMode ?? "agent") === "agent"
                      ? composerMode
                      : undefined
                  }
                  deliveryModeEnabled={settings?.enableDeliveryMode ?? false}
                  thinking={settings?.thinking ?? true}
                  canSend={input.trim().length > 0}
                  streaming={streamText !== null || agentThreadId !== null}
                  runStatus={agentThreadId === activeThreadId ? agentRunState?.status ?? null : null}
                  queuedPrompt={queuedPrompt}
                  hasEvents={(activeThread?.events.length ?? 0) > 0}
                  providers={providers}
                  selectedProviderId={selectedProviderId}
                  onChange={setInput}
                  onSend={() => void send()}
                  onSendNow={sendNow}
                  onClearQueue={clearQueue}
                  onStop={streamText !== null || agentThreadId !== null ? stopRun : undefined}
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
                  onSelectMode={selectMode}
                  onToggleThinking={(on) => patchSettings({ thinking: on })}
                  contextSnapshot={activeContextSnapshot}
                  contextLength={selectedContextLength}
                  threadKey={activeThreadId}
                  compactionNotice={activeCompactionNotice}
                  attachments={composerAttachments}
                  onAttachmentsChange={setComposerAttachments}
                  linkedThreads={composerLinked}
                  onLinkedThreadsChange={setComposerLinked}
                  threadsForPicker={activeProject?.threads}
                  activeThreadId={activeThreadId}
                  workspaceRoot={workspaceRoot}
                  goalText={activeThread?.goal?.status === "active" ? activeThread.goal.text : null}
                  onSetGoal={(text) => {
                    if (!activeThreadId) return;
                    updateThread(activeThreadId, {
                      goal: text ? { text, status: "active" } : undefined,
                    });
                  }}
                />
              </div>
            </main>

            {panelOpen && (
              <WorkspacePanel
                platform={boot?.platform ?? "desktop"}
                projectName={projectName}
                workspaceRoot={workspaceRoot}
                activeTab={panelTab}
                planMarkdown={
                  planStream !== null && agentThreadId === activeThreadId
                    ? planStream
                    : (activeThread?.planMarkdown ?? "")
                }
                planTodos={activeThread?.todos ?? []}
                planTodosRunning={agentThreadId !== null && agentThreadId === activeThreadId}
                canBuildPlan={Boolean(activeThread?.planMarkdown?.trim()) && streamText === null}
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
                onSelectTab={setPanelTab}
                onOpenGitDiff={(d) => {
                  setDiff(d);
                  setPanelOpen(true);
                  setPanelTab("diff");
                }}
                onNavigate={setBrowserUrl}
                onCollapse={() => setPanelOpen(false)}
                onOpenFolder={() => void addProjectFolder()}
                onOpenBrowserSettings={() => {
                  setSettingsPage("browser");
                  setView("settings");
                }}
                onBuildPlan={buildFromPlan}
                onPlanTodosChange={updatePlanTodos}
                pendingReview={pendingReview}
                onApproveChange={approveReview}
                onRejectChange={rejectReview}
                threadId={activeThreadId}
                onOpenFile={(path) => {
                  void window.deyin.shell.showItem(path);
                  setPanelOpen(true);
                  setPanelTab("files");
                }}
              />
            )}
          </div>

          {terminalOpen && (
            <TerminalPanel
              cwd={workspaceRoot}
              env={env}
              defaultShell={settings?.defaultShell ?? null}
              fontSize={settings?.terminalFontSize ?? 12}
              scrollback={settings?.terminalScrollback ?? 5000}
              attachSessions={agentTerminals
                .filter((t) => t.threadId === activeThreadId)
                .map((t) => ({ id: t.id, label: t.label }))}
              onClose={() => setTerminalOpen(false)}
            />
          )}
            </>
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
            setView("workspace");
          }}
          onOpenUrl={(url) => {
            setPanelOpen(true);
            setPanelTab("browser");
            setBrowserUrl(url);
            setView("workspace");
          }}
          onClose={() => setSearchOpen(false)}
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
      {showReasonixOnboard && settings && (
        <ReasonixOnboardModal
          settings={settings}
          onSkip={() => {
            setShowReasonixOnboard(false);
            patchSettings({ reasonixOnboardComplete: true });
          }}
          onComplete={() => {
            setShowReasonixOnboard(false);
            patchSettings({ reasonixOnboardComplete: true });
            setSettingsPage("cache");
            setView("settings");
          }}
        />
      )}
      {showBetaFeedback && <BetaFeedbackForm onClose={() => setShowBetaFeedback(false)} />}

      <ComputerUseOverlay />
      <ChromeConsentDialog />
      <BrowserOverlay />
    </div>
    </I18nProvider>
  );
}
