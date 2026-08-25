import { useEffect, useState } from "react";
import type { UpdatesState } from "@deyin/contract";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ""));
}

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
  if (state.status === "unsupported" || state.status === "idle" || state.status === "checking" || state.status === "not-available") {
    return null;
  }

  const version = state.availableVersion ?? "";
  if (state.status === "available" && version && dismissedVersion === version) return null;
  // Check failures are shown only in Settings → General; banner is for the download flow.
  if (state.status === "error" && !state.availableVersion) return null;
  if (state.status === "error" && errorDismissed) return null;

  const message =
    state.status === "available"
      ? fill(t("update.available"), { version })
      : state.status === "downloading"
        ? fill(t("update.downloading"), { version, percent: state.progressPercent ?? 0 })
        : state.status === "downloaded"
          ? fill(t("update.downloaded"), { version })
          : fill(t("update.error"), { message: state.error ?? "unknown" });

  if (variant === "rail") {
    const title =
      state.status === "downloaded"
        ? fill(t("update.downloaded"), { version })
        : state.status === "available"
          ? fill(t("update.available"), { version })
          : message;
    return (
      <button
        type="button"
        className="update-pill update-pill--rail"
        title={title}
        aria-label={title}
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

  return (
    <div className="update-pill" role="status">
      <div className="update-pill__head">
        <Icon name="refresh" size={12} />
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
