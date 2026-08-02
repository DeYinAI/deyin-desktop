import { useEffect, useState } from "react";

/** Banner shown while computer-use tools are active; Esc cancels via main-process shortcut. */
export function ComputerUseOverlay() {
  const [active, setActive] = useState(false);

  useEffect(() => window.deyin.computerUse.onActive(setActive), []);

  if (!active) return null;

  return (
    <div className="computer-use-overlay" role="status" aria-live="polite">
      <span className="computer-use-overlay__text">Deyin is using your computer</span>
      <span className="computer-use-overlay__hint">Press Esc to cancel</span>
    </div>
  );
}
