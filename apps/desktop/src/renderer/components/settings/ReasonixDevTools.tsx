import { useCallback, useEffect, useState } from "react";
import type { Advanced agentDiagnostics } from "../../../shared/types.js";

interface Props {
  threadId?: string | null;
  title?: string;
}

/** Developer diagnostics: cache prefix shape, coordinator log, fleet timeline. */
export function Advanced agentDevTools({ threadId, title = "Developer diagnostics" }: Props) {
  const [diag, setDiag] = useState<Advanced agentDiagnostics | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.deyin.agent) return;
    setBusy(true);
    try {
      setDiag(await window.deyin.agent.diagnostics(threadId ?? undefined));
    } finally {
      setBusy(false);
    }
  }, [threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clearCache = async () => {
    if (!threadId || !window.deyin.agent) return;
    await window.deyin.agent.clearThreadCache(threadId);
    await refresh();
  };

  if (!window.deyin.agent) return null;

  return (
    <div className="agent-devtools">
      <div className="settings-section">{title}</div>
      <div className="agent-devtools__toolbar">
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
        {threadId && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void clearCache()}>
            Clear thread cache stats
          </button>
        )}
      </div>

      {diag && (
        <>
          <div className="agent-devtools__panel">
            <h3>Cache prefix</h3>
            {diag.cache.prefixShape ? (
              <dl className="agent-kv">
                <dt>prefixHash</dt>
                <dd>{diag.cache.prefixShape.prefixHash}</dd>
                <dt>systemHash</dt>
                <dd>{diag.cache.prefixShape.systemHash}</dd>
                <dt>toolsHash</dt>
                <dd>{diag.cache.prefixShape.toolsHash}</dd>
                <dt>logRewriteVersion</dt>
                <dd>{diag.cache.prefixShape.logRewriteVersion}</dd>
                <dt>session hit rate</dt>
                <dd>{(diag.cache.hitRate * 100).toFixed(1)}%</dd>
              </dl>
            ) : (
              <p className="hint">No prefix shape recorded yet for this thread.</p>
            )}
            {diag.cache.invalidationHistory.length > 0 && (
              <>
                <h4>Invalidation history</h4>
                <ul className="agent-log">
                  {diag.cache.invalidationHistory.slice(-10).map((e, i) => (
                    <li key={i}>
                      {new Date(e.at).toLocaleTimeString()} — {e.reasons.join(", ")} (v{e.logRewriteVersion})
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <div className="agent-devtools__panel">
            <h3>Coordinator decisions</h3>
            {diag.coordinator.length === 0 ? (
              <p className="hint">No routing decisions yet.</p>
            ) : (
              <ul className="agent-log">
                {diag.coordinator.slice(-10).map((e, i) => (
                  <li key={i}>
                    {new Date(e.at).toLocaleTimeString()} — <strong>{e.route}</strong> ({e.reason})
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="agent-devtools__panel">
            <h3>Fleet timeline</h3>
            {diag.fleet.length === 0 ? (
              <p className="hint">No fleet events yet.</p>
            ) : (
              <ul className="agent-log">
                {diag.fleet.slice(-10).map((e, i) => (
                  <li key={i}>
                    {new Date(e.at).toLocaleTimeString()} — [{e.kind}] {e.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
