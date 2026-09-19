import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasActiveSubscription,
  isBillingCycleChange,
  isCrossCurrencyChange,
  isPlanDowngrade,
  resolvePlanCardCtaKey,
  scheduledCancellationForPlanCard,
} from "../src/billing-plan.js";
import type { PublicPlan } from "../src/plans.js";

function plan(overrides: Partial<PublicPlan> & Pick<PublicPlan, "id" | "name" | "priceMonthly">): PublicPlan {
  return {
    localizedPrice: { amount: overrides.priceMonthly * 100, currency: "usd" },
    maxRpm: 60,
    requestsPerWeek: null,
    requestsPerWindow: null,
    windowHours: null,
    tokensPerWeek: null,
    features: null,
    tagline: null,
    isPopular: false,
    planKind: "normal",
    hasStripe: true,
    paygoDiscountPercent: 0,
    allowedModels: null,
    excludedModels: null,
    ...overrides,
  };
}

const catalog: PublicPlan[] = [
  plan({ id: 1, name: "Free", priceMonthly: 0 }),
  plan({ id: 2, name: "Pro", priceMonthly: 20 }),
  plan({ id: 3, name: "Team", priceMonthly: 50 }),
];

test("hasActiveSubscription treats active, trialing, and past_due as active", () => {
  assert.equal(
    hasActiveSubscription({ stripeSubscriptionId: "sub_1", subscriptionStatus: "active" }),
    true,
  );
  assert.equal(
    hasActiveSubscription({ stripeSubscriptionId: "sub_1", subscriptionStatus: "trialing" }),
    true,
  );
  assert.equal(
    hasActiveSubscription({ stripeSubscriptionId: "sub_1", subscriptionStatus: "past_due" }),
    true,
  );
});

test("hasActiveSubscription rejects canceled and missing subscription id", () => {
  assert.equal(
    hasActiveSubscription({ stripeSubscriptionId: "sub_1", subscriptionStatus: "canceled" }),
    false,
  );
  assert.equal(hasActiveSubscription({ stripeSubscriptionId: null, subscriptionStatus: "active" }), false);
  assert.equal(hasActiveSubscription({ stripeSubscriptionId: "", subscriptionStatus: "active" }), false);
});

test("hasActiveSubscription rejects missing or empty status even when subscription id exists", () => {
  assert.equal(hasActiveSubscription({ stripeSubscriptionId: "sub_1", subscriptionStatus: null }), false);
  assert.equal(hasActiveSubscription({ stripeSubscriptionId: "sub_1", subscriptionStatus: "" }), false);
});

test("isPlanDowngrade detects move to free and lower-priced tiers", () => {
  assert.equal(
    isPlanDowngrade({
      hasSubscription: true,
      targetPlan: catalog[0],
      currentPlanId: 2,
      currentPlanPriceMonthly: 20,
      publicPlans: catalog,
    }),
    true,
  );
  assert.equal(
    isPlanDowngrade({
      hasSubscription: true,
      targetPlan: catalog[1],
      currentPlanId: 3,
      currentPlanPriceMonthly: 50,
      publicPlans: catalog,
    }),
    true,
  );
});

test("isPlanDowngrade returns false for upgrades, same tier, or no subscription", () => {
  assert.equal(
    isPlanDowngrade({
      hasSubscription: true,
      targetPlan: catalog[2],
      currentPlanId: 2,
      currentPlanPriceMonthly: 20,
      publicPlans: catalog,
    }),
    false,
  );
  assert.equal(
    isPlanDowngrade({
      hasSubscription: false,
      targetPlan: catalog[0],
      currentPlanId: 2,
      currentPlanPriceMonthly: 20,
      publicPlans: catalog,
    }),
    false,
  );
  assert.equal(
    isPlanDowngrade({
      hasSubscription: true,
      targetPlan: undefined,
      currentPlanId: 2,
      currentPlanPriceMonthly: 20,
      publicPlans: catalog,
    }),
    false,
  );
});

test("isPlanDowngrade uses legacy monthly price when current plan is not in catalog", () => {
  assert.equal(
    isPlanDowngrade({
      hasSubscription: true,
      targetPlan: catalog[1],
      currentPlanId: 999,
      currentPlanPriceMonthly: 40,
      publicPlans: catalog,
    }),
    true,
  );
});

test("isCrossCurrencyChange detects currency mismatch for subscribed users", () => {
  const eurPlan = plan({
    id: 4,
    name: "Pro EU",
    priceMonthly: 18,
    localizedPrice: { amount: 1800, currency: "eur" },
  });
  assert.equal(
    isCrossCurrencyChange({
      hasSubscription: true,
      targetPlan: eurPlan,
      subscriptionCurrency: "usd",
    }),
    true,
  );
  assert.equal(
    isCrossCurrencyChange({
      hasSubscription: true,
      targetPlan: catalog[1]!,
      subscriptionCurrency: "usd",
    }),
    false,
  );
});

test("isCrossCurrencyChange is false without subscription or known currency", () => {
  const eurPlan = plan({
    id: 4,
    name: "Pro EU",
    priceMonthly: 18,
    localizedPrice: { amount: 1800, currency: "eur" },
  });
  assert.equal(
    isCrossCurrencyChange({
      hasSubscription: false,
      targetPlan: eurPlan,
      subscriptionCurrency: "usd",
    }),
    false,
  );
  assert.equal(
    isCrossCurrencyChange({
      hasSubscription: true,
      targetPlan: eurPlan,
      subscriptionCurrency: null,
    }),
    false,
  );
});

test("isCrossCurrencyChange compares currencies case-insensitively", () => {
  const eurPlan = plan({
    id: 4,
    name: "Pro EU",
    priceMonthly: 18,
    localizedPrice: { amount: 1800, currency: "EUR" },
  });
  assert.equal(
    isCrossCurrencyChange({
      hasSubscription: true,
      targetPlan: eurPlan,
      subscriptionCurrency: "usd",
    }),
    true,
  );
});

test("isPlanDowngrade detects move to Promo tier ($1/mo)", () => {
  const promoPlan = plan({ id: 10, name: "Promo", priceMonthly: 1 });
  assert.equal(
    isPlanDowngrade({
      hasSubscription: true,
      targetPlan: promoPlan,
      currentPlanId: 2,
      currentPlanPriceMonthly: 20,
      publicPlans: [...catalog, promoPlan],
    }),
    true,
  );
});

test("resolvePlanCardCtaKey produces startPromo and switchToPromo for Promo tier", () => {
  assert.equal(
    resolvePlanCardCtaKey({
      planId: 10,
      planPriceMonthly: 1,
      currentPlanId: null,
      hasSubscription: false,
      selectedCycle: "monthly",
      currentBillingCycle: null,
      isLoading: false,
    }).key,
    "startPromo",
  );
  assert.equal(
    resolvePlanCardCtaKey({
      planId: 10,
      planPriceMonthly: 1,
      currentPlanId: 2,
      hasSubscription: true,
      selectedCycle: "monthly",
      currentBillingCycle: "monthly",
      isLoading: false,
    }).key,
    "switchToPromo",
  );
});

test("scheduledCancellationForPlanCard preserves expiration badge when pendingPlanChange is Promo", () => {
  assert.deepEqual(
    scheduledCancellationForPlanCard({
      isCurrent: true,
      cancelAtPeriodEnd: true,
      nextBillingDate: "2026-10-01",
      pendingPlanChange: { planName: "Promo" },
    }),
    { expiresAt: "2026-10-01" },
  );
});

test("isBillingCycleChange does not allow billing cycle switch for Promo tier ($1/mo)", () => {
  assert.equal(
    isBillingCycleChange({
      planPriceMonthly: 1,
      hasSubscription: true,
      selectedCycle: "annual",
      currentBillingCycle: "monthly",
    }),
    false,
  );
});
