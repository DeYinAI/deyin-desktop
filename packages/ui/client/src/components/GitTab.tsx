import { useCallback, useEffect, useState } from "react";
import { Icon } from "./Icon.js";
import { useConfirm } from "./ConfirmDialog.js";
import { useGitStatus } from "./GitBranchBadge.js";
import type { FileDiff } from "../diff.js";
import type { GitBlameLine, GitCommit, GitCommitDetail, GitFileEntry, GitResultLite, GitStash } from "@deyin/contract";

interface GitTabProps {
  active: boolean;
  workspaceRoot: string | null;
  /** Show a file's before/after in the Diff tab. */
  onOpenDiff: (diff: FileDiff) => void;
}

const STATUS_LETTER: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
  typechange: "T",
};

/** Right-panel Source Control view: changes, commit, sync, history, stash, blame. */
export function GitTab({ active, workspaceRoot, onOpenDiff }: GitTabProps) {
  const { info, status, refresh } = useGitStatus(workspaceRoot);
  const [view, setView] = useState<"changes" | "history">("changes");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [log, setLog] = useState<GitCommit[]>([]);
  const [selected, setSelected] = useState<GitCommitDetail | null>(null);
  const [blame, setBlame] = useState<{ path: string; lines: GitBlameLine[] } | null>(null);
  const [newBranch, setNewBranch] = useState<string | null>(null);

  const loadStashes = useCallback(() => {
    void window.deyin.git.stashList().then(setStashes).catch(() => setStashes([]));
  }, []);
  const loadLog = useCallback(() => {
    void window.deyin.git.log({ limit: 80 }).then(setLog).catch(() => setLog([]));
  }, []);

  useEffect(() => {
    if (active) loadStashes();
  }, [active, loadStashes]);
  useEffect(() => {
    if (view === "history") loadLog();
  }, [view, loadLog, info?.branch]);
  useEffect(() => {
    return window.deyin.git.onChanged(() => {
      loadStashes();
      if (view === "history") loadLog();
    });
  }, [loadStashes, loadLog, view]);

  const run = async (op: () => Promise<GitResultLite>): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await op();
      if (!r.ok) setNotice(r.message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const openDiff = (path: string, mode: "worktree" | "staged" | "head"): void => {
    void window.deyin.git.diffFile(path, mode).then((d) => onOpenDiff({ fileName: path, before: d.before, after: d.after }));
  };
  const openCommitDiff = (ref: string, file: GitFileEntry): void => {
    void window.deyin.git.diffCommit(ref, file.path).then((d) => onOpenDiff({ fileName: file.path, before: d.before, after: d.after }));
  };
  const openBlame = (path: string): void => {
    void window.deyin.git.blame(path).then((lines) => setBlame({ path, lines }));
  };

  if (!info) return <div className="git-tab__empty">Loading…</div>;
  if (!info.isRepo) {
    return (
      <div className="git-tab__empty">
        <Icon name="gitBranch" size={22} />
        <p>This folder is not a git repository.</p>
      </div>
    );
  }

  const unstaged = status ? [...status.unstaged, ...status.conflicts, ...status.untracked] : [];
  const staged = status?.staged ?? [];
  const canCommit = staged.length > 0 && message.trim().length > 0 && !busy;

  return (
    <div className="git-tab">
      <div className="git-tab__bar">
        <span className="git-tab__branch" title={info.branch ?? "detached"}>
          <Icon name="gitBranch" size={13} /> {info.detached ? "detached" : (info.branch ?? "—")}
        </span>
        <div className="git-tab__spacer" />
        <button className="icon-btn" title="Fetch" disabled={busy} onClick={() => void run(() => window.deyin.git.fetch())}>
          <Icon name="refresh" size={14} />
        </button>
        <button className="icon-btn" title={`Pull${info.behind ? ` (${info.behind})` : ""}`} disabled={busy} onClick={() => void run(() => window.deyin.git.pull())}>
          <Icon name="arrowDown" size={14} />
          {info.behind > 0 && <span className="git-tab__count">{info.behind}</span>}
        </button>
        <button
          className="icon-btn"
          title={`Push${info.ahead ? ` (${info.ahead})` : ""}`}
          disabled={busy}
          onClick={() => void run(() => window.deyin.git.push({ setUpstream: !info.branch ? false : true }))}
        >
          <Icon name="arrowUp" size={14} />
          {info.ahead > 0 && <span className="git-tab__count">{info.ahead}</span>}
        </button>
        <button className="icon-btn" title="New branch" disabled={busy} onClick={() => setNewBranch("")}>
          <Icon name="plus" size={14} />
        </button>
      </div>

      {newBranch !== null && (
        <form
          className="git-tab__newbranch"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newBranch.trim();
            if (name) void run(() => window.deyin.git.createBranch(name)).then(() => setNewBranch(null));
          }}
        >
          <input autoFocus value={newBranch} placeholder="new-branch-name" onChange={(e) => setNewBranch(e.target.value)} />
          <button type="submit" className="btn btn--small">Create</button>
          <button type="button" className="btn btn--small btn--outline" onClick={() => setNewBranch(null)}>Cancel</button>
        </form>
      )}

      <div className="git-tab__toggle">
        <button className={view === "changes" ? "active" : ""} onClick={() => setView("changes")}>Changes</button>
        <button className={view === "history" ? "active" : ""} onClick={() => setView("history")}>History</button>
      </div>

      {notice && <div className="git-tab__notice">{notice}</div>}

      {view === "changes" ? (
        <div className="git-tab__scroll">
          <div className="git-tab__commit">
            <textarea
              placeholder={staged.length ? "Commit message" : "Stage changes to commit"}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <button
              className="btn"
              disabled={!canCommit}
              onClick={() =>
                void run(() => window.deyin.git.commit(message)).then(() => {
                  if (staged.length > 0) setMessage("");
                })
              }
            >
              <Icon name="check" size={13} /> Commit{staged.length ? ` (${staged.length})` : ""}
            </button>
          </div>

          <FileGroup
            title="Staged Changes"
            files={staged}
            count={staged.length}
            groupAction={staged.length ? { label: "Unstage all", icon: "undo", run: () => run(() => window.deyin.git.unstage([])) } : undefined}
            rowActions={(f) => [
              { icon: "undo", title: "Unstage", run: () => run(() => window.deyin.git.unstage([f.path])) },
              { icon: "diff", title: "Open diff", run: () => openDiff(f.path, "staged") },
            ]}
            onOpen={(f) => openDiff(f.path, "staged")}
          />

          <FileGroup
            title="Changes"
            files={unstaged}
            count={unstaged.length}
            groupAction={unstaged.length ? { label: "Stage all", icon: "plus", run: () => run(() => window.deyin.git.stage([])) } : undefined}
            rowActions={(f) => [
              { icon: "plus", title: "Stage", run: () => run(() => window.deyin.git.stage([f.path])) },
              { icon: "trash", title: "Discard", confirm: `Discard changes to ${f.path}?`, run: () => run(() => window.deyin.git.discard([f.path])) },
              { icon: "book", title: "Blame", run: () => openBlame(f.path) },
            ]}
            onOpen={(f) => openDiff(f.path, "worktree")}
          />

          {staged.length === 0 && unstaged.length === 0 && <div className="git-tab__clean">No changes — working tree clean.</div>}

          <StashSection
            stashes={stashes}
            busy={busy}
            onStash={() => run(() => window.deyin.git.stashPush())}
            onPop={(i) => run(() => window.deyin.git.stashPop(i))}
            onDrop={(i) => run(() => window.deyin.git.stashDrop(i))}
          />
        </div>
      ) : (
        <div className="git-tab__scroll">
          {log.length === 0 && <div className="git-tab__clean">No history.</div>}
          {log.map((c) => (
            <div key={c.hash}>
              <button
                className="git-commit"
                onClick={() => (selected?.commit.hash === c.hash ? setSelected(null) : void window.deyin.git.show(c.hash).then(setSelected))}
              >
                <code className="git-commit__hash">{c.shortHash}</code>
                <span className="git-commit__subject">{c.subject}</span>
                <span className="git-commit__author">{c.author}</span>
              </button>
              {selected?.commit.hash === c.hash && (
                <div className="git-commit__files">
                  {selected.files.length === 0 && <div className="git-tab__clean">No file changes.</div>}
                  {selected.files.map((f) => (
                    <button key={f.path} className="git-file" onClick={() => openCommitDiff(c.hash, f)}>
                      <span className={`git-file__badge git-file__badge--${f.status}`}>{STATUS_LETTER[f.status] ?? "?"}</span>
                      <span className="git-file__path">{f.path}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {blame && (
        <div className="git-blame" onClick={() => setBlame(null)}>
          <div className="git-blame__panel" onClick={(e) => e.stopPropagation()}>
            <div className="git-blame__head">
              <span>Blame · {blame.path}</span>
              <button className="icon-btn" onClick={() => setBlame(null)}>
                <Icon name="close" size={14} />
              </button>
            </div>
            <div className="git-blame__body">
              {blame.lines.map((l) => (
                <div key={l.line} className="git-blame__line">
                  <code className="git-blame__hash" title={`${l.author} · ${l.summary}`}>{l.hash.slice(0, 7)}</code>
                  <span className="git-blame__author">{l.author}</span>
                  <pre className="git-blame__content">{l.content}</pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface RowAction {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  confirm?: string;
  run: () => void;
}

function FileGroup(props: {
  title: string;
  files: GitFileEntry[];
  count: number;
  groupAction?: { label: string; icon: Parameters<typeof Icon>[0]["name"]; run: () => void };
  rowActions: (f: GitFileEntry) => RowAction[];
  onOpen: (f: GitFileEntry) => void;
}) {
  const { confirm } = useConfirm();
  if (props.files.length === 0) return null;
  return (
    <div className="git-group">
      <div className="git-group__head">
        <span>{props.title}</span>
        <span className="git-group__count">{props.count}</span>
        {props.groupAction && (
          <button className="git-group__action" title={props.groupAction.label} onClick={props.groupAction.run}>
            <Icon name={props.groupAction.icon} size={13} />
          </button>
        )}
      </div>
      {props.files.map((f) => (
        <div key={`${f.status}:${f.path}`} className="git-file">
          <button className="git-file__main" onClick={() => props.onOpen(f)} title={f.orig ? `${f.orig} → ${f.path}` : f.path}>
            <span className={`git-file__badge git-file__badge--${f.status}`}>{STATUS_LETTER[f.status] ?? "?"}</span>
            <span className="git-file__path">{f.path}</span>
          </button>
          <span className="git-file__actions">
            {props.rowActions(f).map((a) => (
              <button
                key={a.title}
                className="icon-btn icon-btn--small"
                title={a.title}
                onClick={() => {
                  void (async () => {
                    if (a.confirm && !(await confirm({ message: a.confirm, destructive: true }))) return;
                    a.run();
                  })();
                }}
              >
                <Icon name={a.icon} size={12} />
              </button>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function StashSection(props: {
  stashes: GitStash[];
  busy: boolean;
  onStash: () => void;
  onPop: (index: number) => void;
  onDrop: (index: number) => void;
}) {
  return (
    <div className="git-group">
      <div className="git-group__head">
        <span>Stashes</span>
        <span className="git-group__count">{props.stashes.length}</span>
        <button className="git-group__action" title="Stash changes" disabled={props.busy} onClick={props.onStash}>
          <Icon name="archive" size={13} />
        </button>
      </div>
      {props.stashes.map((s) => (
        <div key={s.index} className="git-file">
          <span className="git-file__main">
            <span className="git-file__badge git-file__badge--modified">{s.index}</span>
            <span className="git-file__path">{s.message}</span>
          </span>
          <span className="git-file__actions">
            <button className="icon-btn icon-btn--small" title="Apply & drop (pop)" onClick={() => props.onPop(s.index)}>
              <Icon name="undo" size={12} />
            </button>
            <button className="icon-btn icon-btn--small" title="Drop" onClick={() => props.onDrop(s.index)}>
              <Icon name="trash" size={12} />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
