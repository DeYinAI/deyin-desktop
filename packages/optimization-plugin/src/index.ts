import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { EmbeddingService } from "./embeddings.js";
import {
  afterAgentRun,
  afterToolExecution,
  beforeAgentRun,
  beforeToolExecution,
  onWorkspaceFileChanged,
  type OptimizationHooksConfig,
  type OptimizationRuntime,
} from "./hooks.js";
import { ResponseCache } from "./response-cache.js";
import { ToolResultCache } from "./tool-cache.js";

export { EmbeddingService, cosineSimilarity, HashEmbeddingBackend } from "./embeddings.js";
export { ToolResultCache } from "./tool-cache.js";
export type { CacheConfig, CacheEntry, CacheStats } from "./tool-cache.js";
export { ResponseCache } from "./response-cache.js";
export type { CachedResponse, ResponseCacheStats } from "./response-cache.js";
export {
 beforeAgentRun,
 afterAgentRun,
 beforeToolExecution,
 afterToolExecution,
 onWorkspaceFileChanged,
} from "./hooks.js";
export type { OptimizationHooksConfig, OptimizationRuntime, ResponseCacheContext } from "./hooks.js";

export interface CreateOptimizationPluginOptions {
  /** Root for plugin data (models + caches), typically userData/plugins/optimization */
  dataDir: string;
  /** Optional override for model directory (defaults to dataDir/models or package models/) */
  modelDir?: string;
  /** Packaged-app model dir (e.g. process.resourcesPath/optimization-models). */
  packagedModelDir?: string;
  enableToolCache?: boolean;
  enableResponseCache?: boolean;
  similarityThreshold?: number;
  cacheSize?: number;
  responseTtlMs?: number;
}

export interface OptimizationPlugin {
 runtime: OptimizationRuntime;
 embeddings: EmbeddingService;
 initialize(): Promise<{ backend: string; modelPresent: boolean }>;
 dispose(): void;
 stats(): {
 tool: ReturnType<ToolResultCache["getStats"]>;
 response: ReturnType<ResponseCache["getStats"]>;
 };
 beforeAgentRun: typeof beforeAgentRun;
 afterAgentRun: typeof afterAgentRun;
 beforeToolExecution: typeof beforeToolExecution;
 afterToolExecution: typeof afterToolExecution;
 onWorkspaceFileChanged: typeof onWorkspaceFileChanged;
 setSimilarityThreshold: (threshold: number) => void;
}

export async function createOptimizationPlugin(opts: CreateOptimizationPluginOptions): Promise<OptimizationPlugin> {
  const userModelDir = opts.modelDir ?? join(opts.dataDir, "models");
  // Candidate locations for a shipped DeYinAI Embedding ONNX, in priority order:
  //   1. userData override (user-downloaded model)
  //   2. packaged Electron extraResources (process.resourcesPath/optimization-models)
  //   3. bundled alongside this module (packages/optimization-plugin/models/)
  //   4. fallback to userData so initialize() can report modelPresent=false
  const hasOnnx = (dir: string | null | undefined) =>
    Boolean(dir && existsSync(join(dir, "deyinai-embedding.onnx")));
  const packaged = opts.packagedModelDir && hasOnnx(opts.packagedModelDir) ? opts.packagedModelDir : null;
  const bundledCandidates = [bundleDirFromImportMeta(), bundleDirFromDirname()];
  const bundledModelDir = bundledCandidates.find((d) => hasOnnx(d)) ?? null;
  const modelDir = hasOnnx(userModelDir)
    ? userModelDir
    : packaged ?? bundledModelDir ?? userModelDir;
  const embeddings = new EmbeddingService(modelDir);
  const init = await embeddings.initialize();

  const threshold = opts.similarityThreshold ?? 0.93;
  const toolCache = new ToolResultCache(
    {
      maxSize: opts.cacheSize ?? 1000,
      similarityThreshold: threshold,
      enableSemanticMatch: true,
    },
    embeddings,
  );

  const responseCache = new ResponseCache(join(opts.dataDir, "caches", "responses.db"), embeddings, {
    similarityThreshold: threshold,
    ttlMs: opts.responseTtlMs ?? 15 * 60 * 1000,
  });
  await responseCache.initialize();

  const config: OptimizationHooksConfig = {
    enableToolCache: opts.enableToolCache !== false,
    enableResponseCache: opts.enableResponseCache !== false,
  };

  const runtime: OptimizationRuntime = { toolCache, responseCache, config };

return {
 runtime,
 embeddings,
 async initialize() {
 return init;
 },
 dispose() {
 responseCache.close();
 embeddings.dispose();
 toolCache.clear();
 },
 stats() {
 return { tool: toolCache.getStats(), response: responseCache.getStats() };
 },
 beforeAgentRun: (r, q, w, ctx?) => beforeAgentRun(r, q, w, ctx),
 afterAgentRun: (r, q, resp, w, ctx?) => afterAgentRun(r, q, resp, w, ctx),
 beforeToolExecution: (r, c, a) => beforeToolExecution(r, c, a),
 afterToolExecution: (r, c, a, res, ok) => afterToolExecution(r, c, a, res, ok),
 onWorkspaceFileChanged: (r, p) => onWorkspaceFileChanged(r, p),
 setSimilarityThreshold: (threshold: number) => {
 toolCache.setSimilarityThreshold(threshold);
 responseCache.setSimilarityThreshold(threshold);
 },
 };
}

/** Convenience: bind hooks to a runtime for AgentRunOptions. */
export function bindAgentCacheHooks(plugin: OptimizationPlugin) {
  return {
    lookupToolCache: async (call: { name: string; id: string; arguments: string }, args: Record<string, unknown>) => {
      if (!plugin.runtime.config.enableToolCache) return null;
      return plugin.beforeToolExecution(plugin.runtime, call, args);
    },
    storeToolCache: async (call: { name: string; id: string; arguments: string }, args: Record<string, unknown>, result: string) => {
      await plugin.afterToolExecution(plugin.runtime, call, args, result, true);
    },
  };
}

/**
 * Resolve a bundled `models/` directory relative to this module. When run
 * from source (or tsx), `import.meta.url` points at `src/index.ts` and
 * `../models` lands on `packages/optimization-plugin/models`. When bundled
 * by Vite into `out/main/index.js`, this still resolves to a sibling
 * `models/` if one is shipped next to the bundle.
 */
function bundleDirFromImportMeta(): string | null {
  try {
    const here = typeof __filename !== "undefined"
      ? __filename
      : fileURLToPath(import.meta.url);
    return join(dirname(here), "..", "models");
  } catch {
    return null;
  }
}

/**
 * Fallback for CJS contexts: `require.resolve` the package and walk up to
 * its `models/` directory. Used when `import.meta.url` is unavailable
 * (e.g. some bundlers strip it) and the plugin is loaded via `require`.
 */
function bundleDirFromDirname(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve("@deyin/optimization-plugin/package.json");
    return join(dirname(pkgJsonPath), "models");
  } catch {
    return null;
  }
}
