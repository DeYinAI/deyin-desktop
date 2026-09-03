import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPublicPlans } from "../src/plans.js";

const samplePlan = {
  id: 4,
  name: "Free",
  priceMonthly: 0,
  localizedPrice: { amount: 0, currency: "usd" },
  maxRpm: 10,
  planKind: "normal",
};

test("fetchPublicPlans uses issuer origin by default", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0] | URL) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ plans: [samplePlan] }), { status: 200 });
  }) as typeof fetch;

  try {
    const plans = await fetchPublicPlans({ oauthIssuer: "https://openference.com" });
    assert.equal(requestedUrl, "https://openference.com/api/public/plans");
    assert.equal(plans?.length, 1);
    assert.equal(plans?.[0]?.name, "Free");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchPublicPlans uses apiBase for same-origin proxy", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0] | URL) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ plans: [samplePlan] }), { status: 200 });
  }) as typeof fetch;

  try {
    const plans = await fetchPublicPlans({
      oauthIssuer: "https://openference.com",
      apiBase: "https://chat.openference.com/api",
    });
    assert.equal(requestedUrl, "https://chat.openference.com/api/public/plans");
    assert.equal(plans?.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchPublicPlans returns null when plans array is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;

  try {
    const plans = await fetchPublicPlans({ oauthIssuer: "https://openference.com" });
    assert.equal(plans, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizePlan defaults the catalog access fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ plans: [samplePlan] }), { status: 200 })) as typeof fetch;

  try {
    const plans = await fetchPublicPlans({ oauthIssuer: "https://openference.com" });
    assert.equal(plans?.[0]?.paygoDiscountPercent, 0);
    assert.equal(plans?.[0]?.allowedModels, null);
    assert.equal(plans?.[0]?.excludedModels, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizePlan passes through model access and paygo discount", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        plans: [
          {
            ...samplePlan,
            paygoDiscountPercent: 20,
            allowedModels: ["glm-5.2"],
            excludedModels: ["kimi-k3"],
          },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;

  try {
    const plans = await fetchPublicPlans({ oauthIssuer: "https://openference.com" });
    assert.equal(plans?.[0]?.paygoDiscountPercent, 20);
    assert.deepEqual(plans?.[0]?.allowedModels, ["glm-5.2"]);
    assert.deepEqual(plans?.[0]?.excludedModels, ["kimi-k3"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
