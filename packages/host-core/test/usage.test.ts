import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageDay } from "../src/types.js";
import { applyEvent, computeStats } from "../src/usage.js";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

test("applyEvent creates today's bucket and accumulates tokens", () => {
  const days: UsageDay[] = [];
  applyEvent(days, { model: "GLM-5.2", tokens: 100, newSession: true });
  const updated = applyEvent(days, { model: "GLM-5.2", tokens: 50.6 });
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.date, today());
  assert.equal(updated[0]?.byModel["GLM-5.2"], 151);
  assert.equal(updated[0]?.messages, 2);
  assert.equal(updated[0]?.sessions, 1);
});

test("applyEvent ignores negative token counts", () => {
  const days = applyEvent([], { model: "m", tokens: -50 });
  assert.equal(days[0]?.byModel.m, 0);
});

test("computeStats aggregates totals, favorite model and streak", () => {
  const days: UsageDay[] = [
    { date: "2020-01-01", byModel: { a: 100, b: 300 }, messages: 4, sessions: 1 },
    { date: today(), byModel: { a: 700 }, messages: 2, sessions: 1 },
  ];
  const stats = computeStats(days);
  assert.equal(stats.totalTokens, 1100);
  assert.equal(stats.messages, 6);
  assert.equal(stats.sessions, 2);
  assert.equal(stats.activeDays, 2);
  assert.equal(stats.favoriteModel?.id, "a");
  assert.equal(stats.favoriteModel?.share, Math.round((800 / 1100) * 100));
  assert.equal(stats.currentStreak, 1);
  assert.deepEqual(
    stats.days.map((d) => d.date),
    ["2020-01-01", today()],
  );
});
