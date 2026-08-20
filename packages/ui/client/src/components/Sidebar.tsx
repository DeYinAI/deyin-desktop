import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";
import { ProfileMenu } from "./ProfileMenu.js";
import { formatThreadAge, type Project, type Thread } from "../threads.js";
import type { DeyinSettings, UserProfile } from "@deyin/contract";

interface SidebarProps {
  platform: "desktop" | "web";
  projects: Project[];
  activeProjectId: string | null;
  activeThreadId: string | null;
  renamingThreadId: string | null;
  user: UserProfile | null;
  settings: DeyinSettings;
  busy: boolean;
  connecting: boolean;
  /** Thread history arrows, mirroring the browser-style back/forward pair. */
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onCollapse: () => void;
  onNewTask: () => void;
  onNewProject: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onOpenSearch: () => void;
  onThreadContext: (threadId: string, x: number, y: number) => void;
  onRenameSubmit: (threadId: string, title: string) => void;
  onConnect: () => void;
  onLogout: () => void;
  onChangeSettings: (patch: Partial<DeyinSettings>) => void;
  onOpenUsage: () => void;
  onOpenPlans: () => void;
  onOpenSettings: () => void;
  /** Open the Automations view (scheduled agent runs). */
  onOpenAutomations: () => void;
  /** Open the appearance/customisation surface. */
  onOpenCustomize: () => void;
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

/** Threads shown under their project: pinned ones live in their own section. */
function projectThreads(threads: Thread[]): Thread[] {
  return threads.filter((t) => !t.archived && !t.pinned);
}

export function Sidebar(props: SidebarProps) {
  const t = useT();
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const now = useNow(30_000);

  // "Search projects…": match project names and thread titles; threads in a
  // matching project are all kept, otherwise only matching threads show.
  const visibleProjects = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return props.projects;
    return props.projects
      .map((project) => {
        if (project.name.toLowerCase().includes(q)) return project;
        const threads = project.threads.filter((t) => t.title.toLowerCase().includes(q));
        return threads.length > 0 ? { ...project, threads } : null;
      })
      .filter((p): p is Project => p !== null);
  }, [props.projects, filter]);

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

  const renderThread = (projectId: string, thread: Thread, indented: boolean) =>
    thread.id === props.renamingThreadId ? (
      <RenameRow key={thread.id} thread={thread} indented={indented} onSubmit={props.onRenameSubmit} />
    ) : (
      <button
        key={thread.id}
        className={[
          "thread-row",
          indented ? "" : "thread-row--flush",
          thread.id === props.activeThreadId ? "thread-row--active" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-current={thread.id === props.activeThreadId ? "page" : undefined}
        onClick={() => props.onSelectThread(projectId, thread.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onThreadContext(thread.id, e.clientX, e.clientY);
        }}
      >
        {thread.unread && <span className="thread-row__unread" />}
        <span className="thread-row__title">{thread.title}</span>
        <ThreadAge updatedAt={thread.updatedAt} now={now} />
      </button>
    );

  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <button className="icon-btn" title={t("nav.collapseSidebar")} onClick={props.onCollapse}>
          <Icon name="panelLeft" size={15} />
        </button>
        <div className="sidebar__head-spacer" />
        <button className="icon-btn" title={t("nav.back")} disabled={!props.canBack} onClick={props.onBack}>
          <Icon name="arrowLeft" size={14} />
        </button>
        <button className="icon-btn" title={t("nav.forward")} disabled={!props.canForward} onClick={props.onForward}>
          <Icon name="arrowRight" size={14} />
        </button>
      </div>

      <nav className="sidebar__nav">
        <button className="nav-item nav-item--warm" onClick={props.onNewTask}>
          <Icon name="sparkles" size={14} />
          <span>{t("nav.newTask")}</span>
          <span className="kbd">Ctrl+N</span>
        </button>
        <button className="nav-item" onClick={props.onOpenSearch}>
          <Icon name="search" size={14} />
          <span>{t("nav.search")}</span>
          <span className="kbd">Ctrl+K</span>
        </button>
        <button className="nav-item nav-item--accent" onClick={props.onOpenAutomations}>
          <Icon name="automation" size={14} />
          <span>{t("nav.automations")}</span>
        </button>
        <button className="nav-item nav-item--accent" onClick={props.onOpenCustomize}>
          <Icon name="customize" size={14} />
          <span>{t("nav.customize")}</span>
        </button>
      </nav>

      <div className="sidebar__scroll">
        {pinned.length > 0 && (
          <>
            <div className="sidebar__section">{t("nav.pinned")}</div>
            <div className="sidebar__pinned">
              {pinned.map((entry) => renderThread(entry.projectId, entry.thread, false))}
            </div>
          </>
        )}

        <div className="sidebar__section-row">
          <div className="sidebar__section">{t("nav.projects")}</div>
          <div className="sidebar__section-actions">
            <button
              className={`icon-btn icon-btn--small ${filterOpen ? "icon-btn--active" : ""}`}
              title="Search projects"
              onClick={() => {
                setFilterOpen((v) => !v);
                setFilter("");
              }}
            >
              <Icon name="filter" size={13} />
            </button>
            <button
              className="icon-btn icon-btn--small"
              title={
                props.platform === "desktop"
                  ? "New project — pick a folder as your workspace"
                  : "Folder workspaces are available in the desktop app"
              }
              disabled={props.platform !== "desktop"}
              onClick={props.onNewProject}
            >
              <Icon name="folderPlus" size={14} />
            </button>
          </div>
        </div>

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
          return (
            <div className="project" key={project.id}>
              <button
                className={`project__row ${active ? "project__row--active" : ""}`}
                onClick={() => props.onSelectProject(project.id)}
                title={project.root ?? project.name}
              >
                <Icon name={active ? "folderOpen" : "folder"} size={14} />
                <span className="project__name">{project.name}</span>
              </button>
              {projectThreads(project.threads).map((thread) => renderThread(project.id, thread, true))}
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
      </div>

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
  indented,
  onSubmit,
}: {
  thread: Thread;
  indented: boolean;
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
    <div className={`thread-row thread-row--rename ${indented ? "" : "thread-row--flush"}`}>
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
