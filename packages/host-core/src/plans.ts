/** Public Openference pricing catalog (GET {issuer}/api/public/plans). */

export interface LocalizedPrice {
  amount: number;
  currency: string;
}

export interface PublicPlan {
  id: number;
  name: string;
  priceMonthly: number;
  localizedPrice: LocalizedPrice;
  maxRpm: number;
  requestsPerWeek: number | null;
  requestsPerWindow: number | null;
  windowHours: number | null;
  tokensPerWeek: number | null;
  features: string | null;
  tagline: string | null;
  isPopular: boolean;
  planKind: "normal" | "agent";
  hasStripe: boolean;
 /** Server-reported availability; the API omits this today, so absent = available. */
 isSoldOut: boolean;
}

interface PlansApiPlan {
  id: number;
  name: string;
  priceMonthly: number;
  localizedPrice?: { amount?: number; currency?: string };
  maxRpm?: number;
  requestsPerWeek?: number | null;
  requestsPerWindow?: number | null;
  windowHours?: number | null;
  tokensPerWeek?: number | null;
  features?: string | null;
  tagline?: string | null;
  isPopular?: boolean;
  planKind?: string;
  hasStripe?: boolean;
 /** Forward-compat: server may mark plans sold out; absent means available. */
 isSoldOut?: boolean;
}

interface PlansApiResponse {
  plans?: PlansApiPlan[];
}

function normalizePlan(raw: PlansApiPlan): PublicPlan {
  const amount = raw.localizedPrice?.amount ?? raw.priceMonthly;
  const currency = raw.localizedPrice?.currency ?? "usd";
  return {
    id: raw.id,
    name: raw.name,
    priceMonthly: raw.priceMonthly,
    localizedPrice: { amount, currency },
    maxRpm: raw.maxRpm ?? 0,
    requestsPerWeek: raw.requestsPerWeek ?? null,
    requestsPerWindow: raw.requestsPerWindow ?? null,
    windowHours: raw.windowHours ?? null,
    tokensPerWeek: raw.tokensPerWeek ?? null,
    features: raw.features ?? null,
    tagline: raw.tagline ?? null,
    isPopular: raw.isPopular ?? false,
    planKind: raw.planKind === "agent" ? "agent" : "normal",
    hasStripe: raw.hasStripe ?? false,
   isSoldOut: raw.isSoldOut === true,
 };
}

/**
 * Fetch the public plan catalog from Openference. No auth required; the
 * endpoint is edge-cached. Returns null when unreachable.
 *
 * Pass `apiBase` (e.g. `${location.origin}/api`) in browser builds so the
 * request goes through the web host-server proxy and avoids cross-origin CORS.
 */
export async function fetchPublicPlans(opts: {
  oauthIssuer: string;
  apiBase?: string;
}): Promise<PublicPlan[] | null> {
  try {
    const apiBase = opts.apiBase?.replace(/\/$/, "");
    const url = apiBase
      ? `${apiBase}/public/plans`
      : `${opts.oauthIssuer.replace(/\/$/, "")}/api/public/plans`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as PlansApiResponse;
    if (!Array.isArray(body.plans)) return null;
    return body.plans.map(normalizePlan);
  } catch {
    return null;
  }
}

/** Format a localized monthly price for display. */
export function formatPlanPrice(plan: PublicPlan): string {
  const { amount, currency } = plan.localizedPrice;
  if (amount === 0) return "Free";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

/** Compact number formatter for quota lines (7.5k, 1.2M). */
export function formatQuota(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
