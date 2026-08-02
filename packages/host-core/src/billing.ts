/** Openference billing API. */

import type { TokenSource } from "./models.js";
import type { BillingCycle, PendingPlanChange } from "./billing-plan.js";

export type { BillingCycle, PendingPlanChange };
export {
  buildPlanCardPresentation,
  estimateProratedCharge,
  estimateRefund,
  formatBillingDate,
  hasActiveSubscription,
  isCrossCurrencyChange,
  isPlanDowngrade,
  pendingPlanSwitchForCard,
  pendingSwitchOnCurrentPlanCard,
  resolveCurrentPlanCard,
  scheduledCancellationForPlanCard,
  type PlanCardCtaKey,
} from "./billing-plan.js";

export interface SelectPlanOptions {
  returnTo?: string;
  billingCycle?: BillingCycle;
  changeNow?: boolean;
}

export interface SelectPlanResponse {
  success?: boolean;
  url?: string;
  redirect?: string;
  error?: string;
  detail?: string;
  fallback?: string;
  requires_action?: boolean;
  client_secret?: string;
  new_subscription_id?: string;
  fallback_to_scheduled?: boolean;
  message?: string;
}

export interface BillingOverview {
  planId: number | null;
  planName: string | null;
  planPriceMonthly: number | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  subscriptionBillingCycle: BillingCycle | null;
  nextBillingDate: string | null;
  cancelAtPeriodEnd: boolean;
  pendingPlanChange: PendingPlanChange | null;
  subscriptionCurrency: string | null;
  currentPeriodStart: string | null;
  latestInvoiceAmountPaid: number | null;
  latestInvoiceCurrency: string | null;
}

export interface UserMeBilling {
  planId: number | null;
  planName: string | null;
  planPriceMonthly: number | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
}

export type Upgrade3dsResult = { ok: true; redirect?: string } | { ok: false; error: string };

export class SelectPlanError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: string,
    readonly fallback?: string,
  ) {
    super(message);
    this.name = "SelectPlanError";
  }
}

interface OverviewApiResponse {
  plan?: { name?: string; priceMonthly?: number };
  subscriptionStatus?: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionBillingCycle?: BillingCycle | null;
  nextBillingDate?: string | null;
  cancelAtPeriodEnd?: boolean;
  pendingPlanChange?: PendingPlanChange | null;
  subscriptionCurrency?: string | null;
  currentPeriodStart?: string | null;
  latestInvoiceAmountPaid?: number | null;
  latestInvoiceCurrency?: string | null;
}

interface MeApiResponse {
  planId?: number | null;
  plan?: { name?: string; priceMonthly?: number };
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: string | null;
}

function mapSelectPlanError(status: number, data: { error?: string; detail?: string }): string {
  const msg = data.error || data.detail;
  if (status === 503) return msg || "Billing is not configured.";
  if (status === 502) return msg || "Payment setup failed.";
  return msg || "Plan selection failed.";
}

async function authFetch(
  oauthIssuer: string,
  getToken: TokenSource,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const token = await getToken();
  if (!token) throw new SelectPlanError("Sign in to manage billing.");
  return fetch(`${oauthIssuer.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
}

async function parseSelectPlanResponse(res: Response): Promise<SelectPlanResponse & { detail?: string; fallback?: string }> {
  const text = await res.text();
  if (!text.trim()) throw new SelectPlanError(`Empty response (HTTP ${res.status})`, res.status);
  try {
    return JSON.parse(text) as SelectPlanResponse & { detail?: string; fallback?: string };
  } catch {
    const snippet = text.trim().slice(0, 120);
    if (/^your worker/i.test(snippet)) {
      throw new SelectPlanError("Server is restarting. Try again in a moment.", res.status);
    }
    throw new SelectPlanError(snippet || `Request failed (HTTP ${res.status})`, res.status);
  }
}

export async function fetchUserMeBilling(
  opts: { oauthIssuer: string },
  getToken: TokenSource,
): Promise<UserMeBilling | null> {
  try {
    const res = await authFetch(opts.oauthIssuer, getToken, "/api/user/me");
    if (!res.ok) return null;
    const body = (await res.json()) as MeApiResponse;
    return {
      planId: body.planId ?? null,
      planName: body.plan?.name ?? null,
      planPriceMonthly: body.plan?.priceMonthly ?? null,
      stripeSubscriptionId: body.stripeSubscriptionId ?? null,
      subscriptionStatus: body.subscriptionStatus ?? null,
    };
  } catch {
    return null;
  }
}

export async function fetchBillingOverview(
  opts: { oauthIssuer: string },
  getToken: TokenSource,
): Promise<BillingOverview | null> {
  try {
    const [overviewRes, me] = await Promise.all([
      authFetch(opts.oauthIssuer, getToken, "/api/user/billing/overview"),
      fetchUserMeBilling(opts, getToken),
    ]);
    if (!overviewRes.ok) return null;
    const body = (await overviewRes.json()) as OverviewApiResponse;
    return {
      planId: me?.planId ?? null,
      planName: body.plan?.name ?? me?.planName ?? null,
      planPriceMonthly: body.plan?.priceMonthly ?? me?.planPriceMonthly ?? null,
      stripeSubscriptionId: body.stripeSubscriptionId ?? me?.stripeSubscriptionId ?? null,
      subscriptionStatus: body.subscriptionStatus ?? me?.subscriptionStatus ?? null,
      subscriptionBillingCycle: body.subscriptionBillingCycle ?? null,
      nextBillingDate: body.nextBillingDate ?? null,
      cancelAtPeriodEnd: !!body.cancelAtPeriodEnd,
      pendingPlanChange: body.pendingPlanChange ?? null,
      subscriptionCurrency: body.subscriptionCurrency ?? null,
      currentPeriodStart: body.currentPeriodStart ?? null,
      latestInvoiceAmountPaid: body.latestInvoiceAmountPaid ?? null,
      latestInvoiceCurrency: body.latestInvoiceCurrency ?? null,
    };
  } catch {
    return null;
  }
}

export async function selectPlan(
  opts: { oauthIssuer: string },
  getToken: TokenSource,
  planId: number,
  options?: SelectPlanOptions,
): Promise<SelectPlanResponse> {
  const res = await authFetch(opts.oauthIssuer, getToken, "/api/billing/select-plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      plan_id: planId,
      billing_cycle: options?.billingCycle ?? "monthly",
      return_to: options?.returnTo,
      change_now: options?.changeNow,
    }),
  });

  const data = await parseSelectPlanResponse(res);
  if (!res.ok) {
    throw new SelectPlanError(mapSelectPlanError(res.status, data), res.status, data.detail, data.fallback);
  }
  return data;
}

export async function fetchBillingPublishableKey(
  opts: { oauthIssuer: string },
  getToken: TokenSource,
): Promise<string | null> {
  try {
    const res = await authFetch(opts.oauthIssuer, getToken, "/api/billing/config");
    if (!res.ok) return null;
    const data = (await res.json()) as { publishable_key?: string | null };
    return data.publishable_key || null;
  } catch {
    return null;
  }
}

export async function abortCrossCurrencyUpgrade(
  opts: { oauthIssuer: string },
  getToken: TokenSource,
  newSubscriptionId: string,
): Promise<void> {
  try {
    await authFetch(opts.oauthIssuer, getToken, "/api/billing/abort-cross-currency-upgrade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new_subscription_id: newSubscriptionId }),
    });
  } catch {
    // Best-effort cleanup.
  }
}

export async function completeCrossCurrencyUpgrade(
  opts: { oauthIssuer: string },
  getToken: TokenSource,
  newSubscriptionId: string,
): Promise<{ success?: boolean; redirect?: string; error?: string }> {
  const res = await authFetch(opts.oauthIssuer, getToken, "/api/billing/complete-cross-currency-upgrade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ new_subscription_id: newSubscriptionId }),
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; redirect?: string; error?: string };
  if (!res.ok) {
    throw new SelectPlanError(data.error || `Finalize failed (HTTP ${res.status})`, res.status);
  }
  return data;
}

export function isAllowedCheckoutUrl(oauthIssuer: string, url: string): boolean {
  try {
    const parsed = new URL(url);
    const issuerOrigin = new URL(oauthIssuer.replace(/\/$/, "")).origin;
    const allowed = [issuerOrigin, "https://checkout.stripe.com", "https://billing.stripe.com"];
    return parsed.protocol === "https:" && allowed.includes(parsed.origin);
  } catch {
    return false;
  }
}

export function isCheckoutSuccessUrl(oauthIssuer: string, url: string): boolean {
  try {
    const base = oauthIssuer.replace(/\/$/, "");
    const parsed = new URL(url);
    if (parsed.origin !== new URL(base).origin) return false;
    return parsed.pathname === "/pricing/success";
  } catch {
    return false;
  }
}

export function isCheckoutCanceledUrl(oauthIssuer: string, url: string): boolean {
  try {
    const base = oauthIssuer.replace(/\/$/, "");
    const parsed = new URL(url);
    if (parsed.origin !== new URL(base).origin) return false;
    return parsed.pathname === "/pricing/canceled";
  } catch {
    return false;
  }
}
