/** Pure billing plan selection helpers (ported from Openference dashboard). */

import type { PublicPlan } from "./plans.js";

export type BillingCycle = "monthly" | "annual";

export interface PendingPlanChange {
  planId: number;
  planName: string;
  effectiveDate: string | null;
}

export function formatBillingDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function formatBillingDateShort(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function hasActiveSubscription(params: {
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
}): boolean {
  if (!params.stripeSubscriptionId) return false;
  const status = params.subscriptionStatus?.toLowerCase();
  if (!status) return false;
  return ["active", "trialing", "past_due"].includes(status);
}

export function isPlanInPublicCatalog(planId: number | null | undefined, publicPlans: PublicPlan[]): boolean {
  if (planId == null) return false;
  return publicPlans.some((p) => p.id === planId);
}

export function resolveCurrentPlanCard(params: {
  cardPlan: PublicPlan;
  currentPlanId: number | null;
  currentPlanName: string | null | undefined;
  publicPlans: PublicPlan[];
}): { isCurrent: boolean; isLegacyMatch: boolean } {
  const { cardPlan, currentPlanId, currentPlanName, publicPlans } = params;
  if (currentPlanId == null) return { isCurrent: false, isLegacyMatch: false };
  if (cardPlan.id === currentPlanId) return { isCurrent: true, isLegacyMatch: false };
  if (
    !isPlanInPublicCatalog(currentPlanId, publicPlans) &&
    currentPlanName &&
    cardPlan.name.localeCompare(currentPlanName, undefined, { sensitivity: "accent" }) === 0
  ) {
    return { isCurrent: true, isLegacyMatch: true };
  }
  return { isCurrent: false, isLegacyMatch: false };
}

export function resolvePlanSelectionId(params: {
  cardPlanId: number;
  isLegacyMatch: boolean;
  currentPlanId: number | null;
}): number {
  if (params.isLegacyMatch && params.currentPlanId != null) return params.currentPlanId;
  return params.cardPlanId;
}

export function isPlanDowngrade(params: {
  hasSubscription: boolean;
  targetPlan: PublicPlan | undefined;
  currentPlanId: number | null;
  currentPlanPriceMonthly: number | null | undefined;
  publicPlans: PublicPlan[];
}): boolean {
  const { hasSubscription, targetPlan, currentPlanId, currentPlanPriceMonthly, publicPlans } = params;
  if (!hasSubscription || !targetPlan) return false;
  if (targetPlan.priceMonthly === 0) return true;
  const currentFromCatalog = publicPlans.find((p) => p.id === currentPlanId);
  const currentPrice =
    currentFromCatalog?.priceMonthly ??
    (currentPlanPriceMonthly != null && currentPlanPriceMonthly > 0 ? currentPlanPriceMonthly : null);
  if (currentPrice == null) return false;
  return targetPlan.priceMonthly < currentPrice;
}

export function isBillingCycleChange(params: {
  planPriceMonthly: number;
  hasSubscription: boolean;
  selectedCycle: BillingCycle;
  currentBillingCycle: BillingCycle | null;
}): boolean {
  const { planPriceMonthly, hasSubscription, selectedCycle, currentBillingCycle } = params;
  if (!hasSubscription || planPriceMonthly <= 0) return false;
  const current = currentBillingCycle ?? "monthly";
  return selectedCycle !== current;
}

export type PlanCardCtaKey =
  | "processing"
  | "switchToAnnual"
  | "switchToMonthly"
  | "current"
  | "switchToFree"
  | "startFree"
  | "switchPlan"
  | "subscribe";

export function resolvePlanCardCtaKey(params: {
  planId: number;
  planPriceMonthly: number;
  currentPlanId: number | null;
  hasSubscription: boolean;
  selectedCycle: BillingCycle;
  currentBillingCycle: BillingCycle | null;
  isLoading: boolean;
  isCurrentTier?: boolean;
}): { key: PlanCardCtaKey; disabled: boolean; isBillingCycleSwitch: boolean } {
  const {
    planId,
    planPriceMonthly,
    currentPlanId,
    hasSubscription,
    selectedCycle,
    currentBillingCycle,
    isLoading,
    isCurrentTier: isCurrentTierOverride,
  } = params;

  const isCurrentTier = isCurrentTierOverride ?? planId === currentPlanId;
  const billingCycleSwitch =
    isCurrentTier &&
    isBillingCycleChange({ planPriceMonthly, hasSubscription, selectedCycle, currentBillingCycle });

  if (isLoading) return { key: "processing", disabled: true, isBillingCycleSwitch: billingCycleSwitch };
  if (billingCycleSwitch) {
    return {
      key: selectedCycle === "annual" ? "switchToAnnual" : "switchToMonthly",
      disabled: false,
      isBillingCycleSwitch: true,
    };
  }
  if (isCurrentTier) return { key: "current", disabled: true, isBillingCycleSwitch: false };
  if (planPriceMonthly === 0) {
    return { key: hasSubscription ? "switchToFree" : "startFree", disabled: false, isBillingCycleSwitch: false };
  }
  return { key: hasSubscription ? "switchPlan" : "subscribe", disabled: false, isBillingCycleSwitch: false };
}

export function scheduledCancellationForPlanCard(params: {
  isCurrent: boolean;
  cancelAtPeriodEnd: boolean;
  nextBillingDate: string | null;
  pendingPlanChange?: Pick<PendingPlanChange, "planName"> | null;
}): { expiresAt: string } | null {
  if (!params.isCurrent || !params.cancelAtPeriodEnd || !params.nextBillingDate) return null;
  if (params.pendingPlanChange && params.pendingPlanChange.planName !== "Free") return null;
  return { expiresAt: params.nextBillingDate };
}

export function pendingSwitchOnCurrentPlanCard(params: {
  isCurrent: boolean;
  pendingPlanChange?: PendingPlanChange | null;
  nextBillingDate?: string | null;
}): { switchingTo: string; expiresAt: string } | null {
  const pending = params.pendingPlanChange;
  if (!params.isCurrent || !pending) return null;
  const expiresIso = pending.effectiveDate ?? params.nextBillingDate ?? null;
  if (!expiresIso) return null;
  return { switchingTo: pending.planName, expiresAt: expiresIso };
}

export function pendingPlanSwitchForCard(params: {
  planId: number;
  isCurrent: boolean;
  pendingPlanChange?: PendingPlanChange | null;
  nextBillingDate?: string | null;
}): { startsAtLabel: string } | null {
  const pending = params.pendingPlanChange;
  if (!pending || params.isCurrent || params.planId !== pending.planId) return null;
  const startsIso = pending.effectiveDate ?? params.nextBillingDate ?? null;
  const startsAtLabel = startsIso
    ? `Scheduled · starts ${formatBillingDateShort(startsIso)}`
    : "Scheduled at renewal";
  return { startsAtLabel };
}

export function buildPlanCardPresentation(params: {
  plan: PublicPlan;
  currentPlanId: number | null;
  currentPlanName: string | null;
  currentPlanPriceMonthly: number | null;
  publicPlans: PublicPlan[];
  hasSubscription: boolean;
  isAnnual: boolean;
  currentBillingCycle: BillingCycle | null;
  isLoading: boolean;
}) {
  const {
    plan,
    currentPlanId,
    currentPlanName,
    currentPlanPriceMonthly,
    publicPlans,
    hasSubscription,
    isAnnual,
    currentBillingCycle,
    isLoading,
  } = params;

  const { isCurrent, isLegacyMatch } = resolveCurrentPlanCard({
    cardPlan: plan,
    currentPlanId,
    currentPlanName,
    publicPlans,
  });

  const tierMonthly =
    isCurrent && isLegacyMatch && currentPlanPriceMonthly != null && currentPlanPriceMonthly > 0
      ? currentPlanPriceMonthly
      : plan.priceMonthly;

  const selectedCycle: BillingCycle = isAnnual ? "annual" : "monthly";
  const billingCycleSwitch =
    isCurrent &&
    isBillingCycleChange({
      planPriceMonthly: tierMonthly,
      hasSubscription,
      selectedCycle,
      currentBillingCycle,
    });

  const cta = resolvePlanCardCtaKey({
    planId: plan.id,
    planPriceMonthly: tierMonthly,
    currentPlanId,
    hasSubscription,
    selectedCycle,
    currentBillingCycle,
    isLoading,
    isCurrentTier: isCurrent,
  });

  const selectionPlanId = resolvePlanSelectionId({
    cardPlanId: plan.id,
    isLegacyMatch,
    currentPlanId,
  });

  return {
    isCurrent,
    isLegacyMatch,
    cta,
    billingCycleSwitch,
    selectionPlanId,
    displayPrice: plan.localizedPrice.amount,
    currency: plan.localizedPrice.currency,
  };
}

export function isCrossCurrencyChange(params: {
  hasSubscription: boolean;
  targetPlan: PublicPlan;
  subscriptionCurrency: string | null;
}): boolean {
  if (!params.hasSubscription || !params.subscriptionCurrency) return false;
  const sub = params.subscriptionCurrency.toLowerCase();
  const target = params.targetPlan.localizedPrice.currency.toLowerCase();
  return sub !== target;
}

export function estimateProratedCharge(params: {
  targetPriceMonthly: number;
  periodStart: string | null;
  nextBillingDate: string | null;
}): number {
  const periodStartMs = params.periodStart ? Date.parse(params.periodStart) : NaN;
  const periodEndMs = params.nextBillingDate ? Date.parse(params.nextBillingDate) : NaN;
  const nowMs = Date.now();
  const unusedFraction =
    periodStartMs && periodEndMs && periodEndMs > periodStartMs
      ? Math.max(0, Math.min(1, (periodEndMs - nowMs) / (periodEndMs - periodStartMs)))
      : 0;
  return Math.round(params.targetPriceMonthly * unusedFraction * 100) / 100;
}

export function isZeroDecimalCurrency(currency: string): boolean {
  return ["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"].includes(
    currency.toLowerCase(),
  );
}

export function estimateRefund(params: {
  latestInvoiceAmountPaid: number | null;
  latestInvoiceCurrency: string | null;
  periodStart: string | null;
  nextBillingDate: string | null;
}): number | null {
  if (params.latestInvoiceAmountPaid == null || !params.latestInvoiceCurrency) return null;
  const periodStartMs = params.periodStart ? Date.parse(params.periodStart) : NaN;
  const periodEndMs = params.nextBillingDate ? Date.parse(params.nextBillingDate) : NaN;
  const nowMs = Date.now();
  const unusedFraction =
    periodStartMs && periodEndMs && periodEndMs > periodStartMs
      ? Math.max(0, Math.min(1, (periodEndMs - nowMs) / (periodEndMs - periodStartMs)))
      : 0;
  const divisor = isZeroDecimalCurrency(params.latestInvoiceCurrency) ? 1 : 100;
  return (params.latestInvoiceAmountPaid * unusedFraction) / divisor;
}
