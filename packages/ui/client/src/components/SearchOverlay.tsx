import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import type { Project } from "../threads.js";
import type { SearchResult } from "@deyin/contract";

interface SearchOverlayProps {
  projects: Project[];
  onSelectThread: (projectId: string, threadId: string) => void;
  onOpenUrl: (url: string) => void;
  onClose: () => void;
}

/** Ctrl+K overlay: fuzzy task matches plus built-in free web search. */
export function SearchOverlay(props: SearchOverlayProps) {
  const [query, setQuery] = useState("");
  const [webResults, setWebResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    inputRef.current?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const taskMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return props.projects
      .flatMap((p) => p.threads.filter((t) => !t.archived).map((t) => ({ project: p, thread: t })))
      .filter(({ thread }) => thread.title.toLowerCase().includes(q))
      .slice(0, 5);
  }, [props.projects, query]);

  // Debounced web search through the built-in engine.
  useEffect(() => {
    clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 3) {
      setWebResults(null);
      setSearching(false);
      setError(null);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      window.deyin.search
        .query(q)
        .then((results) => {
          setWebResults(results);
          setError(null);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setSearching(false));
    }, 450);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="searchbox">
        <div className="searchbox__bar">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            className="searchbox__input"
            placeholder="Search tasks or the web…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {searching && <span className="hint">Searching…</span>}
          <span className="kbd">Esc</span>
        </div>

        <div className="searchbox__body">
          {taskMatches.length > 0 && (
            <>
              <div className="searchbox__section">Tasks</div>
              {taskMatches.map(({ project, thread }) => (
                <button
                  key={thread.id}
                  className="searchbox__row"
                  onClick={() => {
                    props.onSelectThread(project.id, thread.id);
                    props.onClose();
                  }}
                >
                  <Icon name="file" size={13} />
                  <span className="searchbox__title">{thread.title}</span>
                  <span className="hint">{project.name}</span>
                </button>
              ))}
            </>
          )}

          {(webResults !== null || error) && (
            <>
              <div className="searchbox__section">
                Web · built-in search
                <span className="badge badge--quota">free</span>
              </div>
              {error && <div className="searchbox__empty">Search failed: {error}</div>}
              {webResults?.map((result) => (
                <button
                  key={result.url}
                  className="searchbox__row"
                  onClick={() => {
                    props.onOpenUrl(result.url);
                    props.onClose();
                  }}
                >
                  <Icon name="globe" size={13} />
                  <span className="searchbox__meta">
                    <span className="searchbox__title">{result.title}</span>
                    <span className="searchbox__url">{result.url}</span>
                    {result.snippet && <span className="searchbox__snippet">{result.snippet}</span>}
                  </span>
                </button>
              ))}
              {webResults !== null && webResults.length === 0 && !error && (
                <div className="searchbox__empty">No web results.</div>
              )}
            </>
          )}

          {query.trim().length === 0 && (
            <div className="searchbox__empty">
              Type to filter tasks. Three or more characters also search the web (DuckDuckGo, no key required).
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
