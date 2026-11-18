import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n.js";
import { AnchoredMenu } from "./AnchoredMenu.js";
import { Icon, type IconName } from "./Icon.js";
import { Logo } from "./Logo.js";
import { ProfileMenu } from "./ProfileMenu.js";
import { UpdateBanner } from "./UpdateBanner.js";
import { formatThreadAge, type Project, type Thread } from "../threads.js";
import type { BotWorkflowDefinition, DeyinSettings, ExternalAgentDescriptor, UserProfile } from "@deyin/contract";

interface SidebarProps {
  platform: "desktop" | "web";
  /** Which top-level view is showing, so its nav row reads as selected. */
  activeView?: "workspace" | "settings" | "upgrade" | "automations" | "plugins" | "superagent" | "bot" | "workflows";
  projects: Project[];
  activeProjectId: string | null;
  activeThreadId: string | null;
  renamingThreadId: string | null;
  user: UserProfile | null;
  settings: DeyinSettings;
  busy: boolean;
  connecting: boolean;
  onNewTask: () => void;
  onNewMission?: () => void;
  onNewProject: () => void;
  /** Start a session inside a specific workspace folder. */
  onNewTaskInProject?: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  /** Select target repository specifically for bot delegations in Bot Mode. */
  onSelectTargetRepository?: (projectId: string) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onOpenSearch: () => void;
  onThreadContext: (threadId: string, x: number, y: number) => void;
  onProjectContext: (projectId: string, x: number, y: number) => void;
  onRenameSubmit: (threadId: string, title: string) => void;
  onConnect: () => void;
  onLogout: () => void;
  onChangeSettings: (patch: Partial<DeyinSettings>) => void;
  onOpenUsage: () => void;
  onOpenPlans: () => void;
  onOpenSettings: () => void;
  /** Open the Plugins page (built-in plugins, MCP servers, skills). */
  onOpenPlugins: () => void;
  /** Open the Automations view (scheduled agent runs). */
  onOpenAutomations: () => void;
  /** Open the Superagent view (a proactive agent for one GitHub repository). */
  onOpenSuperagent: () => void;
  /** Open the Bot Workflows / Pipelines editor surface. */
  onOpenWorkflows?: (workflowId?: string | null) => void;
  /** Open the appearance/customisation surface. */
  onOpenCustomize: () => void;
  /** Active chat mode (e.g. 'agent' | 'bot'). */
  currentMode?: import("@deyin/contract").ChatMode;
  /** Switch between Workspace and Bot Mode. */
  onSwitchMode?: (mode: import("@deyin/contract").ChatMode) => void;
  /** Select top-level view between Workspace and Bot Mode. */
  onSelectView?: (view: "workspace" | "bot") => void;
  /**
   * Hosted chat-only web has no local shell or git, so Bot Mode's pipelines and
   * external agent CLIs cannot run there: its switch and mission list are hidden
   * on that build. Absent means available, so the desktop app is unaffected.
   */
  botModeAvailable?: boolean;
  /** Pending approvals / MCP auth / questions per thread (sidebar badge). */
  pendingByThread?: Record<string, number>;
}

/** A pinned thread, carrying the project it belongs to so the flat list can select it. */
interface PinnedEntry {
  projectId: string;
  thread: Thread;
}

/** Ticking clock so the relative age labels keep up without a state change. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Threads shown under their project: pinned ones live in their own section.
 * Newest first, so the preview cap always keeps the most recent chats visible. */
function projectThreads(threads: Thread[]): Thread[] {
  return threads
    .filter((t) => !t.archived && !t.pinned)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** How many chats each project shows before a "Show N more" expander. */
const THREAD_PREVIEW_LIMIT = 5;

const SORT_KEY = "deyin.sidebar.sort";

/** How the workspace folders are ordered in the list. */
type WorkspaceSort = "default" | "recent" | "name";

const SORT_OPTIONS: { id: WorkspaceSort; label: string }[] = [
  { id: "default", label: "Default order" },
  { id: "recent", label: "Recent activity" },
  { id: "name", label: "Name" },
];

function loadSort(): WorkspaceSort {
  const raw = localStorage.getItem(SORT_KEY);
  return SORT_OPTIONS.some((o) => o.id === raw) ? (raw as WorkspaceSort) : "default";
}

function latestActivity(project: Project): number {
  return project.threads.reduce((max, t) => Math.max(max, t.updatedAt), 0);
}

function sortProjects(projects: Project[], sort: WorkspaceSort): Project[] {
  switch (sort) {
    case "default":
      return projects;
    case "recent":
      return [...projects].sort((a, b) => latestActivity(b) - latestActivity(a));
    case "name":
      return [...projects].sort((a, b) => a.name.localeCompare(b.name));
    default: {
      const unreachable: never = sort;
      return unreachable;
    }
  }
}

const COLLAPSED_PROJECTS_KEY = "deyin.sidebar.collapsedProjects";
const EXPANDED_LISTS_KEY = "deyin.sidebar.expandedLists";

function loadCollapsedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_PROJECTS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedProjects(collapsed: Set<string>): void {
  localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsed]));
}

/** Projects whose chat list the user expanded past the preview cap. */
function loadExpandedLists(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_LISTS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function saveExpandedLists(expanded: Set<string>): void {
  localStorage.setItem(EXPANDED_LISTS_KEY, JSON.stringify([...expanded]));
}

export function Sidebar(props: SidebarProps) {
  const t = useT();
  // A chat-only host cannot run bot missions at all, so it reads as the
  // workspace sidebar even if a thread still carries the bot mode.
  const isBotView =
    props.botModeAvailable !== false &&
    (props.activeView === "bot" ||
      props.activeView === "workflows" ||
      (props.activeView !== "workspace" && props.currentMode === "bot"));

  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [sort, setSort] = useState<WorkspaceSort>(loadSort);
  const [collapsedProjects, setCollapsedProjects] = useState(loadCollapsedProjects);
  const [expandedLists, setExpandedLists] = useState(loadExpandedLists);
  const now = useNow(30_000);

  const [agents, setAgents] = useState<ExternalAgentDescriptor[]>([]);
  const [scanningAgents, setScanningAgents] = useState(false);
  const [workflows, setWorkflows] = useState<BotWorkflowDefinition[]>([]);

  const loadAgents = useCallback(async (refresh = false) => {
    if (window.deyin?.externalAgents) {
      setScanningAgents(true);
      try {
        const list = await window.deyin.externalAgents.list(refresh);
        setAgents(list);
      } finally {
        setScanningAgents(false);
      }
    }
  }, []);

  const loadWorkflows = useCallback(async () => {
    if (window.deyin?.botWorkflows) {
      try {
        const list = await window.deyin.botWorkflows.list();
        setWorkflows(list);
      } catch {
        // The workflow list is optional chrome; keep whatever was loaded last.
      }
    }
  }, []);

  useEffect(() => {
    if (isBotView) {
      void loadAgents();
      void loadWorkflows();
    }
  }, [isBotView, loadAgents, loadWorkflows]);

  const botMissions = useMemo(() => {
    return props.projects.flatMap((p) =>
      p.threads
        .filter((t) => t.mode === "bot" && !t.archived)
        .map((t) => ({ projectId: p.id, thread: t }))
    );
  }, [props.projects]);

  const toggleProjectExpanded = (projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      saveCollapsedProjects(next);
      return next;
    });
  };

  const expandProject = (projectId: string) => {
    setCollapsedProjects((prev) => {
      if (!prev.has(projectId)) return prev;
      const next = new Set(prev);
      next.delete(projectId);
      saveCollapsedProjects(next);
      return next;
    });
  };

  const isProjectExpanded = (projectId: string) => {
    if (filter.trim()) return true;
    return !collapsedProjects.has(projectId);
  };

  /** Flip a project between the preview cap and its full chat list. */
  const toggleProjectList = (projectId: string) => {
    setExpandedLists((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      saveExpandedLists(next);
      return next;
    });
  };

  // When the active chat sits below the preview cap, expand its project once so
  // the current conversation stays visible; a manual collapse afterwards sticks.
  const lastAutoExpandedRef = useRef<string | null>(null);
  useEffect(() => {
    const threadId = props.activeThreadId;
    if (!threadId || lastAutoExpandedRef.current === threadId) return;
    lastAutoExpandedRef.current = threadId;
    const project = props.projects.find((p) => p.threads.some((t) => t.id === threadId));
    if (!project) return;
    const threads = projectThreads(project.threads);
    if (threads.findIndex((t) => t.id === threadId) >= THREAD_PREVIEW_LIMIT) {
      setExpandedLists((prev) => {
        if (prev.has(project.id)) return prev;
        const next = new Set(prev);
        next.add(project.id);
        saveExpandedLists(next);
        return next;
      });
    }
  }, [props.activeThreadId, props.projects]);

  // "Search projects…": match project names and thread titles; threads in a
  // matching project are all kept, otherwise only matching threads show.
  const visibleProjects = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const ordered = sortProjects(props.projects, sort);
    if (!q) return ordered;
    return ordered
      .map((project) => {
        if (project.name.toLowerCase().includes(q)) return project;
        const threads = project.threads.filter((t) => t.title.toLowerCase().includes(q));
        return threads.length > 0 ? { ...project, threads } : null;
      })
      .filter((p): p is Project => p !== null);
  }, [props.projects, filter, sort]);

  // Pinned threads float to a section of their own, newest first, across projects.
  const pinned = useMemo<PinnedEntry[]>(() => {
    return props.projects
      .flatMap((project) =>
        project.threads
          .filter((thread) => thread.pinned && !thread.archived)
          .map((thread) => ({ projectId: project.id, thread })),
      )
      .sort((a, b) => b.thread.updatedAt - a.thread.updatedAt);
  }, [props.projects]);

  const renderThread = (projectId: string, thread: Thread) =>
    thread.id === props.renamingThreadId ? (
      <RenameRow key={thread.id} thread={thread} onSubmit={props.onRenameSubmit} />
    ) : (
      <button
        key={thread.id}
        className={["thread-row", thread.id === props.activeThreadId ? "thread-row--active" : ""]
          .filter(Boolean)
          .join(" ")}
        aria-current={thread.id === props.activeThreadId ? "page" : undefined}
        onClick={() => props.onSelectThread(projectId, thread.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onThreadContext(thread.id, e.clientX, e.clientY);
        }}
      >
        <span className="sb-slot">
          {thread.unread && <span className="thread-row__unread" aria-hidden />}
        </span>
        <span className="thread-row__title">{thread.title}</span>
        <ThreadPendingBadge count={props.pendingByThread?.[thread.id] ?? 0} />
        <ThreadMark thread={thread} />
        <ThreadAge updatedAt={thread.updatedAt} now={now} />
      </button>
    );

  return (
    <aside className="sidebar">
      <div className="sidebar__brand-row">
        <button type="button" className="sidebar__brand" title={t("nav.newTask")} onClick={() => props.onNewTask()}>
          <Logo size={22} />
          <span className="sidebar__brand-name">Deyin</span>
        </button>
      </div>

      <nav className="sidebar__panels" aria-label="Navigation">
        <button type="button" className="sb-row sidebar__new-session" onClick={() => props.onNewTask()}>
          <span className="sb-row__glyph"><Icon name="sparkles" size={15} /></span>
          <span className="sidebar__new-label">{isBotView ? "New mission" : "New session"}</span>
          <span className="sidebar__new-kbd">Ctrl+N</span>
        </button>
        <button
          type="button"
          className={`sb-row${props.activeView === "plugins" ? " sb-row--active" : ""}`}
          onClick={props.onOpenPlugins}
        >
          <span className="sb-row__glyph"><Icon name="puzzle" size={16} /></span>
          <span className="sb-row__label">Plugins</span>
        </button>
        {props.platform !== "web" && (
          <button
            type="button"
            className={`sb-row${props.activeView === "automations" ? " sb-row--active" : ""}`}
            onClick={props.onOpenAutomations}
          >
            <span className="sb-row__glyph"><Icon name="clock" size={16} /></span>
            <span className="sb-row__label">Automation tasks</span>
          </button>
        )}
        <AnchoredMenu
          open={moreOpen}
          onToggle={() => setMoreOpen((v) => !v)}
          onClose={() => setMoreOpen(false)}
          triggerClassName="sb-row"
          triggerTitle="More"
          trigger={
            <>
              <span className="sb-row__glyph"><Icon name="grid" size={16} /></span>
              <span className="sb-row__label">More</span>
            </>
          }
          panelClassName="sb-menu"
        >
          <MoreItem icon="search" label={t("nav.search")} hint="Ctrl+K" onClick={() => { setMoreOpen(false); props.onOpenSearch(); }} />
          {props.platform !== "web" && (
            <MoreItem
              icon="rocket"
              label={t("nav.superagent")}
              active={props.activeView === "superagent"}
              onClick={() => { setMoreOpen(false); props.onOpenSuperagent(); }}
            />
          )}
          {isBotView && props.onOpenWorkflows && (
            <MoreItem
              icon="bolt"
              label="Workflows"
              active={props.activeView === "workflows"}
              onClick={() => { setMoreOpen(false); props.onOpenWorkflows?.(null); }}
            />
          )}
          {(props.botModeAvailable !== false && (props.onSelectView || props.onSwitchMode)) && (
            <MoreItem
              icon={isBotView ? "layout" : "bot"}
              label={isBotView ? "Switch to Workspace" : "Switch to Bot mode"}
              onClick={() => {
                setMoreOpen(false);
                const next = isBotView ? "workspace" : "bot";
                props.onSelectView?.(next);
                props.onSwitchMode?.(next === "bot" ? "bot" : "agent");
              }}
            />
          )}
          <MoreItem icon="palette" label={t("nav.customize")} onClick={() => { setMoreOpen(false); props.onOpenCustomize(); }} />
        </AnchoredMenu>
      </nav>

      <div className="sidebar__ws-head">
        <span className="sidebar__ws-title">{isBotView ? "Missions" : "Workspaces"}</span>
        {!isBotView && (
          <div className="sidebar__ws-actions">
            <button
              type="button"
              className={`sb-icon${filterOpen ? " sb-icon--active" : ""}`}
              title="Search workspaces"
              onClick={() => {
                setFilterOpen((v) => !v);
                setFilter("");
              }}
            >
              <Icon name="search" size={15} />
            </button>
            <AnchoredMenu
              open={sortOpen}
              onToggle={() => setSortOpen((v) => !v)}
              onClose={() => setSortOpen(false)}
              triggerClassName={`sb-icon${sort !== "default" ? " sb-icon--active" : ""}`}
              triggerTitle="Organize workspaces"
              trigger={<Icon name="sliders" size={15} />}
              panelClassName="sb-menu"
            >
              <div className="sb-menu__label">Sort workspaces by</div>
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="menu__item"
                  onClick={() => {
                    setSort(option.id);
                    localStorage.setItem(SORT_KEY, option.id);
                    setSortOpen(false);
                  }}
                >
                  <span className="sb-menu__check">{sort === option.id ? <Icon name="check" size={13} /> : null}</span>
                  <span>{option.label}</span>
                </button>
              ))}
            </AnchoredMenu>
            <button
              type="button"
              className="sb-icon"
              title={
                props.platform === "desktop"
                  ? "Add workspace folder"
                  : "Folder workspaces are available in the desktop app"
              }
              disabled={props.platform !== "desktop"}
              onClick={props.onNewProject}
            >
              <Icon name="folderPlus" size={15} />
            </button>
          </div>
        )}
      </div>

      <div className="sidebar__scroll">
        {isBotView ? (
          <>
            {/* Target Repository Pill / Switcher */}
            <div className="sidebar__bot-context">
              <div className="sidebar__section">TARGET REPOSITORY</div>
              <div className="sidebar__target-project">
                <Icon name="folder" size={13} />
                <select
                  className="sidebar__target-select"
                  value={props.activeProjectId ?? ""}
                  onChange={(e) => {
                    (props.onSelectTargetRepository ?? props.onSelectProject)(e.target.value);
                  }}
                  title="Target repository for bot delegations"
                >
                  {props.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  {props.projects.length === 0 && (
                    <option value="">No repository connected</option>
                  )}
                </select>
              </div>
            </div>

            {/* Bot Missions List */}
            <div className="sidebar__section">
              <span>BOT MISSIONS</span>
              {botMissions.length > 0 && <span className="sidebar__section-count">{botMissions.length}</span>}
            </div>

            {botMissions.length > 0 ? (
              <div className="sidebar__bot-missions">
                {botMissions.map(({ projectId, thread }) => renderThread(projectId, thread))}
              </div>
            ) : (
              <div className="sidebar__empty">
                No bot missions yet. Click "New Mission" to start orchestrating.
              </div>
            )}

            {/* Saved Pipelines */}
            <div
              className="sidebar__section"
              style={{
                marginTop: "14px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>SAVED PIPELINES</span>
              {props.onOpenWorkflows && (
                <button
                  type="button"
                  className="icon-btn icon-btn--xs"
                  onClick={() => props.onOpenWorkflows?.(null)}
                  title="Create new workflow"
                >
                  <Icon name="plus" size={12} />
                </button>
              )}
            </div>

            {workflows.length > 0 ? (
              <div className="sidebar__bot-pipelines">
                {workflows.map((wf) => (
                  <button
                    key={wf.id}
                    type="button"
                    className="sidebar__pipeline-item"
                    onClick={() => props.onOpenWorkflows?.(wf.id)}
                    title={`Edit pipeline: ${wf.name}`}
                  >
                    <Icon name="bolt" size={12} />
                    <span className="sidebar__pipeline-name">{wf.name}</span>
                    <span className="sidebar__pipeline-stages">{wf.stages.length}s</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="sidebar__empty">
                No saved pipelines yet.
              </div>
            )}
          </>
        ) : (
          <>
            {pinned.length > 0 && (
              <>
                <div className="sidebar__section">{t("nav.pinned")}</div>
                <div className="sidebar__pinned">
                  {pinned.map((entry) => renderThread(entry.projectId, entry.thread))}
                </div>
              </>
            )}

            {filterOpen && (
              <input
                className="input sidebar__filter"
                placeholder="Search projects…"
                value={filter}
                autoFocus
                onChange={(e) => setFilter(e.target.value)}
              />
            )}

            {visibleProjects.map((project) => {
              const active = project.id === props.activeProjectId;
              const expanded = isProjectExpanded(project.id);
              // Search shows everything; otherwise cap the list with a "Show N more" expander.
              const filtering = filter.trim().length > 0;
              const threads = projectThreads(project.threads);
              const showAll = filtering || expandedLists.has(project.id);
              const visibleThreads = showAll ? threads : threads.slice(0, THREAD_PREVIEW_LIMIT);
              const hiddenCount = threads.length - visibleThreads.length;
              return (
                <div className="project" key={project.id}>
                  <div
                    className={`project__row ${active ? "project__row--active" : ""}`}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      props.onProjectContext(project.id, e.clientX, e.clientY);
                    }}
                  >
                    <button
                      type="button"
                      className="project__select"
                      aria-expanded={expanded}
                      onClick={() => {
                        if (active && expanded && !filtering) {
                          toggleProjectExpanded(project.id);
                          return;
                        }
                        props.onSelectProject(project.id);
                        expandProject(project.id);
                      }}
                      title={project.root ?? project.name}
                    >
                      <span className="sb-slot project__lead">
                        <Icon
                          name={active ? "folderOpen" : "folder"}
                          size={16}
                          className={`project__folder${active ? " project__folder--active" : ""}`}
                        />
                        <Icon
                          name={expanded ? "chevronDown" : "chevronRight"}
                          size={13}
                          className="project__chevron"
                        />
                      </span>
                      <span className="project__name">{project.name}</span>
                    </button>
                    <span className="project__actions">
                      <button
                        type="button"
                        className="sb-icon sb-icon--small"
                        title="Workspace actions"
                        onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          props.onProjectContext(project.id, rect.left, rect.bottom + 4);
                        }}
                      >
                        <Icon name="dots" size={14} />
                      </button>
                      {props.onNewTaskInProject && (
                        <button
                          type="button"
                          className="sb-icon sb-icon--small"
                          title={`New session in ${project.name}`}
                          onClick={() => props.onNewTaskInProject?.(project.id)}
                        >
                          <Icon name="pencil" size={14} />
                        </button>
                      )}
                    </span>
                  </div>
                  {expanded &&
                    visibleThreads.map((thread) => renderThread(project.id, thread))}
                  {expanded && !filtering && threads.length > THREAD_PREVIEW_LIMIT && (
                    <button type="button" className="sidebar__more" onClick={() => toggleProjectList(project.id)}>
                      <span>
                        {showAll
                          ? t("nav.showLessThreads")
                          : t("nav.showMoreThreads").replace("{count}", String(hiddenCount))}
                      </span>
                    </button>
                  )}
                </div>
              );
            })}
            {props.projects.length === 0 &&
              (props.platform === "desktop" ? (
                <button className="sidebar__newproject" onClick={props.onNewProject}>
                  <Icon name="plus" size={13} />
                  <span>{t("nav.newProject")}</span>
                </button>
              ) : (
                <div className="sidebar__empty">No projects yet. Start a new task to create one.</div>
              ))}
            {props.projects.length > 0 && visibleProjects.length === 0 && (
              <div className="sidebar__empty">No matches for “{filter}”.</div>
            )}
          </>
        )}
      </div>

      {/* External Agents Card (Above Profile) */}
      {isBotView && (
        <div className="sidebar__agents-card">
          <div className="sidebar__agents-card-header">
            <div className="sidebar__agents-card-title">
              <Icon name="cpu" size={12} />
              <span>DETECTED AGENTS</span>
            </div>
            <button
              type="button"
              className="icon-btn icon-btn--xs"
              onClick={() => void loadAgents(true)}
              disabled={scanningAgents}
              title="Re-scan installed agents on system"
            >
              <Icon name="refresh" size={11} className={scanningAgents ? "spin" : ""} />
            </button>
          </div>
          <div className="sidebar__agents-list">
            {agents.map((agent) => (
              <div key={agent.id} className="sidebar__agent-row" title={`${agent.name} (${agent.protocol})`}>
                <span
                  className={`sidebar__agent-dot sidebar__agent-dot--${
                    agent.installed
                      ? agent.authStatus === "authenticated" || (agent.authStatus as string) === "ok"
                        ? "ready"
                        : "auth"
                      : "missing"
                  }`}
                />
                <span className="sidebar__agent-name">{agent.name}</span>
                <span className="sidebar__agent-proto">{agent.protocol === "acp" ? "ACP" : "CLI"}</span>
              </div>
            ))}
            {agents.length === 0 && (
              <div className="sidebar__agent-empty">Scanning system tools...</div>
            )}
          </div>
        </div>
      )}

      {props.platform === "desktop" ? (
        <div className="sidebar__update">
          <UpdateBanner variant="sidebar" />
        </div>
      ) : null}

      <div className="sidebar__footer">
        <ProfileMenu
          platform={props.platform}
          user={props.user}
          busy={props.busy}
          connecting={props.connecting}
          settings={props.settings}
          onChangeSettings={props.onChangeSettings}
          onConnect={props.onConnect}
          onLogout={props.onLogout}
          onOpenUsage={props.onOpenUsage}
          onOpenPlans={props.onOpenPlans}
        />
        <button className="icon-btn" title={t("nav.settings")} onClick={props.onOpenSettings}>
          <Icon name="gear" size={15} />
        </button>
      </div>
    </aside>
  );
}

function MoreItem(props: {
  icon: IconName;
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`menu__item${props.active ? " menu__item--active" : ""}`}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size={15} />
      <span>{props.label}</span>
      {props.hint && <span className="menu__item-note">{props.hint}</span>}
    </button>
  );
}

function ThreadPendingBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="thread-row__pending" title={`${count} pending interaction${count === 1 ? "" : "s"}`}>
      {count > 1 ? count : null}
    </span>
  );
}

/** Small state glyph in the row's trailing slot: goal, plan, mode or open todos. */
function ThreadMark({ thread }: { thread: Thread }) {
  const mark: { icon: IconName; title: string } | null = thread.goal
    ? { icon: "flag", title: `Goal: ${thread.goal.text}` }
    : thread.planMarkdown
      ? { icon: "book", title: "Has a plan" }
      : thread.mode === "ask"
        ? { icon: "message", title: "Ask mode" }
        : thread.todos?.some((todo) => todo.status !== "completed" && todo.status !== "cancelled")
          ? { icon: "list", title: "Open todos" }
          : null;

  if (!mark) return null;
  return (
    <span className="thread-row__mark" title={mark.title}>
      <Icon name={mark.icon} size={11} />
    </span>
  );
}

function ThreadAge({ updatedAt, now }: { updatedAt: number; now: number }) {
  const label = formatThreadAge(updatedAt, now);
  return (
    <span
      className={`thread-row__age ${label === "now" ? "thread-row__age--now" : ""}`}
      title={new Date(updatedAt).toLocaleString()}
    >
      {label}
    </span>
  );
}

function RenameRow({
  thread,
  onSubmit,
}: {
  thread: Thread;
  onSubmit: (threadId: string, title: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const value = inputRef.current?.value.trim();
    onSubmit(thread.id, value && value.length > 0 ? value : thread.title);
  };

  return (
    <div className="thread-row thread-row--rename">
      <input
        ref={inputRef}
        className="input input--inline"
        defaultValue={thread.title}
        onBlur={submit}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onSubmit(thread.id, thread.title);
        }}
      />
    </div>
  );
}
