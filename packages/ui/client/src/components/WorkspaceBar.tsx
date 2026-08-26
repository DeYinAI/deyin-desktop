import { useState } from "react";
import { useT } from "../i18n.js";
import { AnchoredMenu } from "./AnchoredMenu.js";
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
  /** `startIn` seeds the native picker's starting directory (used for WSL roots). */
  onPickFolder: (startIn?: string) => void;
  onOpenSourceControl: () => void;
  /** WSL distros detected on this machine; each becomes an "open in WSL" entry. */
  wslDistros?: string[];
  /** Opens Settings › SSH hosts — SSH is where remote *automation* targets live. */
  onOpenSshHosts?: () => void;
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
  wslDistros = [],
  onOpenSshHosts,
}: WorkspaceBarProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const folders = projects.filter((p) => p.root);

  return (
    <div className="workspace-bar">
      {platform === "desktop" ? (
        <AnchoredMenu
          open={open}
          onToggle={() => setOpen((v) => !v)}
          onClose={() => setOpen(false)}
          triggerClassName="workspace-bar__chip"
          triggerTitle={workspaceRoot ? displayPath(workspaceRoot, homeDir) : "Choose a folder as your workspace"}
          trigger={
            <>
              <Icon name="folder" size={13} />
              <span className="workspace-bar__name">{folderName(workspaceRoot) || projectName}</span>
              <Icon name="chevronDown" size={11} className="workspace-bar__caret" />
            </>
          }
        >
          <div className="menu__header">Workspace</div>
          {folders.length === 0 && <div className="menu__info">No folders opened yet.</div>}
          {folders.map((p) => (
            <button
              key={p.id}
              type="button"
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
            type="button"
            className="menu__item"
            onClick={() => {
              onPickFolder();
              setOpen(false);
            }}
          >
            <Icon name="folderPlus" size={13} />
            {wslDistros.length > 0 ? t("workspace.openLocal") : t("workspace.openFolder")}
          </button>
          {wslDistros.map((distro) => (
            <button
              key={distro}
              type="button"
              className="menu__item"
              title={wslRoot(distro)}
              onClick={() => {
                onPickFolder(wslRoot(distro));
                setOpen(false);
              }}
            >
              <Icon name="terminal" size={13} />
              {t("workspace.openWsl")} · {distro}
            </button>
          ))}
          {onOpenSshHosts && (
            <>
              <div className="menu__sep" />
              <div className="menu__info">{t("workspace.remoteNote")}</div>
              <button
                type="button"
                className="menu__item"
                onClick={() => {
                  onOpenSshHosts();
                  setOpen(false);
                }}
              >
                <Icon name="server" size={13} />
                {t("workspace.manageSsh")}
              </button>
            </>
          )}
        </AnchoredMenu>
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

/** UNC root of a WSL distro's filesystem, as Explorer and Node both see it. */
function wslRoot(distro: string): string {
  return `\\\\wsl.localhost\\${distro}\\home`;
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
