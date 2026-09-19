import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DirectoryEntry } from "@deyin/contract";
import { Icon } from "../Icon.js";
import { breadcrumbSegments, filterDirectoryEntries, parentPath } from "./folder-browser-utils.js";

export interface FolderBrowserDialogProps {
  open: boolean;
  title: string;
  initialPath: string;
  envLabel?: string;
  onClose: () => void;
  onOpen: (path: string) => void;
  listDirectory: (path: string) => Promise<DirectoryEntry[]>;
}

/** In-app folder picker with breadcrumbs and filter (Cursor-style). */
export function FolderBrowserDialog(props: FolderBrowserDialogProps) {
  const { open, title, initialPath, envLabel, onClose, onOpen, listDirectory } = props;
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);

  const load = useCallback(
    async (path: string) => {
      const id = ++reqId.current;
      setLoading(true);
      setError(null);
      try {
        const rows = await listDirectory(path);
        if (id !== reqId.current) return;
        setEntries(rows);
        setCurrentPath(path);
        setSelected(null);
      } catch (err) {
        if (id !== reqId.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setEntries([]);
      } finally {
        if (id === reqId.current) {
          setLoading(false);
        }
      }
    },
    [listDirectory],
  );

  useEffect(() => {
    if (!open) return;
    setFilter("");
    setSelected(null);
    void load(initialPath);
    inputRef.current?.focus();
  }, [open, initialPath, load]);

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

  const folders = useMemo(() => filterDirectoryEntries(entries, filter), [entries, filter]);
  const crumbs = useMemo(() => breadcrumbSegments(currentPath), [currentPath]);

  if (!open) return null;

  const targetPath = selected || currentPath;

  const handleFilterKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (selected) {
        onOpen(selected);
      } else if (folders.length === 1 && folders[0]) {
        onOpen(folders[0].path);
      } else if (currentPath) {
        onOpen(currentPath);
      }
    } else if (e.key === "ArrowDown" && folders.length > 0) {
      e.preventDefault();
      const first = folders[0];
      if (first) setSelected(first.path);
    }
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal folder-browser">
        <div className="modal__title">
          <Icon name="folder" size={16} />
          <span>{title}</span>
          {envLabel && <span className="hint"> · {envLabel}</span>}
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
            ref={inputRef}
            className="repo-form__input"
            placeholder="Filter folders or press Enter to open…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={handleFilterKeyDown}
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
            <div className="menu__info">{filter ? "No matching folders" : "No folders found"}</div>
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
            disabled={!targetPath || loading}
            onClick={() => targetPath && onOpen(targetPath)}
          >
            {selected && selected !== currentPath ? "Open Selected" : "Open Folder"}
          </button>
        </div>
      </div>
    </div>
  );
}
