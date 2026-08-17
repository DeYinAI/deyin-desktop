import { useEffect, useState } from "react";
import type { UpdatesState } from "@deyin/contract";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ""));
}

/**
 * Cursor-style update strip: available → download (or auto), progress, then
 * Restart to update. Never force-installs without that confirm.
 */
export function UpdateBanner() {
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
  if (state.status === "error" && errorDismissed) return null;

  const message =
    state.status === "available"
      ? fill(t("update.available"), { version })
      : state.status === "downloading"
        ? fill(t("update.downloading"), { version, percent: state.progressPercent ?? 0 })
        : state.status === "downloaded"
          ? fill(t("update.downloaded"), { version })
          : fill(t("update.error"), { message: state.error ?? "unknown" });

  return (
    <div className="update-banner" role="status">
      <div className="update-banner__body">
        <Icon name="refresh" size={14} />
        <span className="update-banner__text">{message}</span>
        {state.status === "downloading" && (
          <div
            className="update-banner__progress"
            role="progressbar"
            aria-valuenow={state.progressPercent ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="update-banner__progress-bar"
              style={{ width: `${Math.min(100, Math.max(0, state.progressPercent ?? 0))}%` }}
            />
          </div>
        )}
      </div>
      <div className="update-banner__actions">
        {state.status === "available" && (
          <>
            <button
              type="button"
              className="btn btn--primary btn--small"
              onClick={() => void window.deyin.updates.download()}
            >
              {t("update.download")}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => setDismissedVersion(version || "pending")}
            >
              {t("update.later")}
            </button>
          </>
        )}
        {state.status === "downloaded" && (
          <button
            type="button"
            className="btn btn--primary btn--small"
            onClick={() => window.deyin.updates.install()}
          >
            {t("update.restart")}
          </button>
        )}
        {state.status === "error" && (
          <button
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => setErrorDismissed(true)}
          >
            {t("update.dismiss")}
          </button>
        )}
      </div>
    </div>
  );
}
