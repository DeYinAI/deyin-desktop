import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitHubRepoEntry, Project, SshHostInfo } from "@deyin/contract";
import {
  displayLocationPath,
  filterRecentProjects,
  projectLocation,
  type WorkspaceLocation,
} from "@deyin/host-core/shared";
import { Icon } from "../Icon.js";
import { CloneRepoDialog } from "./CloneRepoDialog.js";
import { FolderBrowserDialog } from "./FolderBrowserDialog.js";
import { GitHubRepoBrowser } from "./GitHubRepoBrowser.js";
import { SshConnectDialog } from "./SshConnectDialog.js";
import { wslBrowseRoot, wslEnvLabel } from "./folder-browser-utils.js";

export type ProjectPickerAction =
  | { type: "open-local"; path: string }
  | { type: "connect-remote"; hostId: string; remotePath: string }
  | { type: "clone-url"; url: string; token?: string; branch?: string }
  | { type: "clone-github"; repo: GitHubRepoEntry }
  | { type: "select-recent"; projectId: string };

export interface ProjectPickerProps {
  open: boolean;
  platform: "desktop" | "web";
  projects: Project[];
  activeProjectId: string | null;
  homeDir?: string | null;
  wslDistros?: string[];
  sshHosts?: SshHostInfo[];
  githubConnected?: boolean;
  githubLogin?: string | null;
  cloneBusy?: boolean;
  cloneProgress?: string | null;
  onClose: () => void;
  onAction: (action: ProjectPickerAction) => void | Promise<void>;
  listDirectory: (path: string) => Promise<import("@deyin/contract").DirectoryEntry[]>;
  sshBrowse: (hostId: string, path: string) => Promise<import("@deyin/contract").DirectoryEntry[]>;
  githubConnect?: () => Promise<void>;
  githubListRepos?: (query?: string) => Promise<GitHubRepoEntry[]>;
}

export function ProjectPicker(props: ProjectPickerProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [useExistingOpen, setUseExistingOpen] = useState(false);
  const [folderBrowser, setFolderBrowser] = useState<{ path: string; env?: string } | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const githubAvailable = Boolean(props.githubListRepos && props.githubConnect);
  const hasSubDialog = folderBrowser !== null || cloneOpen || sshOpen || (githubOpen && githubAvailable);

  useEffect(() => {
    if (props.open && !hasSubDialog) {
      setQuery("");
      setSelectedIndex(null);
      inputRef.current?.focus();
    }
  }, [props.open, hasSubDialog]);

  useEffect(() => {
    if (!props.open || hasSubDialog) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [props.open, props.onClose, hasSubDialog]);

  const recents = useMemo(
    () => filterRecentProjects(props.projects, query, props.homeDir),
    [props.projects, query, props.homeDir],
  );

  const home = props.homeDir ?? "/";
  const openLocalBrowser = useCallback(
    (startPath?: string, env?: string) => {
      setFolderBrowser({ path: startPath ?? home, env });
    },
    [home],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (recents.length === 0) return;
      setSelectedIndex((prev) => (prev === null ? 0 : Math.min(prev + 1, recents.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev === null || prev <= 0 ? null : prev - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedIndex !== null && recents[selectedIndex]) {
        void props.onAction({ type: "select-recent", projectId: recents[selectedIndex]!.id });
      } else if (recents.length > 0 && recents[0]) {
        void props.onAction({ type: "select-recent", projectId: recents[0]!.id });
      } else if (props.platform === "desktop") {
        openLocalBrowser();
      }
    }
  };

  if (!props.open) return null;

  return (
    <>
      {!hasSubDialog && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
          <div className="searchbox project-picker">
            <div className="searchbox__bar">
              <Icon name="search" size={15} />
              <input
                ref={inputRef}
                className="searchbox__input"
                placeholder="Search folders, repos…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelectedIndex(null);
                }}
                onKeyDown={handleKeyDown}
              />
              <span className="kbd">Esc</span>
            </div>
            <div className="searchbox__body">
              {recents.length > 0 && (
                <>
                  <div className="searchbox__section">Recents</div>
                  {recents.map((p, idx) => {
                    const loc = projectLocation(p);
                    const label = loc ? displayLocationPath(loc, props.homeDir) : p.name;
                    const isSelected = selectedIndex === idx;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className={`searchbox__row${isSelected || (selectedIndex === null && p.id === props.activeProjectId) ? " searchbox__row--active" : ""}`}
                        onMouseEnter={() => setSelectedIndex(idx)}
                        onClick={() => void props.onAction({ type: "select-recent", projectId: p.id })}
                      >
                        <Icon name="folder" size={13} />
                        <span className="searchbox__title">{label}</span>
                        <span className="hint">{envLabel(loc)}</span>
                        {p.id === props.activeProjectId && <Icon name="check" size={13} />}
                      </button>
                    );
                  })}
                </>
              )}
              {props.platform === "desktop" && (
                <>
                  <div className="searchbox__section">Repos</div>
                  <button type="button" className="searchbox__row" onClick={() => openLocalBrowser()}>
                    <Icon name="layout" size={13} />
                    <span className="searchbox__title">On This PC</span>
                    <Icon name="chevronRight" size={11} />
                  </button>
                  {githubAvailable && (
                    <button type="button" className="searchbox__row" onClick={() => setGithubOpen(true)}>
                      <Icon name="globe" size={13} />
                      <span className="searchbox__title">Cloud</span>
                      <Icon name="chevronRight" size={11} />
                    </button>
                  )}
                  {(props.wslDistros ?? []).map((distro) => (
                    <button
                      key={distro}
                      type="button"
                      className="searchbox__row"
                      onClick={() => openLocalBrowser(wslBrowseRoot(distro), wslEnvLabel(distro))}
                    >
                      <Icon name="terminal" size={13} />
                      <span className="searchbox__title">{distro}</span>
                      <Icon name="chevronRight" size={11} />
                    </button>
                  ))}
                  <button type="button" className="searchbox__row" onClick={() => setCloneOpen(true)}>
                    <Icon name="gitBranch" size={13} />
                    <span className="searchbox__title">Clone repository…</span>
                  </button>
                </>
              )}
              {props.platform === "desktop" && (
                <div className="project-picker__footer">
                  <div
                    className="menu"
                    onMouseEnter={() => setUseExistingOpen(true)}
                    onMouseLeave={() => setUseExistingOpen(false)}
                  >
                    <button type="button" className="searchbox__row">
                      <Icon name="folder" size={13} />
                      <span className="searchbox__title">Use Existing…</span>
                      <Icon name="chevronRight" size={11} />
                    </button>
                    {useExistingOpen && (
                      <div className="menu__panel menu__panel--anchored project-picker__flyout">
                        <button type="button" className="menu__item" onClick={() => openLocalBrowser()}>
                          Open Folder
                        </button>
                        <button type="button" className="menu__item" onClick={() => setCloneOpen(true)}>
                          Clone Repository
                        </button>
                        <button type="button" className="menu__item" onClick={() => setSshOpen(true)}>
                          Connect via SSH
                        </button>
                        {(props.wslDistros ?? []).map((distro) => (
                          <button
                            key={distro}
                            type="button"
                            className="menu__item"
                            onClick={() => openLocalBrowser(wslBrowseRoot(distro), distro)}
                          >
                            WSL · {distro}
                          </button>
                        ))}
                        {githubAvailable && (
                          <>
                            <div className="menu__sep" />
                            <button type="button" className="menu__item" onClick={() => setGithubOpen(true)}>
                              GitHub
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <FolderBrowserDialog
        open={folderBrowser !== null}
        title="Select Folder"
        initialPath={folderBrowser?.path ?? home}
        envLabel={folderBrowser?.env}
        listDirectory={props.listDirectory}
        onClose={() => setFolderBrowser(null)}
        onOpen={(path) => {
          setFolderBrowser(null);
          void props.onAction({ type: "open-local", path });
          props.onClose();
        }}
      />

      <CloneRepoDialog
        open={cloneOpen}
        busy={props.cloneBusy}
        progressLine={props.cloneProgress}
        onClose={() => setCloneOpen(false)}
        onSubmit={async (opts) => {
          await props.onAction({ type: "clone-url", ...opts });
          setCloneOpen(false);
          props.onClose();
        }}
      />

      <SshConnectDialog
        open={sshOpen}
        hosts={props.sshHosts ?? []}
        browse={props.sshBrowse}
        onClose={() => setSshOpen(false)}
        onConnect={async (hostId, remotePath) => {
          await props.onAction({ type: "connect-remote", hostId, remotePath });
          setSshOpen(false);
          props.onClose();
        }}
      />

      {githubAvailable && (
        <GitHubRepoBrowser
          open={githubOpen}
          connected={props.githubConnected ?? false}
          login={props.githubLogin ?? null}
          onClose={() => setGithubOpen(false)}
          onConnectGitHub={props.githubConnect!}
          listRepos={props.githubListRepos!}
          onClone={async (repo) => {
            await props.onAction({ type: "clone-github", repo });
            setGithubOpen(false);
            props.onClose();
          }}
        />
      )}
    </>
  );
}

function envLabel(loc: WorkspaceLocation | null): string {
  if (!loc) return "";
  if (loc.kind === "remote") return "SSH";
  const wslMatch = /^(?:\\\\|\/\/)wsl(?:\$|\.localhost)[\\/]([^\\/]+)/i.exec(loc.root);
  if (wslMatch) {
    return `WSL · ${wslMatch[1]}`;
  }
  return "Local";
}
