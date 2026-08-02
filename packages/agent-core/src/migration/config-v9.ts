/**
 * CLI config v9 — planner model and scheduler settings for Reasonix integration.
 */

import type { DeyinCliConfigFile, ResolvedCliConfig } from "../config.js";

/** Config schema version tracked in resolved config sources. */
export const CLI_CONFIG_SCHEMA_VERSION = 9;

export interface SchedulerConfigFile {
  maxSubagentConcurrency?: number;
  maxParallelWriters?: number;
}

/** Extended config file shape (v9). */
export interface DeyinCliConfigFileV9 extends DeyinCliConfigFile {
  plannerModel?: string | null;
  scheduler?: SchedulerConfigFile;
}

export interface ResolvedCliConfigV9 extends ResolvedCliConfig {
  plannerModel: string | null;
  maxSubagentConcurrency: number;
  maxParallelWriters: number;
  configSchemaVersion: number;
}

const DEFAULT_MAX_SUBAGENT = 6;
const DEFAULT_MAX_WRITERS = 3;

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, v));
}

/** Upgrade raw config layers to v9 with planner + scheduler fields. */
export function migrateCliConfigV9(resolved: ResolvedCliConfig, rawLayers: DeyinCliConfigFileV9[] = []): ResolvedCliConfigV9 {
  let plannerModel: string | null = null;
  let maxSubagentConcurrency = DEFAULT_MAX_SUBAGENT;
  let maxParallelWriters = DEFAULT_MAX_WRITERS;

  for (const layer of rawLayers) {
    if (layer.plannerModel !== undefined) {
      plannerModel = layer.plannerModel === null ? null : String(layer.plannerModel);
    }
    if (layer.scheduler?.maxSubagentConcurrency !== undefined) {
      maxSubagentConcurrency = clamp(layer.scheduler.maxSubagentConcurrency, 1, 32, DEFAULT_MAX_SUBAGENT);
    }
    if (layer.scheduler?.maxParallelWriters !== undefined) {
      maxParallelWriters = clamp(layer.scheduler.maxParallelWriters, 1, 32, DEFAULT_MAX_WRITERS);
    }
    // Flat keys for convenience.
    const flat = layer as DeyinCliConfigFileV9 & { maxSubagentConcurrency?: number; maxParallelWriters?: number };
    if (flat.maxSubagentConcurrency !== undefined) {
      maxSubagentConcurrency = clamp(flat.maxSubagentConcurrency, 1, 32, DEFAULT_MAX_SUBAGENT);
    }
    if (flat.maxParallelWriters !== undefined) {
      maxParallelWriters = clamp(flat.maxParallelWriters, 1, 32, DEFAULT_MAX_WRITERS);
    }
  }

  if (maxParallelWriters > maxSubagentConcurrency) {
    maxParallelWriters = maxSubagentConcurrency;
  }

  return {
    ...resolved,
    plannerModel,
    maxSubagentConcurrency,
    maxParallelWriters,
    configSchemaVersion: CLI_CONFIG_SCHEMA_VERSION,
  };
}

/** Patch object for writing upgraded deyin.json. */
export function configV9Patch(from: ResolvedCliConfigV9): DeyinCliConfigFileV9 {
  return {
    plannerModel: from.plannerModel,
    scheduler: {
      maxSubagentConcurrency: from.maxSubagentConcurrency,
      maxParallelWriters: from.maxParallelWriters,
    },
  };
}
