import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchAccountUsage, parseServerIdentity } from "../src/account.js";

test("parseServerIdentity returns null when the block is absent or empty", () => {
  assert.equal(parseServerIdentity(undefined), null);
  assert.equal(parseServerIdentity(null as never), null);
  assert.equal(parseServerIdentity({}), null);
  assert.equal(parseServerIdentity({ tenant: "", org: "", role: "", policies: [] }), null);
});

test("parseServerIdentity parses a full block", () => {
  const identity = parseServerIdentity({
    tenant: "default",
    org: "personal",
    role: "owner",
    policies: ["models:invoke", "tickets:manage"],
  });
  assert.deepEqual(identity, {
    tenant: "default",
    org: "personal",
    role: "owner",
    policies: ["models:invoke", "tickets:manage"],
  });
});

test("parseServerIdentity drops non-string policies and blanks", () => {
  const identity = parseServerIdentity({
    tenant: "default",
    policies: ["a", 42, null, "b"] as never,
  });
  assert.equal(identity?.tenant, "default");
  assert.deepEqual(identity?.policies, ["a", "b"]);
});

/** Stub global fetch with one canned /api/user/me body for the duration of fn. */
async function withMeBody(body: unknown, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const token = async () => "tok";

test("fetchAccountUsage maps the rolling window quota and epoch resets", async () => {
  const windowReset = Date.UTC(2026, 7, 21, 18, 0, 0);
  const weeklyReset = Date.UTC(2026, 7, 24, 0, 0, 0);
  await withMeBody(
    {
      plan: { name: "Max", requestsPerWindow: 900, windowHours: 5 },
      usage: {
        todayRequests: 20,
        weekRequests: 54,
        weekTokens: 325_000,
        windowRequests: 12,
        weekQuotaUsed: 61.5,
        windowQuotaUsed: 18.25,
        totalRequests: 400,
        totalTokens: 9_000_000,
      },
      credits: { balanceUsd: 50.93 },
      limits: {
        requestsPerWeek: 84_000,
        tokensPerWeek: null,
        windowLimit: { requests: 250, hours: 5 },
        weeklyResetAt: weeklyReset,
        windowResetAt: windowReset,
      },
    },
    async () => {
      const usage = await fetchAccountUsage({ oauthIssuer: "https://example.test/" }, token);
      assert.equal(usage?.requestsPerWindow, 250);
      assert.equal(usage?.windowHours, 5);
      assert.equal(usage?.windowRequests, 12);
      assert.equal(usage?.windowQuotaUsed, 18.25);
      assert.equal(usage?.weekQuotaUsed, 61.5);
      assert.equal(usage?.windowResetAt, new Date(windowReset).toISOString());
      assert.equal(usage?.weeklyResetAt, new Date(weeklyReset).toISOString());
    },
  );
});

test("fetchAccountUsage falls back to plan window limits and raw counts", async () => {
  await withMeBody(
    {
      plan: { name: "Free", requestsPerWindow: 40, windowHours: 5 },
      usage: { weekRequests: 7, windowRequests: 3 },
      limits: { windowLimit: null, weeklyResetAt: null },
    },
    async () => {
      const usage = await fetchAccountUsage({ oauthIssuer: "https://example.test" }, token);
      // limits.windowLimit is null, so the plan block supplies the pair.
      assert.equal(usage?.requestsPerWindow, 40);
      assert.equal(usage?.windowHours, 5);
      // No quota-used fields: the raw counts stand in rather than reading zero.
      assert.equal(usage?.weekQuotaUsed, 7);
      assert.equal(usage?.windowQuotaUsed, 3);
      assert.equal(usage?.weeklyResetAt, null);
      assert.equal(usage?.windowResetAt, null);
    },
  );
});

test("fetchAccountUsage reports no window limit when the plan defines none", async () => {
  await withMeBody({ plan: { name: "Free" }, usage: {}, limits: {} }, async () => {
    const usage = await fetchAccountUsage({ oauthIssuer: "https://example.test" }, token);
    assert.equal(usage?.requestsPerWindow, null);
    assert.equal(usage?.windowHours, null);
    assert.equal(usage?.windowQuotaUsed, 0);
  });
});

test("fetchAccountUsage returns null when signed out", async () => {
  const usage = await fetchAccountUsage({ oauthIssuer: "https://example.test" }, async () => null);
  assert.equal(usage, null);
});
