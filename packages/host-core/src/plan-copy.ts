/**
 * Plan-card copy, derived the same way the Openference pricing page derives
 * it (dashboard-v2/src/lib/pricing.ts). The catalog rows carry quotas and
 * model access but usually no `tagline`/`features` text, so both surfaces
 * build the wording from the same inputs — keep the strings in step with the
 * web when either side changes.
 */

import type { PublicPlan } from "./plans.js";

export const ANNUAL_DISCOUNT = 0.17;

/** Order the pricing page lays the unified tiers out in. */
export const TIER_ORDER = ["Free", "Lite", "Pro", "Pro+", "Max", "Max+"] as const;

const DEFAULT_PLAN_TAGLINES: Record<string, string> = {
  Free: "Everything you need to try agentic development.",
  Lite: "For daily drivers who delegate most of their work.",
  Pro: "The sweet spot for serious daily agents.",
  "Pro+": "More headroom for heavy daily agent users.",
  Max: "Large workloads, automations, and team throughput.",
  "Max+": "Fleet-scale autonomy with the highest limits.",
};

/** Flagship models named on plan cards when a tier has the full catalog. */
export const PRICING_CATALOG_MODELS_LINE =
  "GLM-5.2, DeepSeek V4 Flash, DeepSeek V4 Pro, MiniMax M3, Qwen3.7 Plus, and more";

/** A DB tagline wins; "tagline" is the placeholder value seeded rows carry. */
export function getPlanTagline(plan: PublicPlan): string | null {
  const trimmed = plan.tagline?.trim();
  if (trimmed && trimmed.toLowerCase() !== "tagline") return trimmed;
  return DEFAULT_PLAN_TAGLINES[plan.name] ?? null;
}

/** Custom feature copy: a JSON array, else one bullet per non-empty line. */
export function parsePlanFeatures(features: string | null | undefined): string[] {
  if (!features?.trim()) return [];
  try {
    const parsed = JSON.parse(features);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return features.split("\n").map((s) => s.trim()).filter(Boolean);
  }
}

function isKimiModelName(name: string): boolean {
  return name.trim().toLowerCase().startsWith("kimi");
}

export function formatExcludedModelsLabel(excluded: string[]): string | null {
  if (excluded.length === 0) return null;
  if (excluded.every(isKimiModelName)) return "Excludes Kimi models";
  if (excluded.length === 1) return `Excludes ${excluded[0]} (higher tier)`;
  return `Excludes ${excluded.length} premium models (higher tier)`;
}

/** Model-access bullet; null for tiers that use the flagship-priority line instead. */
export function formatPlanModelAccessLine(plan: PublicPlan): string | null {
  if (plan.name === "Max" || plan.name === "Max+") return null;

  const excludedLabel = formatExcludedModelsLabel(plan.excludedModels ?? []);
  if (excludedLabel) return excludedLabel;

  if (plan.name === "Pro" || plan.name === "Pro+") return "Includes Kimi models";

  const allowed = plan.allowedModels;
  if (allowed && allowed.length === 1) return `Access to ${allowed[0]} only`;
  if (allowed && allowed.length > 1) return `Access to ${allowed.length} models`;

  return PRICING_CATALOG_MODELS_LINE;
}

function getPlanSupportOrExtrasLine(plan: PublicPlan): string | null {
  switch (plan.name) {
    case "Free":
      return "On-demand rates beyond the bundle";
    case "Lite":
      return "Community support";
    case "Pro":
    case "Pro+":
      return "Email support";
    case "Max":
      return "Priority support";
    case "Max+":
      return "Highest autonomous throughput";
    default:
      return null;
  }
}

function getPlanTierExtraLines(plan: PublicPlan): string[] {
  if (plan.name === "Max" || plan.name === "Max+") return ["Priority access to new flagships"];
  return [];
}

export function formatWindowRequestsLine(plan: PublicPlan): string | null {
  if (!plan.requestsPerWindow || !plan.windowHours || plan.windowHours <= 0) return null;
  return `${plan.requestsPerWindow.toLocaleString()} requests every ${plan.windowHours} hours`;
}

export function formatWeeklyRequestsLine(plan: PublicPlan): string | null {
  if (!plan.requestsPerWeek || plan.requestsPerWeek <= 0) return null;
  return `${plan.requestsPerWeek.toLocaleString()} requests per week`;
}

/**
 * The plan card bullets. `marketing` leads with the two request-quota lines
 * (what the pricing page shows); `billing` omits them for surfaces that
 * already render quotas separately.
 */
export function getDefaultPlanFeatures(
  plan: PublicPlan,
  surface: "marketing" | "billing" = "marketing",
): string[] {
  const items: string[] = [];

  if (surface === "marketing") {
    const windowLine = formatWindowRequestsLine(plan);
    if (windowLine) items.push(windowLine);
    const weeklyLine = formatWeeklyRequestsLine(plan);
    if (weeklyLine) items.push(weeklyLine);
  }

  const modelLine = formatPlanModelAccessLine(plan);
  if (modelLine) items.push(modelLine);

  items.push(...getPlanTierExtraLines(plan));

  const supportLine = getPlanSupportOrExtrasLine(plan);
  if (supportLine) items.push(supportLine);

  if (surface === "billing") {
    if (plan.paygoDiscountPercent > 0) items.push(`${plan.paygoDiscountPercent}% off on-demand usage`);
    if (plan.priceMonthly > 0 && plan.planKind === "agent") items.push("Autonomous agents included");
  }

  return items;
}

/** Custom `features` copy when the plan has any, else the derived bullets. */
export function getPlanDisplayFeatures(
  plan: PublicPlan,
  surface: "marketing" | "billing" = "marketing",
): string[] {
  const custom = parsePlanFeatures(plan.features);
  return custom.length > 0 ? custom : getDefaultPlanFeatures(plan, surface);
}

function isZeroDecimal(currency: string): boolean {
  return ["jpy", "krw", "vnd"].includes(currency.toLowerCase());
}

function roundForCurrency(amount: number, currency: string): number {
  return isZeroDecimal(currency) ? Math.round(amount) : Math.round(amount * 100) / 100;
}

/**
 * Annual pricing off the plan's already-localized monthly amount. Cent
 * precision (currency-aware) so the displayed yearly total matches what
 * Stripe actually charges — same arithmetic as the web's
 * getAnnualLocalizedPricing.
 */
export function getAnnualPlanPricing(
  plan: PublicPlan,
  annualDiscount: number = ANNUAL_DISCOUNT,
): { displayMonthly: number; billedYearly: number; currency: string } {
  const { amount, currency } = plan.localizedPrice;
  const billedYearly = roundForCurrency(amount * 12 * (1 - annualDiscount), currency);
  return { displayMonthly: billedYearly / 12, billedYearly, currency };
}

/** Headline price for a card under the selected billing cycle. */
export function getPlanCardPricing(
  plan: PublicPlan,
  isAnnual: boolean,
  annualDiscount: number = ANNUAL_DISCOUNT,
): { displayPrice: number; currency: string; billedYearly?: number } {
  if (!isAnnual || plan.localizedPrice.amount <= 0) {
    return { displayPrice: plan.localizedPrice.amount, currency: plan.localizedPrice.currency };
  }
  const annual = getAnnualPlanPricing(plan, annualDiscount);
  return {
    displayPrice: annual.displayMonthly,
    currency: annual.currency,
    billedYearly: annual.billedYearly,
  };
}

/** Whole-percent annual saving for the cycle toggle ("Save 17%"). */
export function annualSavingPercent(annualDiscount: number = ANNUAL_DISCOUNT): number {
  return Math.round(annualDiscount * 100);
}

/** The discount expressed as free months, for "save 2 months" copy. */
export function annualMonthsFree(annualDiscount: number = ANNUAL_DISCOUNT): number {
  return Math.round(annualDiscount * 12);
}

/**
 * A pricing-page column: one visible card that may cover two tiers the viewer
 * toggles between (Pro/Pro+, Max/Max+). Single-tier columns carry one entry.
 */
export interface PlanColumn {
  /** Stable key for the column (the first tier's name). */
  key: string;
  tiers: PublicPlan[];
}

/**
 * Group the coding catalog into the pricing page's columns: Free, Lite, the
 * Pro pair, then the Max pair. Tiers the catalog does not return are dropped,
 * and any plan outside the known order is appended as its own column so a new
 * SKU still shows up.
 */
export function buildPlanColumns(plans: PublicPlan[]): PlanColumn[] {
  const byName = new Map(plans.map((p) => [p.name, p]));
  const grouped: string[][] = [["Free"], ["Lite"], ["Pro", "Pro+"], ["Max", "Max+"]];
  const columns: PlanColumn[] = [];
  const claimed = new Set<string>();

  for (const names of grouped) {
    const tiers = names
      .map((n) => byName.get(n))
      .filter((p): p is PublicPlan => !!p);
    const first = tiers[0];
    if (!first) continue;
    for (const t of tiers) claimed.add(t.name);
    columns.push({ key: first.name, tiers });
  }

  for (const plan of plans) {
    if (claimed.has(plan.name)) continue;
    columns.push({ key: plan.name, tiers: [plan] });
  }

  return columns;
}

/* --------------------------------------------------------------------- */
/* Plan comparison table (the pricing page's "Compare all plans")          */
/* --------------------------------------------------------------------- */

export interface PlanComparisonRow {
  label: string;
  /** One cell per plan, in the order the plans were passed. */
  values: (boolean | string)[];
  highlight?: boolean;
}

function planHasPrioritySupport(plan: PublicPlan): boolean {
  return ["Pro", "Pro+", "Max", "Max+"].includes(plan.name);
}

/** Column header for the request-quota row, e.g. "(per 5 hours)". */
export function getRequestQuotaComparisonLabel(plans: PublicPlan[]): string {
  const hours = plans.map((p) => p.windowHours).find((h) => h != null && h > 0);
  return hours != null ? `Included requests (per ${hours} hours)` : "Included requests";
}

export function formatRequestQuotaComparisonValue(plan: PublicPlan): string {
  if (plan.requestsPerWindow && plan.windowHours && plan.windowHours > 0) {
    return plan.requestsPerWindow.toLocaleString();
  }
  if (plan.requestsPerWeek && plan.requestsPerWeek > 0) return plan.requestsPerWeek.toLocaleString();
  return "Unlimited";
}

export function formatOnDemandUsageLabel(plan: PublicPlan): string {
  if (plan.paygoDiscountPercent > 0) return `Available (${plan.paygoDiscountPercent}% off included usage)`;
  return "Available";
}

function formatModelAccessComparisonValue(plan: PublicPlan): string {
  const allowed = plan.allowedModels;
  const excluded = plan.excludedModels ?? [];
  const base =
    !allowed || allowed.length === 0
      ? "Full catalog"
      : allowed.length === 1
        ? (allowed[0] ?? "Full catalog")
        : `${allowed.length} models`;
  if (excluded.length === 0) return base;
  const excludedLabel = excluded.every(isKimiModelName)
    ? "excl. Kimi models"
    : excluded.length === 1
      ? `excl. ${excluded[0]}`
      : `excl. ${excluded.length} models`;
  return `${base} (${excludedLabel})`;
}

/** The comparison rows, in the same order and wording as the pricing page. */
export function getPlanComparisonRows(plans: PublicPlan[]): PlanComparisonRow[] {
  return [
    {
      label: getRequestQuotaComparisonLabel(plans),
      values: plans.map(formatRequestQuotaComparisonValue),
      highlight: true,
    },
    { label: "On-demand usage", values: plans.map(formatOnDemandUsageLabel) },
    { label: "Model access", values: plans.map(formatModelAccessComparisonValue) },
    { label: "Credit top-ups", values: plans.map(() => true) },
    { label: "Usage analytics", values: plans.map((_, i) => i >= 1) },
    { label: "Priority support", values: plans.map(planHasPrioritySupport) },
  ];
}
