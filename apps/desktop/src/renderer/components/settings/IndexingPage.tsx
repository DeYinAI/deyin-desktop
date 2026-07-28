import { useEffect, useState } from "react";
import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";
import type { DeyinSettings, IndexSearchHit, IndexStatus } from "../../../shared/types.js";

interface Props {
  workspaceRoot: string | null;
  settings: DeyinSettings;
  onChange: (patch: Partial<DeyinSettings>) => void;
}

const STATE_LABEL: Record<IndexStatus["state"], string> = {
  disabled: "Disabled",
  "no-workspace": "No workspace open",
  scanning: "Scanning files…",
  indexing: "Indexing…",
  ready: "Up to date",
  error: "Error",
};

/** Live local semantic index: status, rebuild, watcher and a search probe. */
export function IndexingPage({ workspaceRoot, settings, onChange }: Props) {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<IndexSearchHit[] | null>(null);

  useEffect(() => {
    void window.deyin.index.status().then(setStatus).catch(() => setStatus(null));
    const off = window.deyin.index.onStatus(setStatus);
    return off;
  }, []);

  const rebuild = async () => {
    setRebuilding(true);
    try {
      await window.deyin.index.rebuild();
    } finally {
      setRebuilding(false);
    }
  };

  const search = async () => {
    if (!query.trim()) return;
    setHits(await window.deyin.index.search(query.trim(), 5));
  };

  const describe = (): string => {
    if (!status) return "Index status unavailable.";
    if (status.state === "indexing" && status.progress) {
      return `Indexing ${status.progress.done}/${status.progress.total} changed files…`;
    }
    const base = `${status.files} files · ${status.chunks} chunks · engine ${status.model}`;
    if (status.lastSync) return `${base} · synced ${new Date(status.lastSync).toLocaleTimeString()}`;
    return base;
  };

  return (
    <div className="settings-page">
      <PageHeader
        title="Indexing"
        description="Deyin builds a local semantic index of your workspace so the agent can search code by meaning (codebase_search). Everything stays on this machine."
      />

      <SectionTitle>Workspace index</SectionTitle>
      <SettingCard title="Semantic indexing" description="Index the workspace and keep it in sync as files change.">
        <Toggle checked={settings.indexingEnabled} onChange={(v) => onChange({ indexingEnabled: v })} />
      </SettingCard>
      <SettingCard
        title={workspaceRoot ?? "No workspace open"}
        description={
          status
            ? `${STATE_LABEL[status.state]} — ${describe()}${status.watching ? " · watching for changes" : ""}${status.error ? ` · ${status.error}` : ""}`
            : "Open a folder to enable indexing."
        }
      >
        <button
          className="btn btn--outline"
          disabled={!workspaceRoot || rebuilding || !settings.indexingEnabled}
          onClick={() => void rebuild()}
        >
          {rebuilding || status?.state === "indexing" ? "Indexing…" : "Rebuild index"}
        </button>
      </SettingCard>
      <SettingCard
        title="Ignore rules"
        description="`.gitignore` is respected automatically; add a `.deyinignore` at the workspace root for index-only exclusions."
      />

      <SectionTitle>Try a search</SectionTitle>
      <div className="field__row" style={{ marginBottom: 10 }}>
        <input
          className="input"
          placeholder="e.g. where are settings persisted?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
          }}
        />
        <button className="btn btn--outline" disabled={!query.trim()} onClick={() => void search()}>
          Search
        </button>
      </div>
      {hits && hits.length === 0 && <div className="hint">No results.</div>}
      {hits?.map((hit, i) => (
        <div className="index-hit" key={i}>
          <div className="index-hit__path">
            {hit.path}:{hit.startLine}-{hit.endLine}
            <span className="badge badge--muted">{hit.score.toFixed(3)}</span>
          </div>
          <pre className="index-hit__preview">{hit.preview}</pre>
        </div>
      ))}
    </div>
  );
}
