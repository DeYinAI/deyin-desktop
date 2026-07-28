import { useCallback, useEffect, useState } from "react";
import { Icon } from "../Icon.js";
import { PageHeader } from "./controls.js";
import type {
  DiagnosticsResult,
  IdentityInfo,
  IdentitySyncResult,
  ProviderInfo,
  UserProfile,
} from "../../../shared/types.js";

interface Props {
  user: UserProfile | null;
  /** In-app sign-in CTA for the signed-out state. */
  onConnect: () => void;
  /** Jump to the Usage stats page (Agent Runtime card). */
  onOpenUsage: () => void;
  /** Back to the workspace where the thread list lives (session history). */
  onShowThreads: () => void;
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

/** One label/value row of the identity grid. */
function Row(props: { label: string; value: string; muted?: boolean; badge?: string; title?: string }) {
  return (
    <div className="identity-grid__row" title={props.title}>
      <div className="identity-grid__label">{props.label}</div>
      <div className={`identity-grid__value ${props.muted ? "identity-grid__value--muted" : ""}`}>
        {props.value}
        {props.badge && <span className="badge badge--muted">{props.badge}</span>}
      </div>
    </div>
  );
}

/** Identity & Access: every value comes from the host's live IdentityService
 *  snapshot; nothing on this page is hardcoded. */
export function IdentityPage(props: Props) {
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<IdentitySyncResult | null>(null);
  const [sending, setSending] = useState(false);
  const [diagNote, setDiagNote] = useState("");
  const [diagResult, setDiagResult] = useState<DiagnosticsResult | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
    window.deyin.identity
      .get()
      .then((info) => {
        setIdentity(info);
        setLoadError(false);
      })
      .catch(() => setLoadError(true));
  }, []);

  useEffect(() => {
    reload();
    void window.deyin.providers.list().then(setProviders).catch(() => setProviders([]));
  }, [reload]);

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

  const sendDiagnostics = async () => {
    setSending(true);
    setDiagResult(null);
    try {
      setDiagResult(await window.deyin.diagnostics.send(diagNote));
    } finally {
      setSending(false);
    }
  };

  const copyFingerprint = (full: string) => {
    void navigator.clipboard.writeText(full).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  if (loadError) {
    return (
      <div className="settings-page settings-page--wide">
        <PageHeader title="Identity & Access" />
        <div className="usage-card">
          <div className="hint">Could not load identity information from the desktop host.</div>
        </div>
      </div>
    );
  }

  if (!identity) {
    return (
      <div className="settings-page settings-page--wide">
        <PageHeader title="Identity & Access" />
        <div className="hint">Loading…</div>
      </div>
    );
  }

  const server = identity.server;
  const notReported = "Not reported by server";
  const primary = providers.find((p) => p.kind === "primary") ?? providers[0] ?? null;
  const memberLabel = identity.member
    ? (identity.member.name ?? identity.member.email ?? identity.member.sub)
    : null;

  return (
    <div className="settings-page settings-page--wide">
      <PageHeader title="Identity & Access" description="Who you are, what this workstation is, and what gets shared with Openference.">
        {identity.member && <span className="badge badge--ok">Signed in</span>}
      </PageHeader>

      {/* Workspace identity ------------------------------------------------ */}
      <div className="usage-card">
        <div className="usage-card__title">Workspace Identity</div>
        <div className="identity-grid">
          <Row label="Tenant" value={server?.tenant ?? notReported} muted={!server?.tenant} />
          <Row label="Org" value={server?.org ?? notReported} muted={!server?.org} />
          <Row label="Workspace" value={identity.workspaceName ?? "Default (no folder open)"} muted={!identity.workspaceName} />
          <Row label="Member" value={memberLabel ?? "Not signed in"} muted={!memberLabel} />
          <Row label="Device" value={identity.device} />
          <Row
            label="Role"
            value={server?.role ?? notReported}
            muted={!server?.role}
            badge={identity.plan ?? undefined}
          />
          <Row
            label="Permissions"
            value={server && server.policies.length > 0 ? `${server.policies.length} policies` : notReported}
            muted={!server || server.policies.length === 0}
          />
          <Row label="Workspace fingerprint" value={identity.fingerprint} title={identity.fingerprintFull} />
          <Row label="Workstation" value={identity.device} badge={`v${identity.version}`} />
        </div>
        <div className="usage-card__foot identity-actions">
          <button className="chip chip--small" onClick={() => copyFingerprint(identity.fingerprintFull)}>
            <Icon name="copy" size={11} /> {copied ? "Copied" : "Copy full fingerprint"}
          </button>
        </div>
      </div>

      {/* DeyiD authentication ---------------------------------------------- */}
      <div className="usage-card">
        <div className="usage-card__title">
          Openference Authentication
          {identity.member ? <span className="badge badge--ok">Signed in</span> : <span className="badge badge--muted">Signed out</span>}
        </div>
        {identity.member ? (
          <>
            <div className="identity-grid">
              <Row label="Account" value={memberLabel ?? ""} badge={identity.member.email ?? undefined} />
              <Row label="Identity endpoint" value={identity.oauthIssuer} />
              <Row label="API endpoint" value={identity.apiBaseUrl} />
              <Row
                label="Last synced"
                value={identity.lastSyncedAt ? relativeTime(identity.lastSyncedAt) : "Never"}
                muted={!identity.lastSyncedAt}
                title={identity.lastSyncedAt ?? undefined}
              />
            </div>
            <div className="usage-card__foot identity-actions">
              <button className="chip chip--small" disabled={syncing} onClick={() => void syncNow()}>
                <Icon name="refresh" size={11} /> {syncing ? "Syncing…" : "Sync identity now"}
              </button>
              <span className="hint">Registers this workstation and workspace with your Openference account.</span>
              {syncResult && (
                <span className={syncResult.ok ? "hint--ok" : "hint--bad"}>
                  {syncResult.ok ? `Synced ${syncResult.syncedAt ? relativeTime(syncResult.syncedAt) : ""}` : (syncResult.message ?? "Sync failed")}
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="hint">Sign in with Openference to sync this workstation's identity and see your account role.</div>
            <button className="chip chip--small" style={{ marginTop: 8 }} onClick={props.onConnect}>
              Sign in
            </button>
          </>
        )}
      </div>

      {/* Agent runtime ------------------------------------------------------ */}
      <div className="usage-card">
        <div className="usage-card__title">Agent Runtime</div>
        <div className="identity-grid">
          <Row
            label="Provider"
            value={primary?.name ?? "No provider configured"}
            badge={primary ? (primary.status === "connected" ? "connected" : "not connected") : undefined}
            muted={!primary}
          />
          <Row
            label="Active model"
            value={primary?.models.find((m) => !primary.disabledModels.includes(m.id))?.id ?? "—"}
            muted={!primary || primary.models.length === 0}
          />
        </div>
        <div className="usage-card__foot identity-actions">
          <button className="chip chip--small" onClick={props.onOpenUsage}>
            <Icon name="chart" size={11} /> API Usage
          </button>
          <button className="chip chip--small" onClick={props.onShowThreads}>
            <Icon name="clock" size={11} /> Coding Session History
          </button>
          <button
            className="chip chip--small"
            onClick={() => window.deyin.shell.openExternal(`${identity.oauthIssuer.replace(/\/$/, "")}/settings/billing`)}
          >
            <Icon name="external" size={11} /> Top Ups
          </button>
        </div>
      </div>

      {/* Vault status -------------------------------------------------------- */}
      <div className="usage-card">
        <div className="usage-card__title">
          Vault Status
          <span className="badge badge--muted">Local only</span>
        </div>
        <div className="identity-grid">
          <Row
            label="Secrets stored locally"
            value={identity.localSecrets === 0 ? "None" : `${identity.localSecrets} ${identity.localSecrets === 1 ? "secret" : "secrets"}`}
            badge={identity.localSecrets > 0 ? "OS-encrypted" : undefined}
          />
          <Row label="Cloud vault sync" value="Not configured" muted />
        </div>
        <div className="hint usage-card__foot">
          Provider keys and plugin secrets stay on this workstation, encrypted by the OS keychain. Cloud vault sync
          will appear here once the Openference vault service is available.
        </div>
      </div>

      {/* Diagnostics ---------------------------------------------------------- */}
      <div className="usage-card">
        <div className="usage-card__title">Diagnostics</div>
        <div className="hint">
          Send a scrubbed snapshot (app log, environment, settings — never API keys, tokens or prompts) to Openference
          so support can investigate issues on this workstation.
        </div>
        <textarea
          className="identity-note"
          placeholder="Describe the problem (optional)"
          value={diagNote}
          rows={2}
          onChange={(e) => setDiagNote(e.target.value)}
        />
        <div className="usage-card__foot identity-actions">
          <button className="chip chip--small" disabled={sending || !identity.member} onClick={() => void sendDiagnostics()}>
            <Icon name="flag" size={11} /> {sending ? "Sending…" : "Send diagnostics to Openference"}
          </button>
          {!identity.member && <span className="hint">Sign in to send diagnostics.</span>}
          {diagResult?.ok && (
            <span className="hint--ok">Report sent — reference {diagResult.reportId}</span>
          )}
          {diagResult && !diagResult.ok && <span className="hint--bad">{diagResult.message ?? "Failed to send."}</span>}
        </div>
      </div>
    </div>
  );
}
