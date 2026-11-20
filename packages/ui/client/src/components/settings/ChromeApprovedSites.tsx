import { useCallback, useEffect, useState } from "react";
import { normalizeApprovedOrigin } from "../../chromeStatus.js";
import { SettingCard } from "./controls.js";

type ChromeApi = NonNullable<typeof window.deyin.chrome>;

/** Sites the user chose "Always allow" for. Local pages and about:blank never need approval. */
export function ChromeApprovedSites({ api }: { api: ChromeApi }) {
  const [origins, setOrigins] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api.getApprovedOrigins().then((list) => {
      if (live) setOrigins(list);
    });
    return () => {
      live = false;
    };
  }, [api]);

  const save = useCallback(
    async (next: string[]): Promise<void> => {
      setError(null);
      try {
        setOrigins(await api.setApprovedOrigins(next));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save the list.");
      }
    },
    [api],
  );

  const add = async (): Promise<void> => {
    if (!draft.trim()) return;
    const result = normalizeApprovedOrigin(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDraft("");
    await save([...new Set([...origins, result.origin])]);
  };

  return (
    <SettingCard
      title="Approved sites"
      description="Deyin asks before it first uses a site in your Chrome. Sites you choose Always allow for are listed here."
    >
      <div className="chrome-sites">
        {origins.length === 0 ? (
          <p className="hint">No sites approved yet.</p>
        ) : (
          <div className="chip-list">
            {origins.map((origin) => (
              <span key={origin} className="chip">
                {origin}
                <button
                  type="button"
                  className="chip__remove"
                  onClick={() => void save(origins.filter((o) => o !== origin))}
                  aria-label={`Remove ${origin}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="chrome-actions">
          <input
            type="text"
            className="input"
            placeholder="https://example.com"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
            aria-label="Site to approve"
          />
          <button type="button" className="btn btn--small" disabled={!draft.trim()} onClick={() => void add()}>
            Add site
          </button>
        </div>
        {error && <p className="hint hint--bad">{error}</p>}
      </div>
    </SettingCard>
  );
}
