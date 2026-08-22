import { ContentCompressor, type CompressionMode, type CompressionResult } from "./compression.js";
import { countTokens } from "./tokenizer.js";
import type { AgentRunProviderHint } from "@deyin/host-core/shared";
import type { AgentMessage } from "./types.js";

/** Provider hint for wire cache markers (shared with host-core `resolveWireProvider`). */
export type PromptCacheProvider = AgentRunProviderHint;

export interface WireOptions {
 enableCompression?: boolean;
 compressionMode?: CompressionMode;
 enablePromptCaching?: boolean;
 /** Provider that receives cache markers. "openference" follows OpenAI-compatible shape. */
 provider?: PromptCacheProvider;
 /** Model id, used to detect DeepSeek wire quirks (reasoning_content replay). */
 model?: string;
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

/** Leading system messages, split for the Anthropic top-level `system` field. */
export interface AnthropicWireResult {
  /** Top-level system blocks (Anthropic has no role:"system" messages). */
  system: Record<string, unknown>[];
  /** User/assistant/tool messages with strictly alternating roles. */
  messages: Record<string, unknown>[];
  compression?: {
    originalTokens: number;
    compressedTokens: number;
    ratio: number;
    results: CompressionResult[];
  };
}

/**
 * Serialize the transcript into the Anthropic Messages API wire shape:
 * leading system messages become the top-level `system` blocks, tool results
 * become `tool_result` blocks inside user messages, assistant tool calls become
 * `tool_use` blocks, and consecutive same-role messages are coalesced (the API
 * requires strictly alternating user/assistant).
 *
 * Reasoning is NOT replayed as `thinking` blocks: native Anthropic requires the
 * signed block to continue extended thinking, and we never see signatures.
 * Cache breakpoints (`cache_control: {type:"ephemeral"}`) are placed on the
 * last system block and on the last block of the final message.
 */
export function toAnthropicMessages(messages: AgentMessage[], options: WireOptions = {}): AnthropicWireResult {
  const enableCompression = options.enableCompression === true;
  const mode = options.compressionMode ?? "balanced";
  const enablePromptCaching = options.enablePromptCaching !== false;
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

  // Top-level system: every leading system message, one text block each.
  const system: Record<string, unknown>[] = [];
  let i = 0;
  for (; i < messages.length && messages[i]!.role === "system"; i++) {
    const text = compress(messages[i]!.content, "message");
    if (text.length > 0) system.push({ type: "text", text });
  }
  if (enablePromptCaching && system.length > 0) {
    // Cache breakpoint on the last system block (stable prefix: tools + rules + skills).
    system[system.length - 1] = { ...system[system.length - 1]!, cache_control: { type: "ephemeral" } };
  }

  // Conversation messages, coalescing consecutive same-role turns.
  const merged: Array<{ role: "user" | "assistant"; blocks: Record<string, unknown>[] }> = [];
  const push = (role: "user" | "assistant", block: Record<string, unknown>): void => {
    const last = merged[merged.length - 1];
    if (last && last.role === role) last.blocks.push(block);
    else merged.push({ role, blocks: [block] });
  };

  for (; i < messages.length; i++) {
    const m = messages[i]!;
    switch (m.role) {
      case "system": {
        const text = compress(m.content, "message");
        if (text.length > 0) push("user", { type: "text", text });
        break;
      }
      case "user": {
        const text = compress(m.content, "message");
        if (text.length > 0 || (m.images?.length ?? 0) === 0) {
          push("user", { type: "text", text });
        }
        for (const img of m.images ?? []) {
          push("user", { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } });
        }
        break;
      }
      case "assistant": {
        if (m.content.length > 0) push("assistant", { type: "text", text: compress(m.content, "message") });
        for (const call of m.toolCalls ?? []) {
          let input: Record<string, unknown> = {};
          try {
            const parsed = call.arguments.trim() ? (JSON.parse(call.arguments) as unknown) : {};
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
          } catch {
            // Unparseable args still round-trip as a raw string so the loop can recover.
            input = { __raw_arguments: call.arguments };
          }
          push("assistant", { type: "tool_use", id: call.id, name: call.name, input });
        }
        break;
      }
      case "tool": {
        const text = compress(m.content, "tool", m.toolName);
        push("user", {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: text.length > 0 ? text : "(no output)",
        });
        break;
      }
    }
  }

  if (enablePromptCaching && merged.length > 0) {
    // Second breakpoint on the last block of the final message (conversation prefix).
    const last = merged[merged.length - 1]!;
    last.blocks[last.blocks.length - 1] = { ...last.blocks[last.blocks.length - 1]!, cache_control: { type: "ephemeral" } };
  }

  return {
    system,
    messages: merged.map((g) => ({ role: g.role, content: g.blocks })),
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

/** OpenAI Responses API input items plus the extracted `instructions` string. */
export interface ResponsesWireResult {
  /** First system message, sent as the top-level `instructions` field. */
  instructions?: string;
  /** `input` items: role items, reasoning, function_call, function_call_output. */
  input: Record<string, unknown>[];
  compression?: {
    originalTokens: number;
    compressedTokens: number;
    ratio: number;
    results: CompressionResult[];
  };
}

/**
 * Serialize the transcript into the OpenAI Responses API `input` item shape:
 * the first system message becomes `instructions`; assistant reasoning becomes
 * a `reasoning` item; tool calls become `function_call` items and tool results
 * `function_call_output` items keyed by `call_id`.
 */
export function toResponsesInput(messages: AgentMessage[], options: WireOptions = {}): ResponsesWireResult {
  const enableCompression = options.enableCompression === true;
  const mode = options.compressionMode ?? "balanced";
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

  let instructions: string | undefined;
  const input: Record<string, unknown>[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    switch (m.role) {
      case "system": {
        const text = compress(m.content, "message");
        if (i === 0) instructions = text;
        else if (text.length > 0) input.push({ role: "system", content: text });
        break;
      }
      case "user": {
        const text = compress(m.content, "message");
        if (m.images?.length) {
          input.push({
            role: "user",
            content: [
              { type: "input_text", text },
              ...m.images.map((img) => ({
                type: "input_image",
                image_url: `data:${img.mediaType};base64,${img.base64}`,
              })),
            ],
          });
        } else {
          input.push({ role: "user", content: text });
        }
        break;
      }
      case "assistant": {
        if (m.reasoning && m.reasoning.length > 0) {
          input.push({ type: "reasoning", content: [{ type: "reasoning_text", text: m.reasoning }] });
        }
        const hasToolCalls = (m.toolCalls?.length ?? 0) > 0;
        if (m.content.length > 0 || !hasToolCalls) {
          input.push({ role: "assistant", content: m.content });
        }
        for (const call of m.toolCalls ?? []) {
          input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
        }
        break;
      }
      case "tool":
        input.push({ type: "function_call_output", call_id: m.toolCallId, output: compress(m.content, "tool", m.toolName) });
        break;
    }
  }

  return {
    ...(instructions !== undefined ? { instructions } : {}),
    input,
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
      case "user": {
        const text = compress(m.content, "message");
        if (m.images?.length) {
          return {
            role: "user",
            content: [
              { type: "text", text },
              ...m.images.map((img) => ({
                type: "image_url",
                image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
              })),
            ],
          };
        }
        return { role: "user", content: text };
      }
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
          const isDeepSeek = provider === "deepseek" || (options.model ? /deepseek/i.test(options.model) : false);
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
