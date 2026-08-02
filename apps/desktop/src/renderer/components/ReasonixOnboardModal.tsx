import type { DeyinSettings } from "../../shared/types.js";

interface Props {
  settings: DeyinSettings;
  onComplete: () => void;
  onSkip: () => void;
}

/** First-time onboarding for coordinator and fleet features. */
export function ReasonixOnboardModal({ settings, onComplete, onSkip }: Props) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="reasonix-onboard-title">
      <div className="modal reasonix-onboard-modal">
        <h2 id="reasonix-onboard-title">Reasonix features</h2>
        <p>
          Deyin 2.0 integrates production patterns from DeepSeek-Reasonix. Here is how to get started safely during
          beta:
        </p>
        <ol className="reasonix-onboard-modal__steps">
          <li>
            <strong>Prefix cache</strong> is on by default — watch hit rate in the status bar (green ≥80%).
          </li>
          <li>
            Enable <strong>Coordinator</strong> in Settings when you want a planner model for complex refactors.
          </li>
          <li>
            Enable <strong>Fleet</strong> when running parallel subagents — always declare non-overlapping{" "}
            <code>write_paths</code>.
          </li>
          <li>
            Enable <strong>Delivery mode</strong> when shipping production code that needs verification sign-offs.
          </li>
        </ol>
        <p className="hint">
          Current flags: cache={settings.enableCacheOptimizations ? "on" : "off"}, coordinator=
          {settings.enableCoordinator ? "on" : "off"}, fleet={settings.enableFleet ? "on" : "off"}, delivery=
          {settings.enableDeliveryMode ? "on" : "off"}
        </p>
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onSkip}>
            Skip
          </button>
          <button type="button" className="btn btn--primary" onClick={onComplete}>
            Open Reasonix settings
          </button>
        </div>
      </div>
    </div>
  );
}
