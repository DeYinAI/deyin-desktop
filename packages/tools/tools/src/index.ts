/**
 * @deyin/tools — the tools seam. A plugin-provided ToolCatalog collects the
 * tool families; hosts build one ToolRegistry per agent run from the catalog
 * plus run-specific tools (task, codebase-search), then filter per mode.
 * Consumers depend only on this seam — never on a tool family or on where a
 * tool is implemented.
 */
import { defineService, type PluginDefinition } from "@deyin/extension-api";
import { ToolRegistry, type ToolDefinition } from "@deyin/agent-core";

/** The catalog seam: families add tools; nothing removes them at runtime. */
export interface ToolCatalog {
  add(tools: ToolDefinition | ToolDefinition[]): void;
  all(): ToolDefinition[];
  names(): string[];
}

export function createToolCatalog(): ToolCatalog {
  const tools: ToolDefinition[] = [];
  return {
    add(incoming) {
      for (const tool of Array.isArray(incoming) ? incoming : [incoming]) {
        if (tools.some((t) => t.name === tool.name)) continue;
        tools.push(tool);
      }
    },
    all() {
      return [...tools];
    },
    names() {
      return tools.map((t) => t.name);
    },
  };
}

export const Tools = defineService<ToolCatalog>("tools", "tool catalog seam");

/** The catalog provider plugin — must load before any tool family. */
export const toolCatalogPlugin: PluginDefinition = {
  name: "@deyin/plugin-tools-catalog",
  provides: ["tools"],
  apply: (ctx) => {
    ctx.provide(Tools, createToolCatalog());
  },
};

/** Build a run registry from the catalog plus run-specific tools. */
export function buildToolRegistry(catalog: ToolCatalog, extra?: readonly ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of catalog.all()) registry.register(tool);
  for (const tool of extra ?? []) registry.register(tool);
  return registry;
}
