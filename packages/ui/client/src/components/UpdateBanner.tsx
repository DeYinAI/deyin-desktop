import { useEffect, useState } from "react";
import type { UpdatesState } from "@deyin/contract";
import { useT } from "../i18n.js";
import { updateBannerMessage } from "../updateBannerMessage.js";
import { Icon } from "./Icon.js";

type UpdateBannerVariant = "sidebar" | "rail";

interface UpdateBannerProps {
  /** Sidebar footer pill (default) or collapsed nav-rail dot. */
  variant?: UpdateBannerVariant;
}

/**
 * Compact update notice — lives in the sidebar footer (Cursor-style), not a
 * full-width strip. available → download, progress, then restart to update.
 */
export function UpdateBanner({ variant = "sidebar" }: UpdateBannerProps) {
  const t = useT();
  const [state, setState] = useState<UpdatesState | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [errorDismissed, setErrorDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.deyin.updates.getState().then((s) => {
      if (!cancelled) setState(s);
    });
    const off = window.deyin.updates.onState((s) => {
      setState(s);
      if (s.status !== "error") setErrorDismissed(false);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  if (!state) return null;
  // Idle / checking / up-to-date / unsupported have nothing to show.
  const message = updateBannerMessage(state, t);
  if (message === null) return null;

  const version = state.availableVersion ?? "";
  if (state.status === "available" && version && dismissedVersion === version) return null;
  // Check failures are shown only in Settings → General; banner is for the download flow.
  if (state.status === "error" && !state.availableVersion) return null;
  if (state.status === "error" && errorDismissed) return null;

  const installing = state.status === "installing";

  if (variant === "rail") {
    return (
      <button
        type="button"
        className={installing ? "update-pill update-pill--rail update-pill--installing" : "update-pill update-pill--rail"}
        title={message}
        aria-label={message}
        onClick={() => {
          if (state.status === "downloaded") window.deyin.updates.install();
          else if (state.status === "available") void window.deyin.updates.download();
        }}
      >
        <Icon name="refresh" size={14} />
        <span className="update-pill__dot" aria-hidden />
      </button>
    );
  }

  const pillClass =
    state.status === "downloading"
      ? "update-pill update-pill--downloading"
      : installing
        ? "update-pill update-pill--installing"
        : state.status === "downloaded"
          ? "update-pill update-pill--ready"
          : "update-pill";

  return (
    <div className={pillClass} role="status">
      <div className="update-pill__head">
        <span className="update-pill__icon" aria-hidden>
          <Icon name="refresh" size={13} />
        </span>
        <span className="update-pill__text">{message}</span>
      </div>
      {state.status === "downloading" && (
        <div
          className="update-pill__progress"
          role="progressbar"
          aria-valuenow={state.progressPercent ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="update-pill__progress-bar"
            style={{ width: `${Math.min(100, Math.max(0, state.progressPercent ?? 0))}%` }}
          />
        </div>
      )}
      {installing && (
        // No aria-valuenow: an indeterminate progressbar, per ARIA.
        <div className="update-pill__progress update-pill__progress--indeterminate" role="progressbar" aria-label={message}>
          <div className="update-pill__progress-bar" />
        </div>
      )}
      <div className="update-pill__actions">
        {state.status === "available" && (
          <>
            <button
              type="button"
              className="update-pill__btn update-pill__btn--primary"
              onClick={() => void window.deyin.updates.download()}
            >
              {t("update.download")}
            </button>
            <button
              type="button"
              className="update-pill__btn update-pill__btn--ghost"
              onClick={() => setDismissedVersion(version || "pending")}
            >
              {t("update.later")}
            </button>
          </>
        )}
        {state.status === "downloaded" && (
          <button
            type="button"
            className="update-pill__btn update-pill__btn--primary"
            onClick={() => window.deyin.updates.install()}
          >
            {t("update.restart")}
          </button>
        )}
        {state.status === "error" && (
          <button
            type="button"
            className="update-pill__btn update-pill__btn--ghost"
            onClick={() => setErrorDismissed(true)}
          >
            {t("update.dismiss")}
          </button>
        )}
      </div>
    </div>
  );
}
