import type { UsageDay, UsageEvent, UsageStats } from "./types.js";

export const USAGE_KEEP_DAYS = 180;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Pure aggregation shared by desktop (file-backed), web (localStorage) and CLI stores. */
export function computeStats(days: UsageDay[]): UsageStats {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const byModel = new Map<string, number>();
  let totalTokens = 0;
  let messages = 0;
  let sessions = 0;
  for (const day of sorted) {
    messages += day.messages;
    sessions += day.sessions;
    for (const [model, tokens] of Object.entries(day.byModel)) {
      totalTokens += tokens;
      byModel.set(model, (byModel.get(model) ?? 0) + tokens);
    }
  }

  let favorite: { id: string; share: number } | null = null;
  for (const [id, tokens] of byModel) {
    if (!favorite || tokens > (byModel.get(favorite.id) ?? 0)) {
      favorite = { id, share: totalTokens > 0 ? Math.round((tokens / totalTokens) * 100) : 0 };
    }
  }

  // Current streak: consecutive days with activity ending today (or yesterday).
  const active = new Set(sorted.filter((d) => d.messages > 0 || Object.keys(d.byModel).length > 0).map((d) => d.date));
  let streak = 0;
  const cursor = new Date();
  if (!active.has(cursor.toISOString().slice(0, 10))) cursor.setDate(cursor.getDate() - 1);
  while (active.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return {
    totalTokens,
    sessions,
    messages,
    activeDays: active.size,
    currentStreak: streak,
    favoriteModel: favorite,
    days: sorted,
  };
}

/** Applies one usage event to the day list (mutates and returns the list). */
export function applyEvent(days: UsageDay[], event: UsageEvent): UsageDay[] {
  const key = todayKey();
  let day = days.find((d) => d.date === key);
  if (!day) {
    day = { date: key, byModel: {}, messages: 0, sessions: 0 };
    days.push(day);
  }
  day.byModel[event.model] = (day.byModel[event.model] ?? 0) + Math.max(0, Math.round(event.tokens));
  day.messages += 1;
  if (event.newSession) day.sessions += 1;

  days.sort((a, b) => a.date.localeCompare(b.date));
  return days.length > USAGE_KEEP_DAYS ? days.slice(days.length - USAGE_KEEP_DAYS) : days;
}
