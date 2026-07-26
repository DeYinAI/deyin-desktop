import { useEffect, useRef } from "react";
import { Icon } from "./Icon.js";
import { ProfileMenu } from "./ProfileMenu.js";
import type { Project, Thread } from "../threads.js";
import type { UserProfile } from "../../shared/types.js";

interface SidebarProps {
  projects: Project[];
  activeThreadId: string | null;
  renamingThreadId: string | null;
  user: UserProfile | null;
  busy: boolean;
  onNewTask: () => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onOpenSearch: () => void;
  onThreadContext: (threadId: string, x: number, y: number) => void;
  onRenameSubmit: (threadId: string, title: string) => void;
  onConnect: () => void;
  onLogout: () => void;
  onOpenSettings: () => void;
}

function orderThreads(threads: Thread[]): Thread[] {
  return threads
    .filter((t) => !t.archived)
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
}

export function Sidebar(props: SidebarProps) {
  return (
    <aside className="sidebar">
      <nav className="sidebar__nav">
        <button className="nav-item" onClick={props.onNewTask}>
          <Icon name="plus" size={15} />
          <span>New task</span>
          <span className="kbd">Ctrl+N</span>
        </button>
        <button className="nav-item" onClick={props.onOpenSearch}>
          <Icon name="search" size={15} />
          <span>Search</span>
          <span className="kbd">Ctrl+K</span>
        </button>
        <button className="nav-item">
          <Icon name="bolt" size={15} />
          <span>Automations</span>
        </button>
        <button className="nav-item">
          <Icon name="sparkles" size={15} />
          <span>Skills</span>
        </button>
      </nav>

      <div className="sidebar__filters">
        <button className="chip chip--small">
          <Icon name="plus" size={12} />
          <span>Group</span>
        </button>
        <button className="chip chip--small chip--active">
          <span>Project</span>
        </button>
        <div className="sidebar__filters-spacer" />
        <button className="icon-btn icon-btn--small" title="Sort">
          <Icon name="chevronDown" size={13} />
        </button>
        <button className="icon-btn icon-btn--small" title="Collapse all">
          <Icon name="grid" size={13} />
        </button>
      </div>

      <div className="sidebar__scroll">
        <div className="sidebar__section">Projects</div>
        {props.projects.map((project) => (
          <div className="project" key={project.id}>
            <div className="project__row">
              <Icon name="folder" size={13} />
              <span className="project__name">{project.name}</span>
              <button className="icon-btn icon-btn--small project__refresh" title="Refresh">
                <Icon name="refresh" size={12} />
              </button>
            </div>
            {orderThreads(project.threads).map((thread) =>
              thread.id === props.renamingThreadId ? (
                <RenameRow key={thread.id} thread={thread} onSubmit={props.onRenameSubmit} />
              ) : (
                <button
                  key={thread.id}
                  className={`thread-row ${thread.id === props.activeThreadId ? "thread-row--active" : ""}`}
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
            {orderThreads(project.threads).length > 4 && (
              <button className="thread-row thread-row--more">Show more</button>
            )}
          </div>
        ))}

        <div className="sidebar__section">Tasks</div>
        <div className="sidebar__empty">No tasks yet</div>
      </div>

      <div className="sidebar__footer">
        <ProfileMenu user={props.user} busy={props.busy} onConnect={props.onConnect} onLogout={props.onLogout} />
        <div className="sidebar__footer-spacer" />
        <button className="icon-btn" title="Layout" onClick={props.onOpenSettings}>
          <Icon name="panel" size={15} />
        </button>
        <button className="icon-btn" title="Settings" onClick={props.onOpenSettings}>
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
