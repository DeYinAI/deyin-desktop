import { useEffect, useState } from "react";

interface AppApprovalRequest {
  requestId: string;
  appId: string;
  action: string;
}

/** First-use app approval for Computer Use plugin tools. */
export function AppApprovalDialog() {
  const [req, setReq] = useState<AppApprovalRequest | null>(null);

  useEffect(() => {
    // Desktop-only bridge; the web host leaves it undefined.
    return window.deyin.computerUse?.onAppApprovalRequest((r) => setReq(r));
  }, []);

  if (!req) return null;

  const close = (decision: "always" | "once" | "deny") => {
    window.deyin.computerUse?.respondAppApproval(req.requestId, decision);
    setReq(null);
  };

  const actionLabel = req.action === "launch" ? "launch" : "interact with";

  return (
    <div className="goal-modal-backdrop" role="dialog" aria-modal="true" onClick={() => close("deny")}>
      <div
        className="goal-modal app-approval-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Computer use app approval"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="goal-modal__title">Allow computer use?</div>
        <p className="app-approval-modal__message">
          Deyin wants to {actionLabel} <strong>{req.appId}</strong>. Choose how to allow it for this task.
        </p>
        <div className="goal-modal__actions">
          <button type="button" className="chip chip--small" onClick={() => close("deny")}>
            Deny
          </button>
          <button type="button" className="chip chip--small" onClick={() => close("once")}>
            Allow once
          </button>
          <button type="button" className="chip chip--small chip--active" onClick={() => close("always")}>
            Always allow
          </button>
        </div>
        <p className="app-approval-modal__hint">
          “Always allow” adds this app to the list in Settings → Computer Use. Press Esc at any time during automation to
          cancel.
        </p>
      </div>
    </div>
  );
}
