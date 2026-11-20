import { useEffect, useState } from "react";
import { COMPUTER_USE_STOP_CHORD_LABEL, computerUsePhaseLabel, type ComputerUseState } from "@deyin/contract";

const IDLE: ComputerUseState = { phase: "idle" };

/**
 * Banner shown while computer-use tools are running, with Stop, and Resume after the user took over the
 * mouse or keyboard. The same state drives the click-through overlay the desktop draws over the screen.
 */
export function ComputerUseOverlay() {
  const [state, setState] = useState<ComputerUseState>(IDLE);

  // Desktop-only bridge; the web host leaves it undefined.
  useEffect(() => window.deyin.computerUse?.onState(setState), []);

  if (state.phase === "idle") return null;
  const bridge = window.deyin.computerUse;

  return (
    <div
      className={`activity-banner activity-banner--computer${state.phase === "paused" ? " activity-banner--paused" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span className="activity-banner__text">{computerUsePhaseLabel(state)}</span>
      {state.phase === "paused" && (
        <button type="button" className="activity-banner__btn" onClick={() => bridge?.resume()}>
          Resume
        </button>
      )}
      <button
        type="button"
        className="activity-banner__btn activity-banner__btn--stop"
        title={`Stop (${COMPUTER_USE_STOP_CHORD_LABEL})`}
        onClick={() => bridge?.stop()}
      >
        Stop
      </button>
    </div>
  );
}
