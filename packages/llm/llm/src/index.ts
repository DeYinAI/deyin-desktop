/**
 * @deyin/llm — the LLM adapter seam. Adapter plugins register a stream
 * factory per provider wire format; `resolve()` falls back to agent-core's
 * built-in dispatch, so a host with zero adapter plugins behaves exactly
 * like today. Swapping or adding a provider family (e.g. a proxy or a
 * test double) becomes configuration, not a code change.
 */
import { defineService, type PluginDefinition } from "@deyin/extension-api";
import {
  streamChatEvents,
  type ProviderApiFormat,
  type StreamChatEventsOptions,
  type StreamEvent,
} from "@deyin/agent-core";

export type LlmStreamFactory = (opts: StreamChatEventsOptions) => AsyncGenerator<StreamEvent>;

export interface LlmAdapters {
  /** Register the factory for a wire format; a second registration fails the plugin. */
  register(format: ProviderApiFormat, factory: LlmStreamFactory, pluginName?: string): void;
  has(format: ProviderApiFormat): boolean;
  formats(): ProviderApiFormat[];
  /**
   * Resolve a stream factory. Unknown/unregistered formats fall back to the
   * agent-core dispatcher, which handles all built-in formats.
   */
  resolve(format?: ProviderApiFormat): LlmStreamFactory;
}

export function createLlmAdapters(): LlmAdapters {
  const byFormat = new Map<ProviderApiFormat, LlmStreamFactory>();
  return {
    register(format, factory, pluginName) {
      if (byFormat.has(format)) {
        throw new Error(`llm adapter for "${format}" is already registered${pluginName ? ` by "${pluginName}"` : ""}`);
      }
      byFormat.set(format, factory);
    },
    has(format) {
      return byFormat.has(format);
    },
    formats() {
      return [...byFormat.keys()];
    },
    resolve(format) {
      const factory = format ? byFormat.get(format) : undefined;
      if (factory) return factory;
      return (opts) => streamChatEvents(format ? { ...opts, apiFormat: format } : opts);
    },
  };
}

export const Llm = defineService<LlmAdapters>("llm", "llm adapter seam");

/** The adapter-registry provider plugin — must load before any adapter plugin. */
export const llmPlugin: PluginDefinition = {
  name: "@deyin/plugin-llm",
  provides: ["llm"],
  apply: (ctx) => {
    ctx.provide(Llm, createLlmAdapters());
  },
};
