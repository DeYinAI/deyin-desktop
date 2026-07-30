import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";
import { ProfileMenu } from "./ProfileMenu.js";
import type { Project, Thread } from "../threads.js";
import type { DeyinSettings, UserProfile } from "../../shared/types.js";

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
  onOpenAutomations?: () => void;
}

function orderThreads(threads: Thread[]): Thread[] {
  return threads
    .filter((t) => !t.archived)
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
}

export function Sidebar(props: SidebarProps) {
  const t = useT();
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");

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

  return (
    <aside className="sidebar">
      <div className="sidebar__scroll">
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
              <Icon name="search" size={12} />
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
              <Icon name="plus" size={13} />
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

        {visibleProjects.map((project) => (
          <div className="project" key={project.id}>
            <button
              className={`project__row ${project.id === props.activeProjectId ? "project__row--active" : ""}`}
              onClick={() => props.onSelectProject(project.id)}
              title={project.root ?? project.name}
            >
              <Icon name="folder" size={13} />
              <span className="project__name">{project.name}</span>
            </button>
            {orderThreads(project.threads).map((thread) =>
              thread.id === props.renamingThreadId ? (
                <RenameRow key={thread.id} thread={thread} onSubmit={props.onRenameSubmit} />
              ) : (
                <button
                  key={thread.id}
                  className={`thread-row ${thread.id === props.activeThreadId ? "thread-row--active" : ""}`}
                  aria-current={thread.id === props.activeThreadId ? "page" : undefined}
                  onClick={() => props.onSelectThread(project.id, thread.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    props.onThreadContext(thread.id, e.clientX, e.clientY);
                  }}
                >
                  {thread.pinned && <Icon name="pin" size={11} />}
                  {thread.unread && <span className="thread-row__unread" />}
                  <span className="thread-row__title">{thread.title}</span>
                  <span className={`thread-row__age ${thread.age === "now" ? "thread-row__age--now" : ""}`}>
                    {thread.age}
                  </span>
                </button>
              ),
            )}
          </div>
        ))}
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

        <div className="sidebar__section">{t("nav.tasks")}</div>
        <div className="sidebar__empty">{t("nav.noTasks")}</div>
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
        <div className="sidebar__footer-spacer" />
        <button className="icon-btn" title={`${t("nav.newTask")} (Ctrl+N)`} onClick={props.onNewTask}>
          <Icon name="plus" size={15} />
        </button>
        <button className="icon-btn" title={`${t("nav.search")} (Ctrl+K)`} onClick={props.onOpenSearch}>
          <Icon name="search" size={14} />
        </button>
        {props.platform === "desktop" && props.onOpenAutomations && (
          <button className="icon-btn" title={t("nav.automations")} onClick={props.onOpenAutomations}>
            <Icon name="sparkles" size={14} />
          </button>
        )}
        <button className="icon-btn" title={t("nav.settings")} onClick={props.onOpenSettings}>
          <Icon name="gear" size={15} />
        </button>
      </div>
    </aside>
  );
}

function RenameRow({ thread, onSubmit }: { thread: Thread; onSubmit: (threadId: string, title: string) => void }) {
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
