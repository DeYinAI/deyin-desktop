/**
 * Session-level optimization metrics (compression + provider prompt-cache savings).
 * Semantic cache stats live in @deyin/optimization-plugin when installed.
 */

export interface OptimizationMetrics {
  originalInputTokens: number;
  compressedInputTokens: number;
  compressionRatio: number;
  cachedPromptTokens: number;
  toolCacheHits: number;
  toolCacheMisses: number;
  responseCacheHits: number;
  responseCacheMisses: number;
  estimatedCostSavingsUsd: number;
}

export function emptyOptimizationMetrics(): OptimizationMetrics {
  return {
    originalInputTokens: 0,
    compressedInputTokens: 0,
    compressionRatio: 1,
    cachedPromptTokens: 0,
    toolCacheHits: 0,
    toolCacheMisses: 0,
    responseCacheHits: 0,
    responseCacheMisses: 0,
    estimatedCostSavingsUsd: 0,
  };
}

/** Rough blended input cost ($/MTok) for savings estimates — display only. */
const DEFAULT_INPUT_COST_PER_MTOK = 3;

export class OptimizationTracker {
  private metrics = emptyOptimizationMetrics();

  get(): OptimizationMetrics {
    const m = { ...this.metrics };
    m.compressionRatio =
      m.originalInputTokens === 0 ? 1 : m.compressedInputTokens / m.originalInputTokens;
    const tokensSaved = Math.max(0, m.originalInputTokens - m.compressedInputTokens) + m.cachedPromptTokens * 0.5;
    m.estimatedCostSavingsUsd = (tokensSaved / 1_000_000) * DEFAULT_INPUT_COST_PER_MTOK;
    return m;
  }

  /**
   * Accumulate compression stats from one agent step. `buildWireMessages`
   * reports per-request totals (the whole transcript sent on that step),
   * and each step is a separate billable LLM call, so we accumulate across
   * steps — the totals reflect tokens sent (and saved) across all requests
   * in the run, not the size of the final transcript. The compressionRatio
   * is the weighted average across requests, not a per-step snapshot.
   */
  recordCompression(originalTokens: number, compressedTokens: number): void {
    this.metrics.originalInputTokens += Math.max(0, originalTokens);
    this.metrics.compressedInputTokens += Math.max(0, compressedTokens);
  }

  recordCachedPromptTokens(n: number): void {
    this.metrics.cachedPromptTokens += Math.max(0, n);
  }

  recordToolCache(hit: boolean): void {
    if (hit) this.metrics.toolCacheHits += 1;
    else this.metrics.toolCacheMisses += 1;
  }

  recordResponseCache(hit: boolean): void {
    if (hit) this.metrics.responseCacheHits += 1;
    else this.metrics.responseCacheMisses += 1;
  }

  reset(): void {
    this.metrics = emptyOptimizationMetrics();
  }
}
