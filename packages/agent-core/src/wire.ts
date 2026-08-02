import { ContentCompressor, type CompressionMode, type CompressionResult } from "./compression.js";
import { countTokens } from "./tokenizer.js";
import type { AgentMessage } from "./types.js";

export type PromptCacheProvider = "openai" | "anthropic" | "openference" | "auto";

export interface WireOptions {
 enableCompression?: boolean;
 compressionMode?: CompressionMode;
 enablePromptCaching?: boolean;
 /** Provider that receives cache markers. "openference" follows OpenAI-compatible shape. */
 provider?: PromptCacheProvider;
 /** Stable key shared across agent steps for OpenAI-style prompt caching. */
 promptCacheKey?: string;
}

export interface WireBuildResult {
 messages: Record<string, unknown>[];
 compression?: {
 originalTokens: number;
 compressedTokens: number;
 ratio: number;
 results: CompressionResult[];
 };
}

export type { CompressionResult };

const compressor = new ContentCompressor();

function estimateTokens(text: string): number {
  return countTokens(text);
}

/**
 * Serialize the transcript into the OpenAI chat-completions wire format: assistant
 * tool calls become `tool_calls` entries and tool results become role:"tool" messages
 * keyed by `tool_call_id`.
 *
 * When compression is enabled, tool/user/system content is compressed before sending.
 * When prompt caching is enabled, stable prefixes (system) get cache markers for
 * Anthropic, while OpenAI/Openference rely on prefix stability + prompt_cache_key
 * (passed separately via stream options).
 */
export function toWireMessages(messages: AgentMessage[], options: WireOptions = {}): Record<string, unknown>[] {
  return buildWireMessages(messages, options).messages;
}

export function buildWireMessages(messages: AgentMessage[], options: WireOptions = {}): WireBuildResult {
  const enableCompression = options.enableCompression === true;
  const mode = options.compressionMode ?? "balanced";
  const enablePromptCaching = options.enablePromptCaching !== false;
  const provider = options.provider ?? "auto";
  const compressionResults: CompressionResult[] = [];
  let originalTokens = 0;
  let compressedTokens = 0;

  const compress = (text: string, kind: "tool" | "message", toolName?: string): string => {
    originalTokens += estimateTokens(text);
    if (!enableCompression || !text) {
      compressedTokens += estimateTokens(text);
      return text;
    }
    const res =
      kind === "tool"
        ? compressor.compressToolOutput(text, toolName ?? "tool", { mode, preserveErrors: true })
        : compressor.compressMessage(text, { mode });
    compressionResults.push(res);
    compressedTokens += estimateTokens(res.compressed);
    return res.compressed;
  };

  const useAnthropicCache = enablePromptCaching && (provider === "anthropic");
  let lastSystemIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "system") lastSystemIndex = i;
  }

  const wire = messages.map((m, index) => {
    switch (m.role) {
      case "system": {
        const content = compress(m.content, "message");
        if (useAnthropicCache && index === lastSystemIndex && content.length > 0) {
          // Anthropic-style cache breakpoint on the last system block (stable prefix).
          return {
            role: "system",
            content: [{ type: "text", text: content, cache_control: { type: "ephemeral" } }],
          };
        }
        return { role: "system", content };
      }
      case "user":
        return { role: "user", content: compress(m.content, "message") };
      case "assistant": {
        const hasToolCalls = m.toolCalls !== undefined && m.toolCalls.length > 0;
        const contentText = m.content.length > 0 ? compress(m.content, "message") : m.content;
        const wireMsg: Record<string, unknown> = {
          role: "assistant",
          // Tool-call-only turns: send null (providers reject empty strings there).
          // Empty turns without tool calls: send "" — `content: null` alone is
          // rejected by many providers and would poison every later request.
          content: contentText.length > 0 ? contentText : hasToolCalls ? null : "",
        };
        if (hasToolCalls) {
          wireMsg.tool_calls = m.toolCalls!.map((c) => ({
            id: c.id,
            type: "function",
            function: {
              name: c.name,
              // Do not compress tool-call arguments: providers validate against schemas
              // and the model must see the exact args it emitted.
              arguments: c.arguments,
            },
          }));
          
          // DeepSeek requires reasoning_content on assistant tool_calls turns when
          // replaying history. Missing it causes 400 errors and breaks prefix stability.
          // Send empty string if reasoning was never captured (graceful degradation).
          const isDeepSeek = provider === "openai" || provider === "openference";
          if (isDeepSeek && hasToolCalls) {
            wireMsg.reasoning_content = m.reasoning ?? "";
          }
        }
        return wireMsg;
      }
      case "tool":
        return {
          role: "tool",
          tool_call_id: m.toolCallId,
          content: compress(m.content, "tool", m.toolName),
        };
    }
  });

  return {
    messages: wire,
    compression: enableCompression
      ? {
          originalTokens,
          compressedTokens,
          ratio: originalTokens === 0 ? 1 : compressedTokens / originalTokens,
          results: compressionResults,
        }
      : undefined,
  };
}
