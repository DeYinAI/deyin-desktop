import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allCacheGuardPassed,
  CACHE_HIT_RATE_TARGET,
  runCacheGuard,
  SESSION_HIT_RATE_TARGET,
} from "../../testing/cache-guard.js";

test("cache guard 50-turn dialogue achieves ≥80% session hit rate", () => {
  const results = runCacheGuard();
  const stable = results.find((r) => r.scenario === "50-turn-stable-prefix");
  assert.ok(stable);
  assert.ok(stable!.hitRate >= SESSION_HIT_RATE_TARGET, `hit rate ${stable!.hitRate}`);
  assert.equal(stable!.invalidations.length, 0);
});

test("cache guard passes all scenarios", () => {
  assert.equal(allCacheGuardPassed(), true);
});

test("cache guard target constants", () => {
  assert.ok(CACHE_HIT_RATE_TARGET >= SESSION_HIT_RATE_TARGET);
  assert.equal(SESSION_HIT_RATE_TARGET, 0.8);
});
