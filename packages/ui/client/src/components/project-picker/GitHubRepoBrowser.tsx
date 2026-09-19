import { useEffect, useRef, useState } from "react";
import type { GitHubRepoEntry } from "@deyin/contract";
import { Icon } from "../Icon.js";

export interface GitHubRepoBrowserProps {
  open: boolean;
  connected: boolean;
  login: string | null;
  onClose: () => void;
  onConnectGitHub: () => Promise<void>;
  onClone: (repo: GitHubRepoEntry) => Promise<void>;
  listRepos: (query?: string) => Promise<GitHubRepoEntry[]>;
}

export function GitHubRepoBrowser(props: GitHubRepoBrowserProps) {
  const { open, connected, login, onClose, onConnectGitHub, onClone, listRepos } = props;
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<GitHubRepoEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloning, setCloning] = useState<number | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !connected) return;
    const id = ++reqId.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void listRepos(query)
        .then((data) => {
          if (id === reqId.current) {
            setRepos(data);
            setError(null);
          }
        })
        .catch((err) => {
          if (id === reqId.current) {
            setError(err instanceof Error ? err.message : String(err));
          }
        })
        .finally(() => {
          if (id === reqId.current) {
            setLoading(false);
          }
        });
    }, 250);

    return () => clearTimeout(timer);
  }, [open, connected, query, listRepos]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal folder-browser">
        <div className="modal__title">
          <Icon name="gitBranch" size={16} />
          <span>GitHub</span>
          {login && <span className="hint"> · {login}</span>}
        </div>
        {!connected ? (
          <div className="modal__summary">
            Connect your GitHub account to browse and clone repositories.
          </div>
        ) : (
          <div className="folder-browser__filter">
            <input
              className="repo-form__input"
              placeholder="Search repositories…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        {connected && (
          <div className="folder-browser__list">
            {loading && <div className="menu__info">Loading…</div>}
            {!loading && !error && repos.length === 0 && (
              <div className="menu__info">{query ? "No matching repositories" : "No repositories found"}</div>
            )}
            {!loading &&
              repos.map((repo) => (
                <button
                  key={repo.id}
                  type="button"
                  className="folder-browser__row"
                  disabled={cloning === repo.id}
                  onClick={() => {
                    setCloning(repo.id);
                    void onClone(repo)
                      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                      .finally(() => setCloning(null));
                  }}
                >
                  <Icon name="gitBranch" size={13} />
                  <span>{repo.fullName}</span>
                  {repo.private && <span className="hint">private</span>}
                </button>
              ))}
          </div>
        )}
        {error && <div className="repo-form__error">{error}</div>}
        <div className="modal__actions">
          <button type="button" className="btn btn--outline" onClick={onClose}>
            Cancel
          </button>
          {!connected && (
            <button type="button" className="btn btn--primary" onClick={() => void onConnectGitHub()}>
              Connect GitHub
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
