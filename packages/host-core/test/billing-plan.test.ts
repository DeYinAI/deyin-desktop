import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasActiveSubscription,
  isCrossCurrencyChange,
  isPlanDowngrade,
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
