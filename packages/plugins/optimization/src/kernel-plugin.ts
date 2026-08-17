/**
 * Kernel-plugin wrapper for the semantic optimization stack — the reference
 * example of a code-level Deyin plugin: one PluginDefinition, one service
 * seam, config from plugin rows, lifecycle owned by the kernel.
 */
import { defineService, type PluginDefinition } from "@deyin/extension-api";
import { createOptimizationPlugin, type CreateOptimizationPluginOptions, type OptimizationPlugin } from "./index.js";

/** The optimization seam: semantic caches + embeddings, resolved via ctx.get(Optimization). */
export const Optimization = defineService<OptimizationPlugin>(
  "optimization",
  "semantic tool-result and response caching",
);

/** Config-row shape for the optimization plugin. */
export interface OptimizationPluginConfig extends CreateOptimizationPluginOptions {}

export const optimizationPluginDef: PluginDefinition<OptimizationPluginConfig> = {
  name: "@deyin/plugin-optimization",
  provides: ["optimization"],
  // Heavy (ONNX embeddings + cache DBs): stays dormant until the host emits
  // "optimization:activate" (settings toggle) or calls activatePlugin().
  activateOn: ["optimization:activate"],
  apply: async (ctx, config) => {
    if (!config?.dataDir) {
      throw new Error('optimization plugin requires config: { dataDir: string }');
    }
    const impl = await createOptimizationPlugin(config);
    ctx.provide(Optimization, impl);
    ctx.effect(() => {
      impl.dispose();
    });
  },
};
