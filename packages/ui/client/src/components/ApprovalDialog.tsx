import { useEffect } from "react";
import { Icon } from "./Icon.js";

export type ApprovalDecision = "allow" | "allow-always" | "deny";

interface Props {
  toolName: string;
  summary: string;
  /** Why a person is being asked, when the host knows (a Bot's rules decide what needs a yes). */
  reason?: string;
  /** "Always allow" is kept from now on, not only for this conversation. */
  saved?: boolean;
  /** How many requests are waiting, including this one (parallel tool calls). */
  pendingCount?: number;
  onDecision: (decision: ApprovalDecision) => void;
}

/** Permission prompt for agent tool calls in ask-first mode. */
export function ApprovalDialog({ toolName, summary, reason, saved = false, pendingCount = 1, onDecision }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never hijack keys while the user is typing (composer / inputs).
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.key === "Escape") onDecision("deny");
      if (e.key === "Enter") onDecision("allow");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDecision]);

  return (
    <div className="inline-card approval-inline">
      <Icon name="hand" size={16} className="inline-card__icon" />
      <div className="inline-card__text">
        <div className="inline-card__title">
          Allow <code>{toolName}</code>?
          {pendingCount > 1 && <span className="inline-card__count"> · {pendingCount - 1} more waiting</span>}
        </div>
        <div className="inline-card__body inline-card__body--mono" title={summary}>
          {summary}
        </div>
        {reason && <div className="inline-card__body approval-inline__reason">{reason}</div>}
      </div>
      <div className="inline-card__actions">
        <button className="btn btn--pill btn--ghost" onClick={() => onDecision("deny")}>
          Deny
        </button>
        <button className="btn btn--pill" onClick={() => onDecision("allow-always")}>
          {saved ? "Always allow" : "Allow for session"}
        </button>
        <button className="btn btn--pill btn--solid" onClick={() => onDecision("allow")}>
          Allow once
        </button>
      </div>
    </div>
  );
}
