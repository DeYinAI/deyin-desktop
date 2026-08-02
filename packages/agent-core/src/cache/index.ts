/**
 * Cache stability module - Deyin agent inspired prefix cache optimization
 */

export {
  buildPromptCacheKey,
  canonicalizeToolSchemas,
  comparePrefixShapes,
  computePrefixShape,
  hashSystemPrompt,
  hashToolSchemas,
  shouldBumpLogRewriteVersion,
  type CacheDiagnostics,
  type PrefixShape,
} from "./prefix-tracker.js";
