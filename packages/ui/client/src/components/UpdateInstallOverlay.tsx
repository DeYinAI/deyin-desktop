import { useEffect, useRef, useState } from "react";
import type { UpdatesState } from "@deyin/contract";
import { useT } from "../i18n.js";
import { fill } from "../updateBannerMessage.js";

/** Live updater state; null before the first read and on hosts without an updater. */
function useUpdatesState(): UpdatesState | null {
  const [state, setState] = useState<UpdatesState | null>(null);
  useEffect(() => {
    const updates = window.deyin?.updates;
    if (!updates) return;
    let cancelled = false;
    let pushed = false;
    void updates
      .getState()
      .then((initial) => {
        // A pushed state is newer than the initial read; never overwrite it.
        if (!cancelled && !pushed) setState(initial);
      })
      .catch(() => undefined);
    const off = updates.onState((next) => {
      pushed = true;
      setState(next);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return state;
}

/**
 * Small "installing" card, shown from the moment "Restart to update" is clicked
 * until the app quits for the installer. Without it the window simply vanished and
 * the update looked like a crash. It is deliberately small: the app has to exit
 * before the installer can replace its files, so the progress after that comes from
 * the installer's own window and this only covers the hand-off. Mounted once in
 * AppProviders so it sits above every view root.
 */
export function UpdateInstallOverlay() {
  const t = useT();
  const state = useUpdatesState();
  const cardRef = useRef<HTMLDivElement>(null);
  const installing = state?.status === "installing";

  // Take focus off whatever was active (e.g. the composer) so nothing can be typed mid-hand-off.
  useEffect(() => {
    if (installing) cardRef.current?.focus();
  }, [installing]);

  if (!state || state.status !== "installing") return null;

  const title = fill(t("update.installing"), { version: state.availableVersion ?? "" });

  return (
    // Invisible full-viewport shield: swallows input so nothing behind the card can be used
    // mid-hand-off, and keeps clicks from moving focus out of the dialog.
    <div className="update-install" role="presentation" onMouseDown={(e) => e.preventDefault()}>
      <div
        ref={cardRef}
        className="update-install__card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="update-install-title"
        aria-describedby="update-install-hint"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Tab") e.preventDefault();
        }}
      >
        <span className="update-install__spinner" aria-hidden />
        <div className="update-install__text">
          <h2 id="update-install-title" className="update-install__title">
            {title}
          </h2>
          <p id="update-install-hint" className="update-install__hint">
            {t("update.installingHint")}
          </p>
        </div>
        {/* No aria-valuenow: an indeterminate progressbar, per ARIA. */}
        <div
          className="update-pill__progress update-pill__progress--indeterminate"
          role="progressbar"
          aria-labelledby="update-install-title"
        >
          <div className="update-pill__progress-bar" />
        </div>
      </div>
    </div>
  );
}
