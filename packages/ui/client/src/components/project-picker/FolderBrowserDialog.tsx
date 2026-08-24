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
  const [currentPath, setCurrentPath] = useState(props.initialPath);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        const rows = await props.listDirectory(path);
        setEntries(rows);
        setCurrentPath(path);
        setSelected(path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [props],
  );

  useEffect(() => {
    if (!props.open) return;
    setFilter("");
    void load(props.initialPath);
    inputRef.current?.focus();
  }, [props.open, props.initialPath, load]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [props]);

  const folders = useMemo(() => filterDirectoryEntries(entries, filter), [entries, filter]);
  const crumbs = useMemo(() => breadcrumbSegments(currentPath), [currentPath]);

  if (!props.open) return null;

  return (
    <div
      className="approval"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div className="approval__box folder-browser">
        <div className="approval__title">
          <Icon name="folder" size={15} />
          {props.title}
          {props.envLabel && <span className="hint"> · {props.envLabel}</span>}
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
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="folder-browser__list">
          {loading && <div className="menu__info">Loading…</div>}
          {!loading && parentPath(currentPath) && (
            <button type="button" className="folder-browser__row" onClick={() => void load(parentPath(currentPath)!)}>
              <Icon name="folder" size={13} />
              <span>..</span>
            </button>
          )}
          {!loading &&
            folders.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className={`folder-browser__row${selected === entry.path ? " folder-browser__row--active" : ""}`}
                onClick={() => {
                  setSelected(entry.path);
                  void load(entry.path);
                }}
                onDoubleClick={() => props.onOpen(entry.path)}
              >
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
          <button type="button" className="btn" disabled={!selected} onClick={() => selected && props.onOpen(selected)}>
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
