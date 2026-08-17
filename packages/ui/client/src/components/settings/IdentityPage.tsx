import { useCallback, useEffect, useState } from "react";
import { Icon } from "../Icon.js";
import { PageHeader } from "./controls.js";
import type { IdentityInfo, IdentitySyncResult, UserProfile } from "@deyin/contract";

interface Props {
  user: UserProfile | null;
  /** In-app sign-in CTA for the signed-out state. */
  onConnect: () => void;
  /** Jump to the Usage stats page. */
  onOpenUsage: () => void;
}

/** "a few seconds ago"-style age label for ISO timestamps. */
function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return "a few seconds ago";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Account page: only the Openference account — profile, sync status and billing links. */
export function IdentityPage(props: Props) {
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<IdentitySyncResult | null>(null);

  const reload = useCallback(() => {
    window.deyin.identity
      .get()
      .then((info) => {
        setIdentity(info);
        setLoadError(false);
      })
      .catch(() => setLoadError(true));
  }, []);

  useEffect(() => reload(), [reload]);

  const syncNow = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await window.deyin.identity.sync();
      setSyncResult(result);
      if (result.ok) reload();
    } finally {
      setSyncing(false);
    }
  };

  if (loadError) {
    return (
      <div className="settings-page">
        <PageHeader title="Account" />
        <div className="usage-card">
          <div className="hint">Could not load account information from the host.</div>
        </div>
      </div>
    );
  }

  // Prefer the live profile; fall back to the identity snapshot while it loads.
  const member = identity?.member;
  const name = props.user?.name ?? member?.name ?? member?.email ?? member?.sub ?? null;
  const email = props.user?.email ?? member?.email ?? null;
  const plan = props.user?.plan ?? identity?.plan ?? null;
  const signedIn = props.user !== null || member != null;

  return (
    <div className="settings-page">
      <PageHeader
        title="Account"
        description="Your Openference account, plan and workstation sync."
      >
        {signedIn ? (
          <span className="badge badge--ok">Signed in</span>
        ) : (
          <span className="badge badge--muted">Signed out</span>
        )}
      </PageHeader>

      <div className="usage-card">
        <div className="account-head">
          {signedIn ? (
            props.user?.picture ? (
              <img className="account-head__avatar" src={props.user.picture} alt="" />
            ) : (
              <div className="account-head__avatar account-head__avatar--fallback">
                {(name ?? "?").slice(0, 1).toUpperCase()}
              </div>
            )
          ) : (
            <div className="account-head__avatar account-head__avatar--fallback">
              <Icon name="user" size={18} />
            </div>
          )}
          <div className="account-head__meta">
            <div className="account-head__name">{signedIn ? (name ?? "Openference member") : "Not signed in"}</div>
            <div className="account-head__sub">
              {signedIn ? (email ?? member?.sub ?? "—") : "Sign in to sync models and usage with Openference."}
            </div>
          </div>
          {signedIn && plan && <span className="badge badge--muted">{plan}</span>}
        </div>

        {signedIn ? (
          <>
            <div className="identity-grid">
              <Row label="Account" value={email ?? member?.sub ?? ""} />
              <Row label="Plan" value={plan ?? "Free"} />
              <Row
                label="Last synced"
                value={identity?.lastSyncedAt ? relativeTime(identity.lastSyncedAt) : "Never"}
                muted={!identity?.lastSyncedAt}
                title={identity?.lastSyncedAt ?? undefined}
              />
            </div>
            <div className="usage-card__foot identity-actions">
              <button className="chip chip--small" disabled={syncing} onClick={() => void syncNow()}>
                <Icon name="refresh" size={11} /> {syncing ? "Syncing…" : "Sync now"}
              </button>
              <button className="chip chip--small" onClick={props.onOpenUsage}>
                <Icon name="chart" size={11} /> API usage
              </button>
              {identity?.oauthIssuer && (
                <button
                  className="chip chip--small"
                  onClick={() =>
                    window.deyin.shell.openExternal(`${identity.oauthIssuer.replace(/\/$/, "")}/settings/billing`)
                  }
                >
                  <Icon name="external" size={11} /> Top ups
                </button>
              )}
              {syncResult && (
                <span className={syncResult.ok ? "hint--ok" : "hint--bad"}>
                  {syncResult.ok
                    ? `Synced ${syncResult.syncedAt ? relativeTime(syncResult.syncedAt) : ""}`
                    : (syncResult.message ?? "Sync failed")}
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="usage-card__foot identity-actions">
            <button className="btn btn--outline" onClick={props.onConnect}>
              Sign in with Openference
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** One label/value row of the account grid. */
function Row(props: { label: string; value: string; muted?: boolean; title?: string }) {
  return (
    <div className="identity-grid__row" title={props.title}>
      <div className="identity-grid__label">{props.label}</div>
      <div className={`identity-grid__value ${props.muted ? "identity-grid__value--muted" : ""}`}>
        {props.value}
      </div>
    </div>
  );
}
