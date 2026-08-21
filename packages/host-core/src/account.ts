import type { AccountUsage, ServerIdentity } from "./types.js";
import type { TokenSource } from "./models.js";

interface MeResponse {
  usage?: {
    todayRequests?: number;
    weekRequests?: number;
    weekTokens?: number;
    windowRequests?: number;
    weekQuotaUsed?: number;
    windowQuotaUsed?: number;
    totalRequests?: number;
    totalTokens?: number;
  };
  credits?: { balanceUsd?: number };
  plan?: { name?: string; requestsPerWindow?: number | null; windowHours?: number | null };
  limits?: {
    requestsPerWeek?: number | null;
    tokensPerWeek?: number | null;
    /** { requests, hours } for the rolling window; null when the plan has none. */
    windowLimit?: { requests?: number; hours?: number } | null;
    /** Epoch milliseconds on the wire, despite the ISO-ish name. */
    weeklyResetAt?: number | string | null;
    windowResetAt?: number | string | null;
  };
  identity?: {
    tenant?: string | null;
    org?: string | null;
    role?: string | null;
    policies?: unknown;
  };
}

/** The reset timestamps arrive as epoch milliseconds; normalize to the ISO
 *  string the AccountUsage contract advertises so callers can trust the type. */
function toIso(raw: number | string | null | undefined): string | null {
  if (raw == null) return null;
  const ms = typeof raw === "number" ? raw : Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Parse the optional identity block; absent or malformed means "not reported". */
export function parseServerIdentity(raw: MeResponse["identity"]): ServerIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const policies = Array.isArray(raw.policies) ? raw.policies.filter((p): p is string => typeof p === "string") : [];
  const identity = { tenant: str(raw.tenant), org: str(raw.org), role: str(raw.role), policies };
  // An entirely empty block carries no information; treat it as not reported.
  return identity.tenant || identity.org || identity.role || policies.length > 0 ? identity : null;
}

/**
 * Fetch the signed-in account's server-side usage summary from Openference.
 * The OAuth access token (scope model:invoke) authenticates the request.
 * Returns null when signed out or the endpoint is unreachable — the UI hides
 * the account section in that case.
 */
export async function fetchAccountUsage(
  opts: { oauthIssuer: string },
  getToken: TokenSource,
): Promise<AccountUsage | null> {
  const token = await getToken();
  if (!token) return null;

  try {
    const res = await fetch(`${opts.oauthIssuer.replace(/\/$/, "")}/api/user/me`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as MeResponse;
    return {
      planName: body.plan?.name ?? null,
      todayRequests: body.usage?.todayRequests ?? 0,
      weekRequests: body.usage?.weekRequests ?? 0,
      weekTokens: body.usage?.weekTokens ?? 0,
      totalRequests: body.usage?.totalRequests ?? 0,
      totalTokens: body.usage?.totalTokens ?? 0,
      windowRequests: body.usage?.windowRequests ?? 0,
      // Servers predating the quota-used split report only the raw counts;
      // falling back to those keeps the meters populated (if slightly low).
      weekQuotaUsed: body.usage?.weekQuotaUsed ?? body.usage?.weekRequests ?? 0,
      windowQuotaUsed: body.usage?.windowQuotaUsed ?? body.usage?.windowRequests ?? 0,
      requestsPerWeek: body.limits?.requestsPerWeek ?? null,
      tokensPerWeek: body.limits?.tokensPerWeek ?? null,
      // The enforced window limit lives under limits.windowLimit; plan.* carries
      // the same pair as plan metadata and serves as the fallback.
      requestsPerWindow:
        body.limits?.windowLimit?.requests ?? body.plan?.requestsPerWindow ?? null,
      windowHours: body.limits?.windowLimit?.hours ?? body.plan?.windowHours ?? null,
      weeklyResetAt: toIso(body.limits?.weeklyResetAt),
      windowResetAt: toIso(body.limits?.windowResetAt),
      creditsUsd: body.credits?.balanceUsd ?? null,
      identity: parseServerIdentity(body.identity),
    };
  } catch {
    return null;
  }
}
