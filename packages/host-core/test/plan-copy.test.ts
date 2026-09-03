import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANNUAL_DISCOUNT,
  annualSavingPercent,
  buildPlanColumns,
  getAnnualPlanPricing,
  getPlanCardPricing,
  getPlanComparisonRows,
  getPlanDisplayFeatures,
  getPlanTagline,
} from "../src/plan-copy.js";
import type { PublicPlan } from "../src/plans.js";

function plan(overrides: Partial<PublicPlan> & { id: number; name: string }): PublicPlan {
  return {
    priceMonthly: 0,
    localizedPrice: { amount: 0, currency: "usd" },
    maxRpm: 10,
    requestsPerWeek: null,
    requestsPerWindow: null,
    windowHours: null,
    tokensPerWeek: null,
    features: null,
    tagline: null,
    isPopular: false,
    planKind: "normal",
    hasStripe: false,
    paygoDiscountPercent: 0,
    allowedModels: null,
    excludedModels: null,
    ...overrides,
  };
}

const free = plan({
  id: 1,
  name: "Free",
  requestsPerWeek: 350,
  requestsPerWindow: 25,
  windowHours: 5,
  excludedModels: ["kimi-k3"],
});

const pro = plan({
  id: 3,
  name: "Pro",
  priceMonthly: 30,
  localizedPrice: { amount: 30, currency: "gbp" },
  maxRpm: 30,
  requestsPerWeek: 13000,
  requestsPerWindow: 800,
  windowHours: 5,
  isPopular: true,
});

test("getPlanTagline falls back to the pricing-page default", () => {
  assert.equal(getPlanTagline(free), "Everything you need to try agentic development.");
  assert.equal(getPlanTagline(pro), "The sweet spot for serious daily agents.");
  assert.equal(getPlanTagline({ ...pro, tagline: "  Custom copy " }), "Custom copy");
  // Seeded rows carry the literal placeholder; it must not reach the card.
  assert.equal(getPlanTagline({ ...pro, tagline: "tagline" }), "The sweet spot for serious daily agents.");
});

test("marketing features mirror the pricing page bullets", () => {
  assert.deepEqual(getPlanDisplayFeatures(free), [
    "25 requests every 5 hours",
    "350 requests per week",
    "Excludes Kimi models",
    "On-demand rates beyond the bundle",
  ]);
  assert.deepEqual(getPlanDisplayFeatures(pro), [
    "800 requests every 5 hours",
    "13,000 requests per week",
    "Includes Kimi models",
    "Email support",
  ]);
});

test("Max tiers lead with flagship priority instead of a model-access line", () => {
  const max = plan({ id: 5, name: "Max", priceMonthly: 60, requestsPerWeek: 26000, requestsPerWindow: 1600, windowHours: 5 });
  assert.deepEqual(getPlanDisplayFeatures(max), [
    "1,600 requests every 5 hours",
    "26,000 requests per week",
    "Priority access to new flagships",
    "Priority support",
  ]);
});

test("custom features override the derived bullets", () => {
  const custom = plan({ id: 9, name: "Lite", features: "One\nTwo" });
  assert.deepEqual(getPlanDisplayFeatures(custom), ["One", "Two"]);
  const json = plan({ id: 9, name: "Lite", features: JSON.stringify(["A", "B"]) });
  assert.deepEqual(getPlanDisplayFeatures(json), ["A", "B"]);
});

test("annual pricing discounts the localized monthly amount at cent precision", () => {
  const annual = getAnnualPlanPricing(pro);
  assert.equal(annual.currency, "gbp");
  assert.equal(annual.billedYearly, Math.round(30 * 12 * (1 - ANNUAL_DISCOUNT) * 100) / 100);
  assert.equal(annual.displayMonthly, annual.billedYearly / 12);
  assert.equal(annualSavingPercent(), 17);

  const monthly = getPlanCardPricing(pro, false);
  assert.equal(monthly.displayPrice, 30);
  assert.equal(monthly.billedYearly, undefined);

  // Free stays free on the annual toggle.
  assert.equal(getPlanCardPricing(free, true).displayPrice, 0);
});

test("buildPlanColumns pairs Pro/Pro+ and Max/Max+ and keeps unknown tiers", () => {
  const catalog = [
    plan({ id: 1, name: "Free" }),
    plan({ id: 2, name: "Lite" }),
    plan({ id: 3, name: "Pro" }),
    plan({ id: 4, name: "Pro+" }),
    plan({ id: 5, name: "Max" }),
    plan({ id: 6, name: "Max+" }),
    plan({ id: 7, name: "Team" }),
  ];
  const columns = buildPlanColumns(catalog);
  assert.deepEqual(
    columns.map((c) => c.tiers.map((p) => p.name)),
    [["Free"], ["Lite"], ["Pro", "Pro+"], ["Max", "Max+"], ["Team"]],
  );
});

test("buildPlanColumns drops tiers the catalog does not return", () => {
  const columns = buildPlanColumns([plan({ id: 1, name: "Free" }), plan({ id: 3, name: "Pro" })]);
  assert.deepEqual(
    columns.map((c) => c.tiers.map((p) => p.name)),
    [["Free"], ["Pro"]],
  );
});

test("comparison rows label the quota window and flag excluded models", () => {
  const rows = getPlanComparisonRows([free, pro]);
  assert.equal(rows[0]?.label, "Included requests (per 5 hours)");
  assert.deepEqual(rows[0]?.values, ["25", "800"]);
  assert.deepEqual(rows[2]?.values, ["Full catalog (excl. Kimi models)", "Full catalog"]);
  // Priority support: Free no, Pro yes.
  assert.deepEqual(rows[5]?.values, [false, true]);
});
