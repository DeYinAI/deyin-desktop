import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import type { GitBranch, GitFileStatus, GitLogEntry, GitStatus } from "../../shared/types.js";

interface GitTabProps {
  active: boolean;
  workspaceRoot: string | null;
  codeDisplay: import("./panelTypes.js").CodeDisplaySettings;
  threadId?: string | null;
  onScanComplete?: () => void;
}

export function GitTab(props: GitTabProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [diffText, setDiffText] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    if (!props.workspaceRoot) {
      setStatus(null);
      return;
    }
    setError(null);
    try {
      const [st, br, lg] = await Promise.all([
        window.deyin.git.status(),
        window.deyin.git.branches(),
        window.deyin.git.log(15),
      ]);
      setStatus(st);
      setBranches(br);
      setLog(lg);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (props.active) void refresh();
  }, [props.active, props.workspaceRoot]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const selectFile = async (file: GitFileStatus) => {
    setSelected(file.path);
    try {
      const staged = file.index !== "." && file.index !== "?";
      const text = await window.deyin.git.diff(file.path, staged);
      setDiffText(text || "(no diff)");
    } catch (err) {
      setDiffText(err instanceof Error ? err.message : String(err));
    }
  };

  const stage = async (paths: string[], unstage = false) => {
    setBusy(true);
    try {
      await window.deyin.git.stage(paths, unstage);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!commitMsg.trim()) return;
    setBusy(true);
    try {
      await window.deyin.git.commit(commitMsg.trim());
      setCommitMsg("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runSecurityScanOnDiff = async () => {
    setMenu(null);
    if (!props.threadId || !diffText.trim()) return;
    setScanBusy(true);
    setError(null);
    try {
      await window.deyin.security.scanDiff(props.threadId, diffText);
      props.onScanComplete?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanBusy(false);
    }
  };

  if (!props.workspaceRoot) {
    return <p className="wspanel__empty">Open a workspace folder to use Git.</p>;
  }
  if (!status) {
    return <p className="wspanel__empty">{error ?? "Not a git repository or still loading…"}</p>;
  }

  const diffLines = diffText ? diffText.split("\n") : [];

  return (
    <div className="git-tab">
      <div className="git-tab__header">
        <span className="git-tab__branch">
          <Icon name="diff" size={14} />
          {status.branch}
          {status.ahead > 0 || status.behind > 0 ? (
            <span className="git-tab__track">
              {status.ahead > 0 ? `↑${status.ahead}` : ""}
              {status.behind > 0 ? `↓${status.behind}` : ""}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-label="Refresh git status"
          onClick={() => void refresh()}
          disabled={busy || scanBusy}
        >
          Refresh
        </button>
      </div>

      {branches.length > 1 && (
        <div className="git-tab__branches">
          <select
            aria-label="Switch branch"
            value={status.branch}
            onChange={(e) => {
              void window.deyin.git.checkout(e.target.value).then(refresh);
            }}
          >
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
                {b.current ? " (current)" : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="git-tab__files">
        {status.files.length === 0 ? (
          <p className="wspanel__empty">Working tree clean</p>
        ) : (
          status.files.map((f) => (
            <button
              type="button"
              key={f.path}
              className={`git-tab__file ${selected === f.path ? "git-tab__file--active" : ""}`}
              aria-label={`View diff for ${f.path}`}
              onClick={() => void selectFile(f)}
            >
              <span className="git-tab__file-status">{f.workTree !== "." ? f.workTree : f.index}</span>
              <span>{f.path}</span>
            </button>
          ))
        )}
      </div>

      {selected && (
        <div className="git-tab__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-label="Stage selected file"
            onClick={() => void stage([selected])}
            disabled={busy}
          >
            Stage
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-label="Unstage selected file"
            onClick={() => void stage([selected], true)}
            disabled={busy}
          >
            Unstage
          </button>
        </div>
      )}

      {diffText && (
        <pre
          className="git-tab__diff"
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          {diffLines.map((line, i) => (
            <div
              key={i}
              className={`diff-line ${line.startsWith("+") ? "diff-line--add" : line.startsWith("-") ? "diff-line--del" : "diff-line--context"}`}
            >
              {line}
            </div>
          ))}
        </pre>
      )}

      {menu && (
        <div
          ref={menuRef}
          className="menu__panel threadmenu"
          style={{ position: "fixed", left: menu.x, top: menu.y, right: "auto" }}
        >
          <button
            type="button"
            className="menu__item"
            aria-label="Run security scan on diff"
            disabled={!props.threadId || scanBusy || !diffText.trim()}
            onClick={() => void runSecurityScanOnDiff()}
          >
            <Icon name="shield" size={13} />
            <span>Run security scan on diff</span>
          </button>
        </div>
      )}

      <div className="git-tab__commit">
        <input
          className="input"
          placeholder="Commit message"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--primary btn--sm"
          aria-label="Commit staged changes"
          onClick={() => void commit()}
          disabled={busy || !commitMsg.trim()}
        >
          Commit
        </button>
      </div>

      {log.length > 0 && (
        <div className="git-tab__log">
          <h4>Recent commits</h4>
          <ul>
            {log.map((e) => (
              <li key={e.hash}>
                <code>{e.hash.slice(0, 7)}</code> {e.subject}
                <span className="git-tab__log-meta">
                  {e.author} · {e.date}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
