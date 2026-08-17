import { Logo } from "./Logo.js";

interface WelcomeProps {
  busy: boolean;
  connecting: boolean;
  onConnect: () => void;
  onUseApiKey: () => void;
}

/** First-run sign-in screen shown while signed out (ZCode-style centered card). */
export function Welcome({ busy, connecting, onConnect, onUseApiKey }: WelcomeProps) {
  return (
    <div className="welcome">
      <div className="welcome__card">
        <span className="welcome__logo">
          <Logo size={44} />
        </span>
        <h1 className="welcome__title">Welcome to Deyin</h1>
        <p className="welcome__subtitle">Connect your account to start using Deyin</p>

        <button className="welcome__btn welcome__btn--primary" disabled={busy} onClick={onConnect}>
          <Logo size={16} />
          <span>{connecting ? "Waiting for browser…" : "Connect with Openference"}</span>
        </button>
        <button className="welcome__btn" disabled={busy} onClick={onUseApiKey}>
          Use API key
        </button>

        {connecting && (
          <p className="welcome__hint">
            Finish signing in in your browser. This window updates automatically.
          </p>
        )}
      </div>
    </div>
  );
}
