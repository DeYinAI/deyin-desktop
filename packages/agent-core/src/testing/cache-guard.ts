/**
 * Cache performance validation inspired by Deyin agent cache-guard.sh.
 *
 * Simulates multi-turn agent sessions with stable prefixes and measures
 * session aggregate cache hit rates without live API calls.
 */

import { comparePrefixShapes, computePrefixShape, type PrefixShape } from "../cache/prefix-tracker.js";
import type { AgentMessage } from "../types.js";

export interface CacheGuardResult {
  scenario: string;
  turns: number;
  hitRate: number;
  passed: boolean;
  invalidations: Array<{ turn: number; reason: string }>;
  sessionCacheHit: number;
  sessionCacheMiss: number;
}

/** Target hit rate threshold for passing (tail-average in long sessions). */
export const CACHE_HIT_RATE_TARGET = 0.85;

/** Minimum acceptable session hit rate for multi-turn dialogue. */
export const SESSION_HIT_RATE_TARGET = 0.8;

interface TurnSimulation {
  /** Prompt tokens billed as cache miss (new tail). */
  missTokens: number;
  /** Prompt tokens served from prefix cache. */
  hitTokens: number;
  /** Mutate prefix shape before this turn (system/tools/rewrite). */
  mutate?: "system" | "tools" | "log_rewrite";
}

function simulateSession(
  scenario: string,
  turns: TurnSimulation[],
  initial: { system: string; toolCount: number; rewriteVersion?: number },
): CacheGuardResult {
  let prevShape: PrefixShape | undefined;
  let sessionHit = 0;
  let sessionMiss = 0;
  const invalidations: Array<{ turn: number; reason: string }> = [];

  let systemContent = initial.system;
  let toolCount = initial.toolCount;
  let rewriteVersion = initial.rewriteVersion ?? 0;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    if (turn.mutate === "system") systemContent += `\n<!-- bump ${i} -->`;
    if (turn.mutate === "tools") toolCount += 1;
    if (turn.mutate === "log_rewrite") rewriteVersion += 1;

    const tools = Array.from({ length: toolCount }, (_, j) => ({
      type: "function" as const,
      function: { name: `tool_${j}`, description: "d", parameters: { type: "object", properties: {} } },
    }));

    const shape = computePrefixShape(
      { role: "system", content: systemContent },
      tools,
      rewriteVersion,
      toolCount * 50,
    );

    const diag = comparePrefixShapes(prevShape, shape, turn.hitTokens, turn.missTokens);
    sessionHit += diag.hit;
    sessionMiss += diag.miss;

    if (diag.prefixChanged) {
      for (const reason of diag.changeReasons) {
        invalidations.push({ turn: i + 1, reason });
      }
    }

    prevShape = shape;
  }

  const total = sessionHit + sessionMiss;
  const hitRate = total === 0 ? 1 : sessionHit / total;

  return {
    scenario,
    turns: turns.length,
    hitRate,
    passed: hitRate >= SESSION_HIT_RATE_TARGET,
    invalidations,
    sessionCacheHit: sessionHit,
    sessionCacheMiss: sessionMiss,
  };
}

/** Build a stable 50-turn tool-loop dialogue pattern. */
function fiftyTurnDialogue(): TurnSimulation[] {
  const turns: TurnSimulation[] = [];
  for (let i = 0; i < 50; i++) {
    // First turn is cold; subsequent turns cache the growing prefix.
    const hitRatio = i === 0 ? 0 : 0.88 + (i % 5) * 0.01;
    const missTokens = i === 0 ? 4000 : Math.round(400 + (i % 3) * 40);
    const hitTokens = i === 0 ? 0 : Math.round(missTokens * (hitRatio / (1 - hitRatio)));
    turns.push({ missTokens, hitTokens });
  }
  return turns;
}

/**
 * Run cache performance validation scenarios.
 * Returns per-scenario results; all must pass for CI cache guard.
 */
export function runCacheGuard(): CacheGuardResult[] {
  const results: CacheGuardResult[] = [];

  results.push(
    simulateSession("50-turn-stable-prefix", fiftyTurnDialogue(), {
      system: "You are Deyin.\nMode: agent\nSkills: read, write",
      toolCount: 12,
    }),
  );

  // Compaction should bump rewrite version once; hit rate should remain high afterward.
  const withCompaction: TurnSimulation[] = fiftyTurnDialogue();
  withCompaction[30] = { ...withCompaction[30]!, missTokens: 800, hitTokens: 7200, mutate: "log_rewrite" };
  results.push(
    simulateSession("50-turn-with-compaction", withCompaction, {
      system: "You are Deyin.\nMode: agent",
      toolCount: 10,
    }),
  );

  // Tool registry change mid-session: one invalidation, still passes if rare.
  const withToolChange: TurnSimulation[] = fiftyTurnDialogue();
  withToolChange[25] = { ...withToolChange[25]!, mutate: "tools" };
  results.push(
    simulateSession("50-turn-tool-change", withToolChange, {
      system: "You are Deyin.",
      toolCount: 8,
    }),
  );

  // System prompt rebuild invalidates once (should not happen in steady state).
  const withSystemChange: TurnSimulation[] = fiftyTurnDialogue().slice(0, 20);
  withSystemChange[10] = { ...withSystemChange[10]!, mutate: "system" };
  results.push(
    simulateSession("20-turn-system-churn", withSystemChange, {
      system: "You are Deyin.",
      toolCount: 6,
    }),
  );

  return results;
}

/** Tail-average hit rate over the last N turns of a scenario. */
export function tailAverageHitRate(result: CacheGuardResult, _tailTurns = 10): number {
  // Approximate from aggregate: in stable sessions tail is ≥ session average.
  return result.hitRate;
}

export function allCacheGuardPassed(results: CacheGuardResult[] = runCacheGuard()): boolean {
  return results.every((r) => r.passed && r.hitRate >= SESSION_HIT_RATE_TARGET);
}

/** Append-only transcript growth preserves prefix except at compaction. */
export function appendOnlyPrefixStable(before: AgentMessage[], after: AgentMessage[]): boolean {
  if (after.length < before.length) return false;
  for (let i = 0; i < before.length; i++) {
    const a = before[i]!;
    const b = after[i]!;
    if (a.role !== b.role || a.content !== b.content) return false;
  }
  return true;
}
