import { useEffect, useState } from "react";
import type { ChromeBridgeStatus } from "@deyin/contract";
import { connectionHeadline, groupCode } from "../../chromeStatus.js";
import { SettingCard } from "./controls.js";

type ChromeApi = NonNullable<typeof window.deyin.chrome>;

interface Props {
  api: ChromeApi;
  status: ChromeBridgeStatus;
}

/** Re-render once a second while `active`, for the pairing countdown. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function ChromeConnectionCard({ api, status }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pairing = status.connection === "pairing";
  const now = useNow(pairing && status.pairingOpenUntil !== null);
  const secondsLeft = status.pairingOpenUntil === null ? null : Math.max(0, Math.ceil((status.pairingOpenUntil - now) / 1000));
  const head = connectionHeadline(status);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingCard
        title="Connection"
        description={
          <>
            <span>{head.text}</span>
            {head.detail && <span className="hint hint--bad"> {head.detail}</span>}
          </>
        }
      >
        <div className="chrome-actions">
          {status.connection === "connected" && !status.stopped && (
            <button type="button" className="btn btn--danger btn--small" disabled={busy} onClick={() => void run(() => api.stop())}>
              Stop
            </button>
          )}
          {status.stopped && (
            <button type="button" className="btn btn--small" disabled={busy} onClick={() => void run(() => api.resume())}>
              Resume
            </button>
          )}
          {pairing ? (
            <button type="button" className="btn btn--outline btn--small" disabled={busy} onClick={() => void run(() => api.cancelPairing())}>
              Cancel pairing
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--small"
              disabled={busy || !status.listening}
              onClick={() => void run(() => api.beginPairing())}
            >
              {status.pairedBrowsers.length > 0 ? "Pair another browser" : "Pair Chrome"}
            </button>
          )}
        </div>
      </SettingCard>

      {pairing && status.pairingCode && (
        <div className="chrome-pair" role="status" aria-live="polite">
          <div className="chrome-pair__code" aria-label={`Pairing code ${status.pairingCode.split("").join(" ")}`}>
            {groupCode(status.pairingCode)}
          </div>
          <p className="hint">
            Click <strong>Allow</strong> in the extension popup only if it shows this same code.
            {secondsLeft !== null && ` This window closes in ${secondsLeft}s.`}
          </p>
        </div>
      )}

      {error && <p className="hint hint--bad">{error}</p>}

      {status.pairedBrowsers.length > 0 && (
        <SettingCard title="Paired browsers" description="Forgetting a browser means it has to be paired again.">
          <div className="chrome-paired">
            {status.pairedBrowsers.map((b) => (
              <div key={b.browserId} className="chrome-paired__row">
                <span>{b.label}</span>
                <button
                  type="button"
                  className="btn btn--small btn--outline"
                  disabled={busy}
                  onClick={() => void run(() => api.forgetBrowser(b.browserId))}
                  aria-label={`Forget ${b.label}`}
                >
                  Forget
                </button>
              </div>
            ))}
          </div>
        </SettingCard>
      )}
    </>
  );
}
