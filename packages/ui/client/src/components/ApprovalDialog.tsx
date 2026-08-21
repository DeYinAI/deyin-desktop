import { useEffect } from "react";
import { Icon } from "./Icon.js";

export type ApprovalDecision = "allow" | "allow-always" | "deny";

interface Props {
  toolName: string;
  summary: string;
  onDecision: (decision: ApprovalDecision) => void;
}

/** Permission prompt for agent tool calls in ask-first mode. */
export function ApprovalDialog({ toolName, summary, onDecision }: Props) {
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
        </div>
        <div className="inline-card__body inline-card__body--mono" title={summary}>
          {summary}
        </div>
      </div>
      <div className="inline-card__actions">
        <button className="btn btn--pill btn--ghost" onClick={() => onDecision("deny")}>
          Deny
        </button>
        <button className="btn btn--pill" onClick={() => onDecision("allow-always")}>
          Allow for session
        </button>
        <button className="btn btn--pill btn--solid" onClick={() => onDecision("allow")}>
          Allow once
        </button>
      </div>
    </div>
  );
}
