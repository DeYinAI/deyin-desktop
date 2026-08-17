/**
 * OpenAI-compatible chat-completions adapter plugin. The implementation is
 * agent-core's dispatcher (which owns the SSE/chat-completions path, DeepSeek
 * auto-continuations, and prompt-cache routing); this plugin makes the format
 * explicitly owned by a row that config can replace.
 */
import type { PluginDefinition } from "@deyin/extension-api";
import { Llm } from "@deyin/llm";
import { streamChatEvents } from "@deyin/agent-core";

export const llmOpenaiPlugin: PluginDefinition = {
  name: "@deyin/plugin-llm-openai",
  inject: ["llm"],
  apply: (ctx) => {
    ctx.get(Llm).register("chat-completions", (opts) => streamChatEvents(opts), "@deyin/plugin-llm-openai");
  },
};
