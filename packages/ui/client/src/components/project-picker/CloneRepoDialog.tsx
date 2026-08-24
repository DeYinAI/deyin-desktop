import { useState } from "react";
import { Icon } from "../Icon.js";

export interface CloneRepoDialogProps {
  open: boolean;
  busy?: boolean;
  progressLine?: string | null;
  onClose: () => void;
  onSubmit: (opts: { url: string; token?: string; branch?: string }) => Promise<void>;
}

export function CloneRepoDialog(props: CloneRepoDialogProps) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!props.open) return null;

  const submit = () => {
    const clean = url.trim();
    if (!clean) return;
    setSubmitting(true);
    setError(null);
    void props
      .onSubmit({ url: clean, token: token.trim() || undefined, branch: branch.trim() || undefined })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="approval" role="dialog" aria-modal="true">
      <div className="approval__box">
        <div className="approval__title">
          <Icon name="gitBranch" size={15} />
          Clone repository
        </div>
        <div className="approval__summary">
          Clones into your local Deyin folder and opens it as the workspace.
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
            Access token <span className="repo-form__hint">(optional)</span>
            <input
              className="repo-form__input"
              type="password"
              placeholder="ghp_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <label className="repo-form__label">
            Branch <span className="repo-form__hint">(optional)</span>
            <input
              className="repo-form__input"
              placeholder="main"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </label>
          {props.progressLine && <div className="menu__info">{props.progressLine}</div>}
          {error && <div className="repo-form__error">{error}</div>}
        </div>
        <div className="approval__actions">
          <button type="button" className="btn btn--outline" onClick={props.onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={submit} disabled={submitting || !url.trim() || props.busy}>
            {submitting || props.busy ? "Cloning…" : "Clone & open"}
          </button>
        </div>
      </div>
    </div>
  );
}
