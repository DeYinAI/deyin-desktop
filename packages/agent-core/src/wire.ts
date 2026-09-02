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
  /**
   * How many messages the PREVIOUS request carried.
   *
   * Anthropic writes a cache entry only at a breakpoint and then looks backward
   * at most 20 block positions for one. A single trailing breakpoint therefore
   * misses whenever a turn appends more than that, so we also mark the position
   * the last request ended at — the one place an entry is guaranteed to exist.
   * Omit it on the first request of a session.
   */
  previousMessageCount?: number;
}

/** Cache TTLs. The static prefix is worth the 2x write to survive idle gaps. */
const STATIC_CACHE_CONTROL = { type: "ephemeral", ttl: "1h" } as const;
const ROLLING_CACHE_CONTROL = { type: "ephemeral" } as const;

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
    // Static breakpoint on the last system block (tools + rules + skills). This
    // prefix never changes within a session, so it gets the 1h TTL: 2x on a
    // single write, in exchange for surviving the idle gaps that dominate a
    // desktop session (reading a diff, answering a permission prompt).
    system[system.length - 1] = { ...system[system.length - 1]!, cache_control: STATIC_CACHE_CONTROL };
  }

  // Conversation messages, coalescing consecutive same-role turns.
  const merged: Array<{ role: "user" | "assistant"; blocks: Record<string, unknown>[] }> = [];
  const push = (role: "user" | "assistant", block: Record<string, unknown>): void => {
    const last = merged[merged.length - 1];
    if (last && last.role === role) last.blocks.push(block);
    else merged.push({ role, blocks: [block] });
  };
  /** Last emitted block position per source message index, for the rolling breakpoint. */
  const positionOf = new Map<number, { group: number; block: number }>();
  const markPosition = (index: number): void => {
    const group = merged.length - 1;
    if (group < 0) return;
    positionOf.set(index, { group, block: merged[group]!.blocks.length - 1 });
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
    markPosition(i);
  }

  if (enablePromptCaching && merged.length > 0) {
    const mark = (pos: { group: number; block: number } | undefined): void => {
      const group = pos && merged[pos.group];
      const block = group?.blocks[pos!.block];
      if (!group || !block || block.cache_control) return;
      group.blocks[pos!.block] = { ...block, cache_control: ROLLING_CACHE_CONTROL };
    };
    // Rolling breakpoint at the position the previous request ended, so the
    // lookback always finds an entry an earlier request actually wrote — even
    // when this turn appended more than the 20-position window.
    if (options.previousMessageCount !== undefined) {
      mark(positionOf.get(options.previousMessageCount - 1));
    }
    // Rolling breakpoint at the end of this request, which becomes the previous
    // one's anchor next time round.
    mark({ group: merged.length - 1, block: merged[merged.length - 1]!.blocks.length - 1 });
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

  const useAnthropicCache = enablePromptCaching && provider === "anthropic";
  /**
   * The static breakpoint goes on the LAST LEADING system message, not the last
   * system message anywhere in the transcript. Mid-conversation `role: "system"`
   * reminders are appended as the session goes on, so keying on the latter made
   * the marker wander deeper into the conversation every time one landed —
   * moving the breakpoint is exactly what a prefix cache cannot tolerate.
   */
  let staticSystemIndex = -1;
  for (let i = 0; i < messages.length && messages[i]!.role === "system"; i++) staticSystemIndex = i;

  const wire = messages.map((m, index) => {
    switch (m.role) {
      case "system": {
        const content = compress(m.content, "message");
        if (useAnthropicCache && index === staticSystemIndex && content.length > 0) {
          return {
            role: "system",
            content: [{ type: "text", text: content, cache_control: STATIC_CACHE_CONTROL }],
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

  // Rolling conversation breakpoints, the same pair the native Anthropic path
  // places: one where the previous request ended (an entry is guaranteed to
  // exist there) and one at the end of this one. Without these the growing
  // conversation was never cached at all on this path — only the system block.
  if (useAnthropicCache) {
    const requested: number[] = [];
    if (options.previousMessageCount !== undefined) {
      requested.push(options.previousMessageCount - 1);
    }
    requested.push(messages.length - 1);
    const positions = new Set<number>();
    for (const index of requested) {
      if (index <= staticSystemIndex || index >= wire.length) continue;
      // Walk back off tool-call-only turns, which cannot carry a marker.
      const target = markablePositionAtOrBefore(wire, index, staticSystemIndex);
      if (target >= 0) positions.add(target);
    }
    for (const index of positions) {
      wire[index] = withRollingCacheControl(wire[index]!);
    }
  }

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

/**
 * Attach a rolling breakpoint to an OpenAI-shaped message, promoting plain
 * string content to the block form Anthropic-compatible gateways require.
 * Assistant turns whose content is null (tool-call-only) carry the marker on
 * their last tool call instead, since there is no content block to mark.
 */
function withRollingCacheControl(message: Record<string, unknown>): Record<string, unknown> {
  const content = message.content;
  if (typeof content === "string" && content.length > 0) {
    return { ...message, content: [{ type: "text", text: content, cache_control: ROLLING_CACHE_CONTROL }] };
  }
  if (Array.isArray(content) && content.length > 0) {
    const blocks = [...(content as Record<string, unknown>[])];
    const last = blocks[blocks.length - 1]!;
    if (last.cache_control) return message;
    blocks[blocks.length - 1] = { ...last, cache_control: ROLLING_CACHE_CONTROL };
    return { ...message, content: blocks };
  }

  return message;
}

/**
 * Can this message carry a rolling breakpoint at all?
 *
 * Tool-call-only assistant turns are sent as `content: null` with an OpenAI
 * `tool_calls` array. There is no content block to mark, and hanging
 * `cache_control` off a `tool_calls` entry invents a wire shape gateways are
 * entitled to reject. So such a message is simply not markable.
 */
function canCarryRollingBreakpoint(message: Record<string, unknown> | undefined): boolean {
  if (!message) return false;
  const content = message.content;
  if (typeof content === "string") return content.length > 0;
  return Array.isArray(content) && content.length > 0;
}

/**
 * The nearest markable position at or before `index`, or -1 if there is none
 * above the static system breakpoint.
 *
 * An agent step almost always ENDS on a tool-call-only assistant turn, so
 * without this walk-back both rolling breakpoints silently vanish exactly when
 * they matter most — which is the 20-position lookback failing for the very
 * case it was added to protect. Landing the marker one or two messages earlier
 * caches marginally less; landing it nowhere caches nothing.
 */
function markablePositionAtOrBefore(
  wire: readonly Record<string, unknown>[],
  index: number,
  floor: number,
): number {
  for (let i = Math.min(index, wire.length - 1); i > floor; i--) {
    if (canCarryRollingBreakpoint(wire[i])) return i;
  }
  return -1;
}
