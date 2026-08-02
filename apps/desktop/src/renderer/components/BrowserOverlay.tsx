import { useEffect, useState } from "react";

/** Banner shown while browser_* agent tools are active. */
export function BrowserOverlay() {
  const [active, setActive] = useState(false);

  useEffect(() => window.deyin.browserControl.onActive(setActive), []);

  if (!active) return null;

  return (
    <div className="browser-overlay" role="status" aria-live="polite">
      <span className="browser-overlay__text">Deyin is using the browser</span>
    </div>
  );
}
