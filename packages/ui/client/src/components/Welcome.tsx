import type { ReactNode } from "react";
import { Logo } from "./Logo.js";

interface WelcomeProps {
  busy: boolean;
  connecting: boolean;
  connectError?: string | null;
  onConnect: () => void;
  onUseApiKey?: () => void;
  footerHint?: ReactNode;
}

/** First-run sign-in screen shown while signed out (centered card). */
export function Welcome({ busy, connecting, connectError, onConnect, onUseApiKey, footerHint }: WelcomeProps) {
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
        {onUseApiKey ? (
          <button className="welcome__btn" disabled={busy} onClick={onUseApiKey}>
            Use API key
          </button>
        ) : null}

        {connecting && (
          <p className="welcome__hint">
            Finish signing in in your browser. This window updates automatically.
          </p>
        )}
        {connectError ? <p className="welcome__hint welcome__hint--error">{connectError}</p> : null}
        {footerHint ? <p className="welcome__hint">{footerHint}</p> : null}
      </div>
    </div>
  );
}
