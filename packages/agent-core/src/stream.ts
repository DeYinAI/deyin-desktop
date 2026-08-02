import type { AgentMessage, AgentToolCall, TokenUsage, WireTool } from "./types.js";
import { getDeepSeekBetaEndpoint, isDeepSeekEndpoint, shouldContinueResponse } from "./cache/deepseek.js";
import { buildWireMessages, type CompressionResult, type WireOptions } from "./wire.js";

export interface StreamChatEventsOptions {
 apiBaseUrl: string;
 token: string;
 model: string;
 messages: AgentMessage[];
 /** Declared tools; omitted from the request when empty so plain chat still works. */
 tools?: WireTool[];
 /** Request model reasoning ("thinking") when supported. */
 thinking?: boolean;
 temperature?: number;
 signal?: AbortSignal;
 /** Compression + Anthropic cache_control markers. */
 wire?: WireOptions;
 /** OpenAI / Openference prompt cache routing key. */
 promptCacheKey?: string;
  promptCacheOptions?: {
    mode?: "implicit" | "explicit";
    ttl?: string;
  };
  /** Max DeepSeek beta prefix continuations for truncated (length) responses. */
  maxContinuations?: number;
}

export type StreamEvent =
 | { type: "text"; delta: string }
 | { type: "reasoning"; delta: string }
 | {
 type: "done";
 content: string;
 reasoning: string;
 toolCalls: AgentToolCall[];
      finishReason: string | null;
      usage: TokenUsage | null;
      continuations?: number;
      compression?: {
 originalTokens: number;
 compressedTokens: number;
 ratio: number;
 results: CompressionResult[];
 };
 };

interface WireDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: {
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface WireChunk {
  choices?: { delta?: WireDelta; finish_reason?: string | null }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cache_read_input_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  } | null;
}

const DEFAULT_MAX_CONTINUATIONS = 3;

/** Fold usage from multiple requests (initial + beta continuations). */
export function foldTokenUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedPromptTokens: (a.cachedPromptTokens ?? 0) + (b.cachedPromptTokens ?? 0),
  };
}

function parseUsage(raw: WireChunk["usage"]): TokenUsage | null {
  if (!raw) return null;
  const cached =
    raw.prompt_tokens_details?.cached_tokens ??
    raw.cache_read_input_tokens ??
    raw.prompt_cache_hit_tokens;
  return {
    promptTokens: raw.prompt_tokens ?? 0,
    completionTokens: raw.completion_tokens ?? 0,
    totalTokens: raw.total_tokens ?? (raw.prompt_tokens ?? 0) + (raw.completion_tokens ?? 0),
    ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
  };
}

function canContinueTruncated(done: Extract<StreamEvent, { type: "done" }>): boolean {
  return (
    shouldContinueResponse(done.finishReason ?? undefined) &&
    done.toolCalls.length === 0 &&
    (done.content.length > 0 || done.reasoning.length > 0)
  );
}

function mergeDoneEvents(
  first: Extract<StreamEvent, { type: "done" }>,
  second: Extract<StreamEvent, { type: "done" }>,
  continuations: number,
): Extract<StreamEvent, { type: "done" }> {
  return {
    type: "done",
    content: first.content + second.content,
    reasoning: first.reasoning + second.reasoning,
    toolCalls: second.toolCalls.length > 0 ? second.toolCalls : first.toolCalls,
    finishReason: second.finishReason,
    usage: foldTokenUsage(first.usage, second.usage),
    continuations,
    ...(first.compression ? { compression: first.compression } : {}),
  };
}

function buildPrefixAssistantMessage(done: Extract<StreamEvent, { type: "done" }>): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    role: "assistant",
    content: done.content,
    prefix: true,
  };
  if (done.reasoning.length > 0) msg.reasoning_content = done.reasoning;
  return msg;
}

/**
 * Stream a chat completion, accumulating fragmented `tool_calls` deltas (ids, names and
 * argument JSON arrive split across many SSE chunks) and the final `finish_reason`.
 * Yields text/reasoning deltas as they arrive and exactly one final "done" event.
 *
 * When DeepSeek returns finish_reason "length", automatically continues via the beta
 * prefix endpoint and folds usage from both requests.
 */
export async function* streamChatEvents(opts: StreamChatEventsOptions): AsyncGenerator<StreamEvent> {
  const maxContinuations = opts.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;
  let pending: Extract<StreamEvent, { type: "done" }> | null = null;
  let continuations = 0;

  while (true) {
    const isContinuation = pending !== null;
    const built = buildWireMessages(opts.messages, opts.wire ?? {});
    const wireMessages = [...built.messages];
    if (isContinuation && pending) {
      wireMessages.push(buildPrefixAssistantMessage(pending));
    }

    const chatUrl = `${opts.apiBaseUrl.replace(/\/$/, "")}/chat/completions`;
    const requestUrl =
      isContinuation && isDeepSeekEndpoint(opts.apiBaseUrl)
        ? getDeepSeekBetaEndpoint(chatUrl) ?? chatUrl
        : chatUrl;

    const body: Record<string, unknown> = {
      model: opts.model,
      messages: wireMessages,
      stream: true,
    };
    if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;
    if (opts.thinking !== undefined) body.reasoning = { enabled: opts.thinking };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.promptCacheKey) body.prompt_cache_key = opts.promptCacheKey;
    if (opts.promptCacheOptions) body.prompt_cache_options = opts.promptCacheOptions;

    const res = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Chat request failed (${res.status}). ${detail}`.trim().slice(0, 2000));
    }

    const parser = new StreamAccumulator(built.compression);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parser.push(line);
        if (!event) continue;
        if (event.type === "done") {
          sawDone = true;
          const doneEvent = event;
          const merged: Extract<StreamEvent, { type: "done" }> = pending
            ? mergeDoneEvents(pending, doneEvent, continuations)
            : doneEvent;
          const canContinue =
            isDeepSeekEndpoint(opts.apiBaseUrl) &&
            canContinueTruncated(merged) &&
            continuations < maxContinuations &&
            getDeepSeekBetaEndpoint(chatUrl) !== null;

          if (canContinue) {
            pending = merged;
            continuations += 1;
            break;
          }

          yield { ...merged, continuations: continuations > 0 ? continuations : undefined };
          return;
        }
        yield event;
      }
      if (sawDone) break;
    }

    if (!sawDone) {
      const finished: Extract<StreamEvent, { type: "done" }> = parser.finish();
      const merged: Extract<StreamEvent, { type: "done" }> = pending
        ? mergeDoneEvents(pending, finished, continuations)
        : finished;
      yield { ...merged, continuations: continuations > 0 ? continuations : undefined };
      return;
    }
  }
}

/** Fallback tool-call ids must be unique across the whole transcript: some providers
 * reject requests where two tool_calls share an id, and the loop runs many steps. */
let syntheticCallCounter = 0;

/**
 * Incremental SSE-chunk accumulator, exposed separately so it can be unit-tested
 * without a network. Feed raw SSE lines; get stream events back.
 */
export class StreamAccumulator {
 private content = "";
 private reasoning = "";
 private finishReason: string | null = null;
 private usage: TokenUsage | null = null;
 private calls = new Map<number, { id: string; name: string; arguments: string }>();
 private nextImplicitIndex = 0;
 private readonly compression?: { originalTokens: number; compressedTokens: number; ratio: number; results: CompressionResult[] };

 constructor(compression?: { originalTokens: number; compressedTokens: number; ratio: number; results: CompressionResult[] }) {
 this.compression = compression;
 }

  /** Process one SSE line. Returns an event when the line produced one. */
  push(line: string): StreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return null;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return this.finish();

    let chunk: WireChunk;
    try {
      chunk = JSON.parse(payload) as WireChunk;
    } catch {
      return null; // keep-alives / malformed lines
    }

    if (chunk.usage) this.usage = parseUsage(chunk.usage);

    const choice = chunk.choices?.[0];
    if (!choice) return null;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;

    const delta = choice.delta;
    if (!delta) return null;

    for (const frag of delta.tool_calls ?? []) {
      // Most providers set index; when absent, a fragment with an id starts a new call.
      const index = frag.index ?? (frag.id ? this.nextImplicitIndex++ : Math.max(0, this.nextImplicitIndex - 1));
      let call = this.calls.get(index);
      if (!call) {
        call = { id: "", name: "", arguments: "" };
        this.calls.set(index, call);
        if (frag.index !== undefined) this.nextImplicitIndex = Math.max(this.nextImplicitIndex, index + 1);
      }
      if (frag.id) call.id = frag.id;
      if (frag.function?.name) call.name += frag.function.name;
      if (frag.function?.arguments) call.arguments += frag.function.arguments;
    }

    const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
    if (reasoningDelta) {
      this.reasoning += reasoningDelta;
      return { type: "reasoning", delta: reasoningDelta };
    }
    if (delta.content) {
      this.content += delta.content;
      return { type: "text", delta: delta.content };
    }
    return null;
  }

  finish(): Extract<StreamEvent, { type: "done" }> {
 const toolCalls: AgentToolCall[] = [...this.calls.entries()]
 .sort(([a], [b]) => a - b)
 .map(([i, c]) => ({
 id: c.id || `call_${i}_${(syntheticCallCounter++).toString(36)}`,
 name: c.name,
 arguments: c.arguments,
 }))
 .filter((c) => c.name.length > 0);
 return {
 type: "done",
 content: this.content,
 reasoning: this.reasoning,
 toolCalls,
 finishReason: this.finishReason,
 usage: this.usage,
 ...(this.compression ? { compression: this.compression } : {}),
 };
 }
}

/** Collect a non-streamed completion (used by /compact summarization). */
export async function completeChat(opts: StreamChatEventsOptions): Promise<{ content: string; usage: TokenUsage | null }> {
  let content = "";
  let usage: TokenUsage | null = null;
  for await (const ev of streamChatEvents(opts)) {
    if (ev.type === "text") content += ev.delta;
    if (ev.type === "done") usage = ev.usage;
  }
  return { content, usage };
}

/** Convenience: the transcript type re-exported for stream consumers. */
export type { AgentMessage };
