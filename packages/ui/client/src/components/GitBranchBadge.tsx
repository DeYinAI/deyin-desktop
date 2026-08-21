import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import type { GitBranch, GitRepoInfo, GitStatus } from "@deyin/contract";

export interface GitState {
  info: GitRepoInfo | null;
  status: GitStatus | null;
  branches: GitBranch[];
}

/** Live git snapshot for the workspace: refetches on root change and on host `gitChanged`. */
export function useGitStatus(workspaceRoot: string | null): GitState & { refresh: () => void } {
  const [state, setState] = useState<GitState>({ info: null, status: null, branches: [] });

  const refresh = useCallback(() => {
    if (!window.deyin.git) return;
    void Promise.all([window.deyin.git.info(), window.deyin.git.status(), window.deyin.git.branches()])
      .then(([info, status, branches]) => setState({ info, status, branches }))
      .catch(() => setState({ info: null, status: null, branches: [] }));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, workspaceRoot]);

  useEffect(() => {
    if (!window.deyin.git) return;
    return window.deyin.git.onChanged(refresh);
  }, [refresh]);

  return { ...state, refresh };
}

/** Count of distinct changed paths (a file staged AND unstaged counts once). */
function dirtyCount(status: GitStatus | null): number {
  if (!status) return 0;
  const paths = new Set<string>();
  for (const e of [...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicts]) paths.add(e.path);
  return paths.size;
}

/** Spells the badge's counts out, since the pills themselves stay terse. */
function branchTitle(branch: string, dirty: number, ahead: number, behind: number): string {
  const parts = [`Branch: ${branch}`];
  if (dirty > 0) parts.push(`${dirty} uncommitted ${dirty === 1 ? "change" : "changes"}`);
  if (ahead > 0) parts.push(`${ahead} ${ahead === 1 ? "commit" : "commits"} ahead of upstream`);
  if (behind > 0) parts.push(`${behind} ${behind === 1 ? "commit" : "commits"} behind upstream`);
  return parts.join(" · ");
}

interface GitBranchBadgeProps {
  workspaceRoot: string | null;
  /** Open the Source Control panel (wired in Phase 2). */
  onOpenSourceControl?: () => void;
  /** Trigger styling; the composer's workspace bar uses its own chip class. */
  className?: string;
  /** Open the branch list upwards (for triggers near the bottom of the window). */
  menuUp?: boolean;
}

/** Branch indicator: current branch, dirty count, ahead/behind, branch switcher. */
export function GitBranchBadge({
  workspaceRoot,
  onOpenSourceControl,
  className = "env-badge",
  menuUp = false,
}: GitBranchBadgeProps) {
  const { info, status, branches, refresh } = useGitStatus(workspaceRoot);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  // Not a git repo (or not detected yet): show nothing, like an IDE status bar.
  if (!info?.isRepo) return null;

  const dirty = dirtyCount(status);
  const branchLabel = info.detached ? "detached" : (info.branch ?? "—");
  const locals = branches.filter((b) => !b.remote);

  const switchTo = (name: string): void => {
    setError(null);
    void window.deyin.git.checkout(name).then((r) => {
      if (r.ok) {
        setOpen(false);
        refresh();
      } else {
        setError(r.message);
      }
    });
  };

  const deleteBranch = (name: string): void => {
    if (!window.confirm(`Delete branch ${name}?`)) return;
    setError(null);
    void window.deyin.git.deleteBranch(name).then((r) => {
      if (r.ok) refresh();
      else setError(r.message);
    });
  };

  return (
    <div className="menu" ref={rootRef}>
      <button
        className={className}
        title={branchTitle(branchLabel, dirty, info.ahead, info.behind)}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="gitBranch" size={12} />
        <span className="git-badge__branch">{branchLabel}</span>
        {dirty > 0 && (
          <span className="git-badge__dirty">
            {dirty} {dirty === 1 ? "change" : "changes"}
          </span>
        )}
        {info.ahead > 0 && (
          <span className="git-badge__track">
            <Icon name="arrowUp" size={9} />
            {info.ahead}
          </span>
        )}
        {info.behind > 0 && (
          <span className="git-badge__track">
            <Icon name="arrowDown" size={9} />
            {info.behind}
          </span>
        )}
        <Icon name="chevronDown" size={10} className="git-badge__caret" />
      </button>
      {open && (
        <div className={`menu__panel${menuUp ? " menu__panel--up" : ""}`}>
          <div className="menu__header">Branches</div>
          {locals.length === 0 && <div className="menu__info">No local branches.</div>}
          {locals.map((b) => (
            <div key={b.name} className="git-branch-row">
              <button className="menu__item git-branch-row__pick" onClick={() => switchTo(b.name)}>
                <Icon name={b.current ? "check" : "gitBranch"} size={13} />
                {b.name}
                {b.upstream && <span className="badge badge--muted">{b.upstream}</span>}
              </button>
              {!b.current && (
                <button className="icon-btn icon-btn--small" title={`Delete ${b.name}`} onClick={() => deleteBranch(b.name)}>
                  <Icon name="trash" size={12} />
                </button>
              )}
            </div>
          ))}
          {error && <div className="menu__info menu__info--error">{error}</div>}
          {onOpenSourceControl && (
            <>
              <div className="menu__sep" />
              <button
                className="menu__item"
                onClick={() => {
                  onOpenSourceControl();
                  setOpen(false);
                }}
              >
                <Icon name="diff" size={13} />
                Open Source Control
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
