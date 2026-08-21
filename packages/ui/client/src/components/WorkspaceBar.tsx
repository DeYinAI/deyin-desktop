import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import { GitBranchBadge } from "./GitBranchBadge.js";
import type { Project } from "../threads.js";

interface WorkspaceBarProps {
  platform: "desktop" | "web";
  /** Known projects; folder-backed ones are offered as workspace choices. */
  projects: Project[];
  activeProjectId: string | null;
  projectName: string;
  workspaceRoot: string | null;
  /** User home dir (Bootstrap.homeDir) for `~`-shortening absolute paths. */
  homeDir?: string | null;
  onSelectProject: (projectId: string) => void;
  onPickFolder: () => void;
  onOpenSourceControl: () => void;
  /** Web: open the "Connect repository" dialog (clone into the session sandbox). */
  onConnectRepo?: () => void;
}

/** Workspace slab tucked above the composer: folder picker on the left,
 *  branch picker next to it. Folder workspaces are desktop-only. */
export function WorkspaceBar({
  platform,
  projects,
  activeProjectId,
  projectName,
  workspaceRoot,
  homeDir,
  onSelectProject,
  onPickFolder,
  onOpenSourceControl,
  onConnectRepo,
}: WorkspaceBarProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const folders = projects.filter((p) => p.root);

  return (
    <div className="workspace-bar">
      {platform === "desktop" ? (
        <div className="menu" ref={rootRef}>
          <button
            type="button"
            className="workspace-bar__chip"
            onClick={() => setOpen((v) => !v)}
            title={workspaceRoot ? displayPath(workspaceRoot, homeDir) : "Choose a folder as your workspace"}
          >
            <Icon name="folder" size={13} />
            <span className="workspace-bar__name">{folderName(workspaceRoot) || projectName}</span>
            <Icon name="chevronDown" size={11} className="workspace-bar__caret" />
          </button>
          {open && (
            <div className="menu__panel menu__panel--up">
              <div className="menu__header">Workspace</div>
              {folders.length === 0 && <div className="menu__info">No folders opened yet.</div>}
              {folders.map((p) => (
                <button
                  key={p.id}
                  className={`menu__item${p.id === activeProjectId ? " menu__item--active" : ""}`}
                  title={p.root ?? undefined}
                  onClick={() => {
                    onSelectProject(p.id);
                    setOpen(false);
                  }}
                >
                  <Icon name={p.id === activeProjectId ? "check" : "folder"} size={13} />
                  <span className="workspace-bar__name">{p.name}</span>
                </button>
              ))}
              <div className="menu__sep" />
              <button
                className="menu__item"
                onClick={() => {
                  onPickFolder();
                  setOpen(false);
                }}
              >
                <Icon name="folderPlus" size={13} />
                Open folder…
              </button>
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="workspace-bar__chip"
          onClick={onConnectRepo}
          disabled={!onConnectRepo}
          title={workspaceRoot ? displayPath(workspaceRoot, homeDir) : undefined}
        >
          <Icon name="gitBranch" size={13} />
          <span className="workspace-bar__name">{folderName(workspaceRoot) || "Connect a repository"}</span>
        </button>
      )}
      <GitBranchBadge
        workspaceRoot={workspaceRoot}
        className="workspace-bar__chip"
        menuUp
        onOpenSourceControl={onOpenSourceControl}
      />
    </div>
  );
}

/** Just the workspace folder itself — the full path lives in the tooltip. */
function folderName(root: string | null): string {
  if (!root) return "";
  const segments = root.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? root;
}

/** Full path for tooltips, `~`-shortened when under the user's home dir. */
function displayPath(root: string | null, homeDir?: string | null): string {
  if (!root) return "";
  const normalized = root.replace(/\\/g, "/");
  const home = homeDir?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (home && (normalized === home || normalized.startsWith(`${home}/`))) {
    return `~${normalized.slice(home.length)}`;
  }
  return normalized;
}
