import { useCallback, useEffect, useRef, useState } from "react";
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
  const { open, hosts, onClose, onConnect, browse } = props;
  const [hostId, setHostId] = useState<string | null>(hosts[0]?.id ?? null);
  const [currentPath, setCurrentPath] = useState("/home");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    if (!hostId && hosts.length > 0 && hosts[0]) {
      setHostId(hosts[0].id);
    }
  }, [hostId, hosts]);

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

  const load = useCallback(
    async (path: string) => {
      if (!hostId) return;
      const id = ++reqId.current;
      setLoading(true);
      setError(null);
      try {
        const rows = await browse(hostId, path);
        if (id !== reqId.current) return;
        setEntries(rows);
        setCurrentPath(path);
        setSelected(null);
      } catch (err) {
        if (id !== reqId.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (id === reqId.current) {
          setLoading(false);
        }
      }
    },
    [hostId, browse],
  );

  useEffect(() => {
    if (!open || !hostId) return;
    setSelected(null);
    setFilter("");
    void load("/home");
  }, [open, hostId, load]);

  if (!open) return null;

  const folders = filterDirectoryEntries(entries, filter);
  const crumbs = breadcrumbSegments(currentPath);
  const targetPath = selected || currentPath;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal folder-browser">
        <div className="modal__title">
          <Icon name="server" size={16} />
          <span>Connect via SSH</span>
        </div>
        <div className="repo-form">
          <label className="repo-form__label">
            SSH host
            <select
              className="repo-form__input"
              value={hostId ?? ""}
              onChange={(e) => setHostId(e.target.value || null)}
            >
              {hosts.map((h) => (
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
            placeholder="Filter folders…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="folder-browser__list">
          {loading && <div className="menu__info">Loading…</div>}
          {!loading && parentPath(currentPath) && (
            <div
              tabIndex={0}
              className="folder-browser__row"
              onClick={() => void load(parentPath(currentPath)!)}
              onKeyDown={(e) => e.key === "Enter" && void load(parentPath(currentPath)!)}
              title="Go up one folder"
            >
              <Icon name="arrowUp" size={13} />
              <span>..</span>
            </div>
          )}
          {!loading && !error && folders.length === 0 && (
            <div className="menu__info">{filter ? "No matching folders" : "Empty directory"}</div>
          )}
          {!loading &&
            folders.map((entry) => (
              <div
                key={entry.path}
                tabIndex={0}
                className={`folder-browser__row${selected === entry.path ? " folder-browser__row--active" : ""}`}
                onClick={() => setSelected(entry.path)}
                onDoubleClick={() => void load(entry.path)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (selected === entry.path) {
                      void load(entry.path);
                    } else {
                      setSelected(entry.path);
                    }
                  }
                }}
              >
                <Icon name="folder" size={13} />
                <span className="folder-browser__name">{entry.name}</span>
                <button
                  type="button"
                  className="folder-browser__drill"
                  title={`Browse into ${entry.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void load(entry.path);
                  }}
                >
                  <Icon name="chevronRight" size={12} />
                </button>
              </div>
            ))}
        </div>
        {error && <div className="repo-form__error">{error}</div>}
        <div className="modal__actions">
          <button type="button" className="btn btn--outline" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!hostId || connecting || loading}
            onClick={() => {
              if (!hostId || !targetPath) return;
              setConnecting(true);
              void onConnect(hostId, targetPath)
                .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                .finally(() => setConnecting(false));
            }}
          >
            {connecting ? "Connecting…" : selected && selected !== currentPath ? "Open Selected" : "Open Folder"}
          </button>
        </div>
      </div>
    </div>
  );
}
