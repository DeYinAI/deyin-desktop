/** OpenAI Responses API adapter plugin (POST {base}/responses, SSE). */
import type { PluginDefinition } from "@deyin/extension-api";
import { Llm } from "@deyin/llm";
import { streamResponsesEvents } from "@deyin/agent-core";

export const llmResponsesPlugin: PluginDefinition = {
  name: "@deyin/plugin-llm-responses",
  inject: ["llm"],
  apply: (ctx) => {
    ctx.get(Llm).register("responses", (opts) => streamResponsesEvents(opts), "@deyin/plugin-llm-responses");
  },
};
