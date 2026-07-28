import type { AccountUsage } from "./types.js";
import type { TokenSource } from "./models.js";

interface MeResponse {
  usage?: {
    todayRequests?: number;
    weekRequests?: number;
    weekTokens?: number;
    totalRequests?: number;
    totalTokens?: number;
  };
  credits?: { balanceUsd?: number };
  plan?: { name?: string };
  limits?: {
    requestsPerWeek?: number | null;
    tokensPerWeek?: number | null;
    weeklyResetAt?: string | null;
  };
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
      requestsPerWeek: body.limits?.requestsPerWeek ?? null,
      tokensPerWeek: body.limits?.tokensPerWeek ?? null,
      weeklyResetAt: body.limits?.weeklyResetAt ?? null,
      creditsUsd: body.credits?.balanceUsd ?? null,
    };
  } catch {
    return null;
  }
}
