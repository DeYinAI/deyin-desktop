import assert from "node:assert/strict";
import { test } from "node:test";
import {
  disabledReleaseStatus,
  fetchReleaseStatus,
  formatReleaseCountdown,
  isPlanPurchaseBlocked,
  planBlockedCtaKind,
  releaseAnyBlocked,
  type ReleaseStatus,
} from "../src/plan-release.js";

function status(overrides: Partial<ReleaseStatus> = {}): ReleaseStatus {
  return { ...disabledReleaseStatus(), enabled: true, ...overrides };
}

test("fetchReleaseStatus reads the public endpoint off the issuer", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0] | URL) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({
        enabled: true,
        available: true,
        beforeDrop: false,
        cap: 25,
        dropHourUtc: 14,
        nextDropAt: "2026-09-04T14:00:00.000Z",
        soldOutPlanIds: [5, 6],
        annualSoldOut: true,
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const result = await fetchReleaseStatus({ oauthIssuer: "https://openference.com" });
    assert.equal(requestedUrl, "https://openference.com/api/public/release-status");
    assert.deepEqual(result.soldOutPlanIds, [5, 6]);
    assert.equal(result.annualSoldOut, true);
    assert.equal(result.nextDropAt, "2026-09-04T14:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchReleaseStatus uses apiBase for the same-origin proxy", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0] | URL) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ enabled: false }), { status: 200 });
  }) as typeof fetch;

  try {
    await fetchReleaseStatus({
      oauthIssuer: "https://openference.com",
      apiBase: "https://chat.openference.com/api",
    });
    assert.equal(requestedUrl, "https://chat.openference.com/api/public/release-status");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unreachable or absent endpoint reports the gate as off", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
  try {
    assert.equal((await fetchReleaseStatus({ oauthIssuer: "https://openference.com" })).enabled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  try {
    assert.equal((await fetchReleaseStatus({ oauthIssuer: "https://openference.com" })).enabled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("free plans and paying subscribers are never blocked", () => {
  const soldOutEverything = status({ beforeDrop: true });
  assert.equal(
    isPlanPurchaseBlocked({
      releaseStatus: soldOutEverything,
      planId: 1,
      planPriceMonthly: 0,
      isAnnual: false,
      releaseExempt: false,
    }),
    false,
  );
  assert.equal(
    isPlanPurchaseBlocked({
      releaseStatus: soldOutEverything,
      planId: 3,
      planPriceMonthly: 30,
      isAnnual: false,
      releaseExempt: true,
    }),
    false,
  );
});

test("before the drop every paid plan is blocked; after it only sold-out ids", () => {
  const before = status({ beforeDrop: true });
  const after = status({ soldOutPlanIds: [5] });
  const paid = { planPriceMonthly: 30, isAnnual: false, releaseExempt: false };

  assert.equal(isPlanPurchaseBlocked({ releaseStatus: before, planId: 3, ...paid }), true);
  assert.equal(planBlockedCtaKind({ releaseStatus: before, planId: 3, ...paid }), "beforeDrop");

  assert.equal(isPlanPurchaseBlocked({ releaseStatus: after, planId: 3, ...paid }), false);
  assert.equal(isPlanPurchaseBlocked({ releaseStatus: after, planId: 5, ...paid }), true);
  assert.equal(planBlockedCtaKind({ releaseStatus: after, planId: 5, ...paid }), "soldOut");
});

test("an unreadable authority fails closed, and the annual freeze blocks annual only", () => {
  const unreadable = status({ available: false });
  const paid = { planPriceMonthly: 30, isAnnual: false, releaseExempt: false };
  assert.equal(isPlanPurchaseBlocked({ releaseStatus: unreadable, planId: 3, ...paid }), true);
  assert.equal(planBlockedCtaKind({ releaseStatus: unreadable, planId: 3, ...paid }), "unavailable");

  const annualFrozen = { ...disabledReleaseStatus(), annualSoldOut: true };
  assert.equal(
    isPlanPurchaseBlocked({ releaseStatus: annualFrozen, planId: 3, planPriceMonthly: 30, isAnnual: true, releaseExempt: false }),
    true,
  );
  assert.equal(
    isPlanPurchaseBlocked({ releaseStatus: annualFrozen, planId: 3, planPriceMonthly: 30, isAnnual: false, releaseExempt: false }),
    false,
  );
});

test("releaseAnyBlocked drives the page banner", () => {
  assert.equal(releaseAnyBlocked(disabledReleaseStatus()), false);
  assert.equal(releaseAnyBlocked(status()), false);
  assert.equal(releaseAnyBlocked(status({ soldOutPlanIds: [1] })), true);
  assert.equal(releaseAnyBlocked(status({ beforeDrop: true })), true);
  assert.equal(releaseAnyBlocked(status({ available: false })), true);
});

test("countdown formatting drops empty leading units and expires to null", () => {
  const base = Date.parse("2026-09-03T00:00:00.000Z");
  const at = (ms: number) => new Date(base + ms).toISOString();
  assert.equal(formatReleaseCountdown(at(14 * 3600_000 + 12 * 60_000 + 51_000), base), "14h 12m 51s");
  assert.equal(formatReleaseCountdown(at(12 * 60_000 + 51_000), base), "12m 51s");
  assert.equal(formatReleaseCountdown(at(9_000), base), "9s");
  assert.equal(formatReleaseCountdown(at(0), base), null);
  assert.equal(formatReleaseCountdown(null, base), null);
  assert.equal(formatReleaseCountdown("not-a-date", base), null);
});
