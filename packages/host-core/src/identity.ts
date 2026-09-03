import type { DiagnosticsPayload, DiagnosticsResult } from "./types.js";
import type { TokenSource } from "./models.js";
import { deyinUserAgent } from "./user-agent.js";

/** Body of POST {issuer}/api/identity/sync: registers/updates this device for
 *  the signed-in account. Pseudonymous — the fingerprint is a hash, never a
 *  path or machine id. */
export interface IdentitySyncBody {
  fingerprint: string;
  hostname: string;
  platform: string;
  arch: string;
  appVersion: string;
  workspaceName: string | null;
}

/**
 * Push this workstation's identity to Openference. Returns the ISO timestamp to
 * persist locally on success; throws nothing — failures come back as `null`.
 */
export async function syncWorkspaceIdentity(
  opts: { oauthIssuer: string },
  getToken: TokenSource,
  body: IdentitySyncBody,
): Promise<string | null> {
  const token = await getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${opts.oauthIssuer.replace(/\/$/, "")}/api/identity/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "user-agent": deyinUserAgent() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const parsed = (await res.json().catch(() => ({}))) as { syncedAt?: unknown };
    return typeof parsed.syncedAt === "string" ? parsed.syncedAt : new Date().toISOString();
  } catch {
    return null;
  }
}

/**
 * Upload a diagnostics bundle to Openference so support can investigate issues.
 * The payload is built (and scrubbed) by the host; the server echoes a report id
 * the user can reference in a ticket.
 */
export async function sendDiagnosticsReport(
  opts: { oauthIssuer: string },
  getToken: TokenSource,
  payload: DiagnosticsPayload,
): Promise<DiagnosticsResult> {
  const token = await getToken();
  if (!token) return { ok: false, message: "Not signed in." };
  try {
    const res = await fetch(`${opts.oauthIssuer.replace(/\/$/, "")}/api/diagnostics`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "user-agent": deyinUserAgent() },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const parsed = (await res.json().catch(() => ({}))) as { reportId?: unknown };
    return {
      ok: true,
      reportId: typeof parsed.reportId === "string" ? parsed.reportId : payload.reportId,
      sentAt: new Date().toISOString(),
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
