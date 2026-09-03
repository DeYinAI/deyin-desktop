/**
 * Live plan-release status (GET {issuer}/api/public/release-status).
 *
 * Openference releases a per-plan daily allotment at a fixed UTC hour: before
 * the drop every paid plan is closed, and after it a plan closes again once
 * its own cap is exhausted. The authoritative gate runs at purchase time
 * (select-plan answers 409 when a plan is gone), so this endpoint is advisory
 * display only — it drives the "Sold out today" CTA and the reopen countdown.
 *
 * Deliberately a separate, uncached call: the plan catalog is edge-cached for
 * 300s, and a stale countdown would be worse than one extra request.
 */

import { deyinUserAgent } from "./user-agent.js";

export interface ReleaseStatus {
  /** False when the release gate is off entirely — nothing is ever blocked. */
  enabled: boolean;
  /** False when the gate is on but its authority could not be read (fail closed). */
  available: boolean;
  /** True between the daily reset and the drop instant: all paid plans closed. */
  beforeDrop: boolean;
  cap: number;
  dropHourUtc: number;
  /** ISO instant of the next drop, or null when there is nothing to count to. */
  nextDropAt: string | null;
  /** Plans whose own cap is exhausted today; a plan not listed is purchasable. */
  soldOutPlanIds: number[];
  /** Operator freeze: annual billing is closed across every plan. */
  annualSoldOut: boolean;
}

interface ReleaseStatusApiResponse {
  enabled?: boolean;
  available?: boolean;
  beforeDrop?: boolean;
  cap?: number;
  dropHourUtc?: number;
  nextDropAt?: string | null;
  soldOutPlanIds?: number[];
  annualSoldOut?: boolean;
}

/** The gate is off — used when the endpoint says so, and when it 404s (older server). */
export function disabledReleaseStatus(): ReleaseStatus {
  return {
    enabled: false,
    available: true,
    beforeDrop: false,
    cap: 0,
    dropHourUtc: 0,
    nextDropAt: null,
    soldOutPlanIds: [],
    annualSoldOut: false,
  };
}

/**
 * Fetch the live release status. Returns the disabled state when the endpoint
 * is unreachable or absent: the server still refuses a sold-out purchase, so
 * an unreachable advisory must not lock the UI down on its own.
 */
export async function fetchReleaseStatus(opts: {
  oauthIssuer: string;
  apiBase?: string;
}): Promise<ReleaseStatus> {
  try {
    const apiBase = opts.apiBase?.replace(/\/$/, "");
    const url = apiBase
      ? `${apiBase}/public/release-status`
      : `${opts.oauthIssuer.replace(/\/$/, "")}/api/public/release-status`;
    const res = await fetch(url, { headers: { "user-agent": deyinUserAgent() } });
    if (!res.ok) return disabledReleaseStatus();
    const body = (await res.json()) as ReleaseStatusApiResponse;
    return {
      enabled: body.enabled === true,
      available: body.available !== false,
      beforeDrop: body.beforeDrop === true,
      cap: body.cap ?? 0,
      dropHourUtc: body.dropHourUtc ?? 0,
      nextDropAt: body.nextDropAt ?? null,
      soldOutPlanIds: Array.isArray(body.soldOutPlanIds) ? body.soldOutPlanIds : [],
      annualSoldOut: body.annualSoldOut === true,
    };
  } catch {
    return disabledReleaseStatus();
  }
}

/**
 * Whether the release gate currently blocks a NEW purchase of `planId`.
 * Before the drop every paid plan is blocked; after it, only plans whose cap
 * is spent. Existing paid subscribers are exempt — the caller passes
 * `releaseExempt` for them, mirroring the server's exemption.
 */
export function isPlanPurchaseBlocked(params: {
  releaseStatus: ReleaseStatus | null | undefined;
  planId: number;
  planPriceMonthly: number;
  isAnnual: boolean;
  releaseExempt: boolean;
}): boolean {
  const { releaseStatus, planId, planPriceMonthly, isAnnual, releaseExempt } = params;
  if (planPriceMonthly <= 0 || releaseExempt) return false;
  if (isAnnual && releaseStatus?.annualSoldOut) return true;
  if (!releaseStatus?.enabled) return false;
  if (!releaseStatus.available) return true;
  if (releaseStatus.beforeDrop) return true;
  return releaseStatus.soldOutPlanIds.includes(planId);
}

export type PlanBlockedCtaKind = "open" | "unavailable" | "beforeDrop" | "soldOut";

/** Which blocked-state label a plan card CTA should show. */
export function planBlockedCtaKind(params: {
  releaseStatus: ReleaseStatus | null | undefined;
  planId: number;
  planPriceMonthly: number;
  isAnnual: boolean;
  releaseExempt: boolean;
}): PlanBlockedCtaKind {
  if (!isPlanPurchaseBlocked(params)) return "open";
  if (params.releaseStatus?.enabled && !params.releaseStatus.available) return "unavailable";
  if (params.isAnnual && params.releaseStatus?.annualSoldOut) return "soldOut";
  if (params.releaseStatus?.beforeDrop) return "beforeDrop";
  return "soldOut";
}

/** True when any paid plan is currently blocked (drives the page-level banner). */
export function releaseAnyBlocked(status: ReleaseStatus | null | undefined): boolean {
  if (!status?.enabled) return false;
  return !status.available || status.beforeDrop || status.soldOutPlanIds.length > 0;
}

/**
 * Countdown to the next drop as "14h 12m 51s" (hours dropped once under an
 * hour). Returns null once the instant has passed, so the caller can refetch
 * rather than render a frozen zero.
 */
export function formatReleaseCountdown(nextDropAt: string | null, nowMs = Date.now()): string | null {
  if (!nextDropAt) return null;
  const target = Date.parse(nextDropAt);
  if (!Number.isFinite(target)) return null;
  const remaining = target - nowMs;
  if (remaining <= 0) return null;
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
