/**
 * @deyin/bundle-base — the layer every Deyin host starts from: the tools
 * catalog + all built-in tool families, the llm seam + wire adapters, and
 * the (lazy) optimization plugin. Profiles patch this layer; user and
 * workspace layers patch both. Composition lives here so a running process
 * is configuration, not import lists.
 */
import type { ConfigLayer, PluginDefinition } from "@deyin/extension-api";
import type { PluginKernel } from "@deyin/kernel";
import { toolCatalogPlugin, Tools } from "@deyin/tools";
import { toolsFsPlugin } from "@deyin/plugin-tools-fs";
import { toolsShellPlugin } from "@deyin/plugin-tools-shell";
import { toolsGitPlugin } from "@deyin/plugin-tools-git";
import { toolsWebPlugin } from "@deyin/plugin-tools-web";
import { toolsPlanPlugin } from "@deyin/plugin-tools-plan";
import { toolsAgentPlugin } from "@deyin/plugin-tools-agent";
import { toolsImagePlugin } from "@deyin/plugin-tools-image";
import { llmPlugin, Llm } from "@deyin/llm";
import { llmOpenaiPlugin } from "@deyin/plugin-llm-openai";
import { llmResponsesPlugin } from "@deyin/plugin-llm-responses";
import { llmAnthropicPlugin } from "@deyin/plugin-llm-anthropic";
import { optimizationPluginDef } from "@deyin/optimization-plugin";

/** Every definition the base layer references, in registration-safe order. */
export const BASE_PLUGIN_DEFS: readonly PluginDefinition[] = [
  toolCatalogPlugin,
  toolsFsPlugin,
  toolsShellPlugin,
  toolsGitPlugin,
  toolsWebPlugin,
  toolsPlanPlugin,
  toolsAgentPlugin,
  toolsImagePlugin,
  llmPlugin,
  llmOpenaiPlugin,
  llmResponsesPlugin,
  llmAnthropicPlugin,
  optimizationPluginDef,
];

/** Register every base definition on a kernel. */
export function registerBasePlugins(kernel: PluginKernel): PluginKernel {
  for (const def of BASE_PLUGIN_DEFS) kernel.register(def);
  return kernel;
}

export { Tools, toolCatalogPlugin, Llm, llmPlugin };

export const bundleBase: ConfigLayer = {
  name: "bundle:base",
  rows: [
    { id: "tools-catalog", plugin: toolCatalogPlugin.name },
    { id: "tools-fs", plugin: toolsFsPlugin.name },
    { id: "tools-shell", plugin: toolsShellPlugin.name },
    { id: "tools-git", plugin: toolsGitPlugin.name },
    { id: "tools-web", plugin: toolsWebPlugin.name },
    { id: "tools-plan", plugin: toolsPlanPlugin.name },
    { id: "tools-agent", plugin: toolsAgentPlugin.name },
    { id: "tools-image", plugin: toolsImagePlugin.name },
    { id: "llm", plugin: llmPlugin.name },
    { id: "llm-openai", plugin: llmOpenaiPlugin.name },
    { id: "llm-responses", plugin: llmResponsesPlugin.name },
    { id: "llm-anthropic", plugin: llmAnthropicPlugin.name },
    // Dormant until the host activates it (settings toggle) — config arrives
    // from the profile layer because dataDir is host-specific.
    { id: "optimization", plugin: optimizationPluginDef.name },
  ],
};
