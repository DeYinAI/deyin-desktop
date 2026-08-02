import { useEffect, useState } from "react";

/** Blocks Chrome automation until the user grants consent. */
export function ChromeConsentDialog() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("Deyin will control your Chrome browser including logged-in sites.");

  useEffect(() => {
    return window.deyin.chrome.onConsentRequest((req) => {
      setMessage(req.message ?? message);
      setOpen(true);
    });
  }, [message]);

  if (!open) return null;

  return (
    <div className="goal-modal-backdrop" role="dialog" aria-modal="true" onClick={() => { window.deyin.chrome.respondConsent(false); setOpen(false); }}>
      <div
        className="goal-modal chrome-consent-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Chrome automation consent"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="goal-modal__title">Chrome automation</div>
        <p className="chrome-consent-modal__message">{message}</p>
        <div className="goal-modal__actions">
          <button type="button" className="chip chip--small" onClick={() => { window.deyin.chrome.respondConsent(false); setOpen(false); }}>
            Deny
          </button>
          <button
            type="button"
            className="chip chip--small chip--active"
            onClick={() => {
              window.deyin.chrome.respondConsent(true);
              setOpen(false);
            }}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
