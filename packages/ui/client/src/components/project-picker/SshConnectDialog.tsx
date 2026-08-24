import { useEffect, useState } from "react";
import type { DirectoryEntry, SshHostInfo } from "@deyin/contract";
import { Icon } from "../Icon.js";
import { breadcrumbSegments, filterDirectoryEntries, parentPath } from "./folder-browser-utils.js";

export interface SshConnectDialogProps {
  open: boolean;
  hosts: SshHostInfo[];
  onClose: () => void;
  onConnect: (hostId: string, remotePath: string) => Promise<void>;
  browse: (hostId: string, remotePath: string) => Promise<DirectoryEntry[]>;
}

export function SshConnectDialog(props: SshConnectDialogProps) {
  const [hostId, setHostId] = useState<string | null>(props.hosts[0]?.id ?? null);
  const [currentPath, setCurrentPath] = useState("/home");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const load = async (path: string) => {
    if (!hostId) return;
    setLoading(true);
    setError(null);
    try {
      const rows = await props.browse(hostId, path);
      setEntries(rows);
      setCurrentPath(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!props.open || !hostId) return;
    void load("/home");
  }, [props.open, hostId]);

  if (!props.open) return null;

  const folders = filterDirectoryEntries(entries, filter);
  const crumbs = breadcrumbSegments(currentPath);

  return (
    <div className="approval" role="dialog" aria-modal="true">
      <div className="approval__box folder-browser">
        <div className="approval__title">
          <Icon name="server" size={15} />
          Connect via SSH
        </div>
        <div className="repo-form">
          <label className="repo-form__label">
            SSH host
            <select
              className="repo-form__input"
              value={hostId ?? ""}
              onChange={(e) => setHostId(e.target.value || null)}
            >
              {props.hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label || `${h.username}@${h.host}`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="folder-browser__crumbs">
          {crumbs.map((c) => (
            <button key={c.path} type="button" className="folder-browser__crumb" onClick={() => void load(c.path)}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="folder-browser__filter">
          <input
            className="repo-form__input"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="folder-browser__list">
          {loading && <div className="menu__info">Loading…</div>}
          {!loading && parentPath(currentPath) && (
            <button type="button" className="folder-browser__row" onClick={() => void load(parentPath(currentPath)!)}>
              <Icon name="arrowUp" size={13} />
              <span>..</span>
            </button>
          )}
          {!loading &&
            folders.map((entry) => (
              <button key={entry.path} type="button" className="folder-browser__row" onDoubleClick={() => void load(entry.path)} onClick={() => void load(entry.path)}>
                <Icon name="folder" size={13} />
                <span>{entry.name}</span>
              </button>
            ))}
        </div>
        {error && <div className="repo-form__error">{error}</div>}
        <div className="approval__actions">
          <button type="button" className="btn btn--outline" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hostId || connecting}
            onClick={() => {
              if (!hostId) return;
              setConnecting(true);
              void props
                .onConnect(hostId, currentPath)
                .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                .finally(() => setConnecting(false));
            }}
          >
            {connecting ? "Connecting…" : "Open folder"}
          </button>
        </div>
      </div>
    </div>
  );
}
