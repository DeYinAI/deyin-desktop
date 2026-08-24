import { useEffect, useState } from "react";
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
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<GitHubRepoEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloning, setCloning] = useState<number | null>(null);

  useEffect(() => {
    if (!props.open || !props.connected) return;
    setLoading(true);
    void props
      .listRepos(query)
      .then(setRepos)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [props.open, props.connected, query, props]);

  if (!props.open) return null;

  return (
    <div className="approval" role="dialog" aria-modal="true">
      <div className="approval__box folder-browser">
        <div className="approval__title">
          <Icon name="gitBranch" size={15} />
          GitHub
          {props.login && <span className="hint"> · {props.login}</span>}
        </div>
        {!props.connected ? (
          <div className="approval__summary">
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
        {props.connected && (
          <div className="folder-browser__list">
            {loading && <div className="menu__info">Loading…</div>}
            {!loading &&
              repos.map((repo) => (
                <button
                  key={repo.id}
                  type="button"
                  className="folder-browser__row"
                  disabled={cloning === repo.id}
                  onClick={() => {
                    setCloning(repo.id);
                    void props
                      .onClone(repo)
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
        <div className="approval__actions">
          <button type="button" className="btn btn--outline" onClick={props.onClose}>
            Cancel
          </button>
          {!props.connected && (
            <button type="button" className="btn" onClick={() => void props.onConnectGitHub()}>
              Connect GitHub
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
