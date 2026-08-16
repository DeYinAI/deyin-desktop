import type { AgentMessage, AgentToolCall, TokenUsage, WireTool } from "./types.js";
import { buildWireMessages, type CompressionResult, type WireOptions } from "./wire.js";
import {
  normalizeUsage,
  streamAnthropicEvents,
  streamResponsesEvents,
  type ProviderApiFormat,
  type StreamEvent,
} from "./transports.js";

export type { ProviderApiFormat, StreamEvent };

export interface StreamChatEventsOptions {
 apiBaseUrl: string;
 token: string;
 model: string;
 messages: AgentMessage[];
 /** Declared tools; omitted from the request when empty so plain chat still works. */
 tools?: WireTool[];
 /** Request model reasoning ("thinking") when supported. */
 thinking?: boolean;
 /** Reasoning effort for models that support it ("low" | "medium" | "high"). */
 effort?: "low" | "medium" | "high";
 temperature?: number;
 /** Max output tokens; omitted when unset (Anthropic defaults to 32768). */
 maxTokens?: number;
 signal?: AbortSignal;
 /** Compression + Anthropic cache_control markers. */
 wire?: WireOptions;
 /** OpenAI / Openference prompt cache routing key. */
 promptCacheKey?: string;
 promptCacheOptions?: {
 mode?: "implicit" | "explicit";
 ttl?: string;
 };
 /**
  * Provider wire format. "chat-completions" (default) is the OpenAI-compatible
  * /chat/completions stream; "responses" speaks the OpenAI Responses API;
  * "anthropic" speaks the Anthropic Messages API (x-api-key, /v1/messages).
  */
 apiFormat?: ProviderApiFormat;
 /** Anthropic-compatible gateways using Bearer instead of x-api-key. */
 authHeader?: boolean;
 /** Anthropic API version header; default "2023-06-01". */
 anthropicVersion?: string;
 /** Max auto-continuations for length-truncated responses (default 3, DeepSeek only). */
 maxContinuations?: number;
}

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
  } | null;
}

/**
 * Stream a chat completion from any supported provider wire format, accumulating
 * fragmented tool_calls deltas and the final finish_reason. Yields text/reasoning
 * deltas as they arrive and exactly one final "done" event.
 */
export async function* streamChatEvents(opts: StreamChatEventsOptions): AsyncGenerator<StreamEvent> {
  if (opts.apiFormat === "anthropic") {
    yield* streamAnthropicEvents(opts);
    return;
  }
  if (opts.apiFormat === "responses") {
    yield* streamResponsesEvents(opts);
    return;
  }
  yield* streamChatCompletionsEvents(opts);
}

/**
 * Stream a chat completion from an OpenAI-compatible endpoint, accumulating
 * fragmented `tool_calls` deltas (ids, names and argument JSON arrive split across
 * many SSE chunks) and the final `finish_reason`.
 *
 * DeepSeek endpoints additionally auto-continue length-truncated responses via the
 * beta prefix endpoint: the partial assistant text is resent with `prefix: true`
 * so the model completes exactly where it stopped, with usage folded across calls.
 */
async function* streamChatCompletionsEvents(opts: StreamChatEventsOptions): AsyncGenerator<StreamEvent> {
  const built = buildWireMessages(opts.messages, opts.wire ?? {});
  const base = opts.apiBaseUrl.replace(/\/+$/, "");
  const isDeepSeek = /deepseek\./i.test(base);
  const maxContinuations = opts.maxContinuations ?? 3;

  let wireMessages = built.messages as unknown as Record<string, unknown>[];
  let continuations = 0;
  let content = "";
  let reasoning = "";
  let usage: TokenUsage | null = null;

  while (true) {
    const isContinuation = continuations > 0;
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: wireMessages,
      stream: true,
    };
    if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;
    if (opts.thinking !== undefined) body.reasoning = { enabled: opts.thinking };
    if (opts.effort) body.reasoning_effort = opts.effort;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    // OpenAI-compatible prompt caching: stable key improves prefix cache hits across agent steps.
    if (opts.promptCacheKey) body.prompt_cache_key = opts.promptCacheKey;
    if (opts.promptCacheOptions) body.prompt_cache_options = opts.promptCacheOptions;

    const endpoint = isContinuation ? `${base}/beta/chat/completions` : `${base}/chat/completions`;
    const res = await fetch(endpoint, {
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
    let doneEvent: StreamEvent | null = null;

    while (doneEvent === null) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parser.push(line);
        if (!event) continue;
        if (event.type === "done") {
          doneEvent = event;
          break;
        }
        if (event.type === "text") content += event.delta;
        else if (event.type === "reasoning") reasoning += event.delta;
        yield event;
      }
    }
    // Flush the trailing buffer: providers may end the stream without a final "\n".
    if (doneEvent === null && buffer.length > 0) {
      const event = parser.push(buffer);
      if (event && event.type === "done") doneEvent = event;
      else if (event) {
        if (event.type === "text") content += event.delta;
        else if (event.type === "reasoning") reasoning += event.delta;
        yield event;
      }
    }
    if (doneEvent === null) doneEvent = parser.finish();

    if (doneEvent.type !== "done") {
      yield doneEvent;
      return;
    }
    usage = foldTokenUsage(usage, doneEvent.usage);

    // Length-truncated text on a DeepSeek endpoint: continue via the beta prefix
    // endpoint instead of handing the loop a cut-off half answer.
    const truncated =
      doneEvent.finishReason === "length" &&
      doneEvent.toolCalls.length === 0 &&
      (doneEvent.content.length > 0 || content.length > 0);
    if (isDeepSeek && truncated && continuations < maxContinuations) {
      wireMessages = [
        ...wireMessages,
        { role: "assistant", content: doneEvent.content, prefix: true },
      ];
      continuations += 1;
      continue;
    }

    yield {
      ...doneEvent,
      content: content || doneEvent.content,
      reasoning: reasoning || doneEvent.reasoning,
      usage,
      ...(continuations > 0 ? { continuations } : {}),
    };
    return;
  }
}

/**
 * Sum token usage across continued requests: fields add, cached tokens add.
 * `null` on either side passes the other through.
 */
export function foldTokenUsage(
  a: TokenUsage | null,
  b: TokenUsage | null,
): TokenUsage | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedPromptTokens:
      (a.cachedPromptTokens ?? 0) + (b.cachedPromptTokens ?? 0) || undefined,
  };
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

    if (chunk.usage) {
      this.usage = normalizeUsage({
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
        cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
        promptCacheHitTokens: chunk.usage.prompt_cache_hit_tokens,
      });
    }

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

finish(): StreamEvent {
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
