import { useEffect, useState } from "react";
import type { RepoShipResult, RepoStateResult } from "@deyin/contract";
import { Icon } from "./Icon.js";
import { useGitStatus } from "./GitBranchBadge.js";
import { PromptDock } from "./PromptDock.js";

interface RepoBarProps {
  /** Live repo state for the session sandbox (null before the first state probe). */
  repoState: RepoStateResult | null;
  /** Which repo operation is running (drives the busy indicator). */
  busy: "connect" | "ship" | null;
  /** Last progress line pushed by the host (clone/checkout/ship steps). */
  progressLine: string | null;
  /** Connect dialog visibility is lifted so other entry points can open it. */
  connectOpen: boolean;
  onConnectOpenChange: (open: boolean) => void;
  onConnect: (opts: { url: string; token?: string; branch?: string }) => Promise<RepoStateResult | null>;
  onShip: (message?: string) => Promise<RepoShipResult | null>;
}

/**
 * Web repo workflow in the chat top bar: a "Connect repository" chip while the
 * sandbox is empty, and a Ship button (commit → push → merge) once a repo is
 * connected. The Ship flow always confirms before touching the remote.
 */
export function RepoBar(props: RepoBarProps) {
  const connected = props.repoState?.connected === true;
  const [connectError, setConnectError] = useState<string | null>(null);

  return (
    <>
      {!connected ? (
        props.busy === "connect" ? (
          <button className="env-badge" title={props.progressLine ?? "Connecting repository…"} disabled>
            <Icon name="refresh" size={12} />
            <span>{props.progressLine ?? "Connecting…"}</span>
          </button>
        ) : (
          <button
            className="env-badge"
            title="Clone a git repository into this session"
            onClick={() => {
              setConnectError(null);
              props.onConnectOpenChange(true);
            }}
          >
            <Icon name="gitBranch" size={12} />
            <span>Connect repository</span>
          </button>
        )
      ) : (
        <ShipButton {...props} />
      )}

      {props.connectOpen && (
        <ConnectDialog
          onClose={() => props.onConnectOpenChange(false)}
          onSubmit={async (opts) => {
            setConnectError(null);
            try {
              const state = await props.onConnect(opts);
              if (state) props.onConnectOpenChange(false);
            } catch (err) {
              setConnectError(err instanceof Error ? err.message : String(err));
            }
          }}
          error={connectError}
        />
      )}
    </>
  );
}

/* Connect dialog ---------------------------------------------------------------- */

function ConnectDialog({
  onClose,
  onSubmit,
  error,
}: {
  onClose: () => void;
  onSubmit: (opts: { url: string; token?: string; branch?: string }) => Promise<void>;
  error: string | null;
}) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [branch, setBranch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = () => {
    const clean = url.trim();
    if (!clean) return;
    setSubmitting(true);
    void onSubmit({
      url: clean,
      token: token.trim() || undefined,
      branch: branch.trim() || undefined,
    }).finally(() => setSubmitting(false));
  };

  return (
    <div className="approval" role="dialog" aria-modal="true">
      <div className="approval__box">
        <div className="approval__title">
          <Icon name="gitBranch" size={15} />
          Connect a repository
        </div>
        <div className="approval__summary">
          Clones the repository into this session and creates a work branch. Your changes stay on that branch until you ship them.
        </div>
        <div className="repo-form">
          <label className="repo-form__label">
            Repository URL
            <input
              className="repo-form__input"
              autoFocus
              placeholder="https://github.com/owner/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </label>
          <label className="repo-form__label">
            Access token <span className="repo-form__hint">(optional, for private repos — never stored)</span>
            <input
              className="repo-form__input"
              type="password"
              placeholder="ghp_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <label className="repo-form__label">
            Branch <span className="repo-form__hint">(optional, resume an existing branch)</span>
            <input
              className="repo-form__input"
              placeholder="deyin/my-task (new work branch by default)"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </label>
          {error && <div className="repo-form__error">{error}</div>}
        </div>
        <div className="approval__actions">
          <button className="btn btn--outline" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="btn" onClick={submit} disabled={submitting || !url.trim()}>
            {submitting ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* Ship button + confirm/result dialogs ------------------------------------------ */

function ShipButton(props: RepoBarProps) {
  const repo = props.repoState!;
  const git = useGitStatus(null);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RepoShipResult | null>(null);

  // Counts for the badge: changed files and commits not yet on the remote.
  useEffect(() => {
    if (open) git.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dirty = git.status
    ? new Set([...git.status.staged, ...git.status.unstaged, ...git.status.untracked, ...git.status.conflicts].map((e) => e.path)).size
    : 0;
  const ahead = git.info?.ahead ?? 0;
  const shipping = props.busy === "ship";

  const ship = () => {
    setError(null);
    void props
      .onShip(message.trim() || undefined)
      .then((r) => {
        if (r) setResult(r);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <>
      <button
        className="env-badge repo-ship__badge"
        title={`Commit, push and merge ${repo.branch ?? ""} into ${repo.defaultBranch ?? "the default branch"}`}
        disabled={shipping}
        onClick={() => { setError(null); setOpen(true); }}
      >
        <Icon name="rocket" size={12} />
        <span>{shipping ? (props.progressLine ?? "Shipping…") : "Ship"}</span>
        {!shipping && dirty + ahead > 0 && <span className="git-badge__dirty">{dirty + ahead}</span>}
      </button>

      {open && !result && (
        <div className="approval" role="dialog" aria-modal="true">
          <div className="approval__box">
            <div className="approval__title">
              <Icon name="rocket" size={15} />
              Ship changes
            </div>
            <div className="approval__summary">
              {repo.branch} → {repo.defaultBranch ?? "default branch"}: commits remaining changes, pushes{" "}
              <strong>{repo.branch}</strong>, merges into <strong>{repo.defaultBranch}</strong> and pushes it.
            </div>
            <div className="repo-form">
              <div className="repo-form__stats">
                <span>{dirty} changed file{dirty === 1 ? "" : "s"}</span>
                <span>{ahead} commit{ahead === 1 ? "" : "s"} ahead</span>
              </div>
              <label className="repo-form__label">
                Commit message <span className="repo-form__hint">(for uncommitted leftovers)</span>
                <input
                  className="repo-form__input"
                  placeholder="deyin: task changes"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && ship()}
                />
              </label>
              {error && <div className="repo-form__error">{error}</div>}
            </div>
            <div className="approval__actions">
              <button className="btn btn--outline" onClick={() => setOpen(false)} disabled={shipping}>
                Cancel
              </button>
              <button className="btn" onClick={ship} disabled={shipping}>
                <Icon name="rocket" size={12} />
                {shipping ? "Shipping…" : "Commit, push & merge"}
              </button>
            </div>
          </div>
        </div>
      )}

      {result && (
        <PromptDock>
          <div className={`inline-card${result.ok ? "" : " inline-card--danger"}`} role="status">
            <span className="inline-card__icon">
              <Icon name={result.ok ? "check" : "flag"} size={15} />
            </span>
            <div className="inline-card__text">
              <div className="inline-card__title">
                {result.ok ? "Merged" : "Ship needs attention"}
              </div>
              <div className="inline-card__body">
                {result.ok ? (
                  <>
                    <strong>{result.branch}</strong> was merged into{" "}
                    <strong>{result.defaultBranch}</strong>.
                  </>
                ) : (
                  result.message
                )}
              </div>
            </div>
            <div className="inline-card__actions">
              {result.prUrl && (
                <a className="btn btn--outline" href={result.prUrl} target="_blank" rel="noreferrer">
                  Open pull request <Icon name="external" size={12} />
                </a>
              )}
              <button
                className="btn"
                onClick={() => {
                  setResult(null);
                  setOpen(false);
                }}
              >
                Done
              </button>
            </div>
          </div>
        </PromptDock>
      )}
    </>
  );
}
