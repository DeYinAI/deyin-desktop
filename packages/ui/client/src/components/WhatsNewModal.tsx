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
          Cache-first agent architecture, two-model coordination, fleet orchestration, and
          delivery mode with evidence gates.
        </p>
        <ul className="whats-new-modal__list">
          <li>
            <strong>Model providers</strong> — DeepSeek, OpenAI, Anthropic, Gemini, OpenRouter, Groq, xAI, Mistral and Ollama are pre-configured; just add a key.
          </li>
          <li>
            <strong>Simpler settings</strong> — 23 pages collapsed into six: General, Models, Capabilities, Workspace, Data and Account.
          </li>
          <li>
            <strong>Faster chat</strong> — one streaming pipeline for thinking, tool calls and subagents; runs keep streaming while you switch tasks.
          </li>
        </ul>
        <p className="hint">
          New features are off by default during beta. Enable them in Settings → Advanced agent features.
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
