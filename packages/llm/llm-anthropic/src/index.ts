/** Anthropic Messages API adapter plugin (x-api-key or Bearer, /v1/messages). */
import type { PluginDefinition } from "@deyin/extension-api";
import { Llm } from "@deyin/llm";
import { streamAnthropicEvents } from "@deyin/agent-core";

export const llmAnthropicPlugin: PluginDefinition = {
  name: "@deyin/plugin-llm-anthropic",
  inject: ["llm"],
  apply: (ctx) => {
    ctx.get(Llm).register("anthropic", (opts) => streamAnthropicEvents(opts), "@deyin/plugin-llm-anthropic");
  },
};
