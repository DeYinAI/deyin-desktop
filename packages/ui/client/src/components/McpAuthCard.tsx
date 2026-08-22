import { useState } from "react";
import { Icon } from "./Icon.js";

export type McpAuthCardState = "needs-auth" | "authenticating" | "connected" | "failed";

interface Props {
  moduleId: string;
  serverName: string;
  message?: string;
  onSkip: () => void;
  onConnected?: (toolCount?: number) => void;
}

/** Inline OAuth sign-in card for MCP integrations (Cursor-style). */
export function McpAuthCard({ moduleId, serverName, message, onSkip, onConnected }: Props) {
  const [state, setState] = useState<McpAuthCardState>("needs-auth");
  const [statusText, setStatusText] = useState<string | null>(null);

  const authenticate = async () => {
    if (state === "authenticating") return;
    setState("authenticating");
    setStatusText(null);
    try {
      const result = await window.deyin.mcp.authenticate(moduleId);
      if (result.ok) {
        setState("connected");
        setStatusText(
          result.toolCount != null
            ? `Connected — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}. Send your message again to use them.`
            : "Connected. Send your message again to use its tools.",
        );
        onConnected?.(result.toolCount);
        window.setTimeout(() => onSkip(), 4000);
        return;
      }
      setState("failed");
      setStatusText(result.message || "Could not complete authorization.");
    } catch (err) {
      setState("failed");
      setStatusText(err instanceof Error ? err.message : String(err));
    }
  };

  const title =
    state === "authenticating"
      ? `Authenticating ${serverName}…`
      : state === "connected"
        ? `${serverName} connected`
        : state === "failed"
          ? `Could not connect ${serverName}`
          : `Connect ${serverName}`;

  return (
    <div className="inline-card mcp-auth-inline">
      <Icon name="plug" size={16} className="inline-card__icon" />
      <div className="inline-card__text">
        <div className="inline-card__title">{title}</div>
        <div className="inline-card__body">
          {statusText ??
            message ??
            "Enables the agent to use custom tools and third-party integrations."}
        </div>
      </div>
      <div className="inline-card__actions">
        {state !== "connected" && (
          <button className="btn btn--pill btn--ghost" disabled={state === "authenticating"} onClick={onSkip}>
            Skip
          </button>
        )}
        {state === "needs-auth" || state === "failed" ? (
          <button className="btn btn--pill btn--solid" onClick={() => void authenticate()}>
            {state === "failed" ? "Retry" : "Authenticate"}
          </button>
        ) : state === "authenticating" ? (
          <button className="btn btn--pill btn--solid" disabled>
            Authenticating…
          </button>
        ) : (
          <button className="btn btn--pill btn--ghost" onClick={onSkip}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
