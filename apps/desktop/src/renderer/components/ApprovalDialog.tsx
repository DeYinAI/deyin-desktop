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
      if (e.key === "Escape") onDecision("deny");
      if (e.key === "Enter") onDecision("allow");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDecision]);

  return (
    <div className="approval" role="dialog" aria-modal="true">
      <div className="approval__box">
        <div className="approval__title">
          <Icon name="hand" size={15} />
          Allow <code>{toolName}</code>?
        </div>
        <div className="approval__summary">{summary}</div>
        <div className="approval__actions">
          <button className="btn btn--outline" onClick={() => onDecision("deny")}>
            Deny
          </button>
          <button className="btn btn--outline" onClick={() => onDecision("allow-always")}>
            Allow for session
          </button>
          <button className="btn" onClick={() => onDecision("allow")}>
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
}
