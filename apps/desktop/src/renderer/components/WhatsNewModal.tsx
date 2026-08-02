interface Props {
  version: string;
  onDismiss: () => void;
}

/** Release notes modal for existing users upgrading to 2.0. */
export function WhatsNewModal({ version, onDismiss }: Props) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="whats-new-title">
      <div className="modal whats-new-modal">
        <h2 id="whats-new-title">What&apos;s new in Deyin {version}</h2>
        <p className="whats-new-modal__lead">
          DeepSeek-Reasonix integration brings cache-first architecture, two-model coordination, fleet orchestration,
          and delivery mode with evidence gates.
        </p>
        <ul className="whats-new-modal__list">
          <li>
            <strong>Prefix cache</strong> — ≥80% hit rate target with diagnostics in Settings → Prefix cache
          </li>
          <li>
            <strong>Coordinator</strong> — Optional planner model for multi-file and high-risk tasks (feature flag)
          </li>
          <li>
            <strong>Fleet</strong> — Parallel subagents with write-path preflight (feature flag)
          </li>
          <li>
            <strong>Delivery mode</strong> — Evidence gates with complete_step sign-offs (feature flag)
          </li>
        </ul>
        <p className="hint">
          New features are off by default during beta. Enable them in Settings → Reasonix integration.
        </p>
        <div className="modal__actions">
          <button type="button" className="btn btn--primary" onClick={onDismiss}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
