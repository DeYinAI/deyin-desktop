import type { AgentMessage, AgentToolCall, TokenUsage, WireTool } from "./types.js";
import { addImage, parseImagePart, type StreamImage } from "@deyin/host-core";
import { toAnthropicMessages, toResponsesInput, type CompressionResult, type WireOptions } from "./wire.js";

/**
 * Provider wire formats supported by the agent transport layer.
 * - "chat-completions": OpenAI-compatible POST {base}/chat/completions (SSE).
 * - "responses":        OpenAI Responses API POST {base}/responses (SSE).
 * - "anthropic":        Anthropic Messages API POST {root}/v1/messages (SSE).
 */
export type ProviderApiFormat = "chat-completions" | "responses" | "anthropic";

/** Events shared by every transport; the loop only consumes text/reasoning/done. */
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
      compression?: {
        originalTokens: number;
        compressedTokens: number;
        ratio: number;
        results: CompressionResult[];
      };
      /** Number of auto-continuations used (length-truncated responses). */
      continuations?: number;
      /** Images the model produced inside the completion, in arrival order. */
      images?: StreamImage[];
    };

export interface TransportOptions {
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
  /** Compression + cache markers. */
  wire?: WireOptions;
  /** OpenAI / Openference prompt cache routing key. */
  promptCacheKey?: string;
  promptCacheOptions?: {
    mode?: "implicit" | "explicit";
    ttl?: string;
  };
  /**
   * Anthropic-compatible gateways that use `Authorization: Bearer` instead of
   * `x-api-key` (MiniMax Global, Vercel AI Gateway, ...). Ignored elsewhere.
   */
  authHeader?: boolean;
  /** Anthropic API version header; default "2023-06-01". */
  anthropicVersion?: string;
  /**
   * Ask the model for pictures as well as text. Set when the selected model
   * declares image output in the catalog: chat-completions gateways take
   * `modalities: ["text", "image"]`, the Responses API takes the built-in
   * `image_generation` tool.
   */
  imageOutput?: boolean;
}

/** Fallback tool-call ids must be unique across the whole transcript. */
let syntheticCallCounter = 0;
function synthCallId(prefix: string, index: number): string {
  return `${prefix}_${index}_${(syntheticCallCounter++).toString(36)}`;
}

/** Normalize per-transport usage counters into one TokenUsage (cache-aware). */
export function normalizeUsage(input: {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  /** DeepSeek-style top-level split (chat-completions). */
  promptCacheHitTokens?: number;
  /** Anthropic-style: prompt = input + cache_creation + cache_read. */
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}): TokenUsage | null {
  if (input.promptTokens === undefined && input.completionTokens === undefined && input.totalTokens === undefined) {
    return null;
  }
  const cached =
    input.cachedTokens ??
    input.promptCacheHitTokens ??
    (input.cacheReadTokens !== undefined ? input.cacheReadTokens : undefined);
  // Anthropic reports input_tokens WITHOUT cache counters; the billed prompt is
  // input + cache_creation + cache_read (creation is at least a miss, read is a hit).
  const prompt = (input.promptTokens ?? 0) + (input.cacheCreationTokens ?? 0) + (input.cacheReadTokens ?? 0);
  const completion = input.completionTokens ?? 0;
  const total =
    input.totalTokens !== undefined && input.totalTokens > 0
      ? Math.max(input.totalTokens, prompt + completion)
      : prompt + completion;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    ...(cached !== undefined && cached > 0 ? { cachedPromptTokens: cached } : {}),
  };
}

function readError(res: Response): Promise<string> {
  return res.text().catch(() => "");
}

// Shared SSE framing lives in @deyin/host-core (single implementation for
// host-core's plain chat and the agent transports).
import { parseSseDataLine, ssePayloads, SSE_DONE } from "@deyin/host-core";
export { parseSseDataLine, ssePayloads, SSE_DONE };/* Anthropic Messages API ---------------------------------------------------- */

/** Map Anthropic stop reasons onto OpenAI-style finish reasons. */
export function mapAnthropicStopReason(reason: string): string {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return reason;
  }
}

interface AnthropicWireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicWireEvent {
  type?: string;
  index?: number;
  message?: { usage?: AnthropicWireUsage; content?: unknown };
  content_block?: { type?: string; id?: string; name?: string; source?: unknown };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  usage?: AnthropicWireUsage;
  error?: { type?: string; message?: string };
}

/**
 * Incremental Anthropic Messages API stream accumulator. Feed parsed SSE
 * payloads; get stream events back. Handles message_start / content_block_start
 * (tool_use) / content_block_delta (text_delta, thinking_delta, signature_delta,
 * input_json_delta) / content_block_stop / message_delta / message_stop / error.
 */
export class AnthropicAccumulator {
  private content = "";
  private reasoning = "";
  private finishReason: string | null = null;
  private usage: TokenUsage | null = null;
  private calls = new Map<number, { id: string; name: string; arguments: string }>();
  private error: string | null = null;
  private readonly images: StreamImage[] = [];
  private readonly seenImages = new Set<string>();
  private readonly compressionInfo?: { originalTokens: number; compressedTokens: number; ratio: number; results: CompressionResult[] };

  constructor(compression?: { originalTokens: number; compressedTokens: number; ratio: number; results: CompressionResult[] }) {
    this.compressionInfo = compression;
  }

  private rawUsage = { input: 0, completion: 0, cachedRead: 0, creation: 0 };

  private mergeUsage(usage: AnthropicWireUsage | undefined): void {
    if (!usage) return;
    // Anthropic counters are cumulative; some gateways re-send partial frames,
    // so the max of each counter is the safe reading. Raw counters are tracked
    // separately — normalizing per frame would double-count cache tokens.
    this.rawUsage.input = Math.max(this.rawUsage.input, usage.input_tokens ?? 0);
    this.rawUsage.completion = Math.max(this.rawUsage.completion, usage.output_tokens ?? 0);
    this.rawUsage.cachedRead = Math.max(this.rawUsage.cachedRead, usage.cache_read_input_tokens ?? 0);
    this.rawUsage.creation = Math.max(this.rawUsage.creation, usage.cache_creation_input_tokens ?? 0);
    this.usage = normalizeUsage({
      promptTokens: this.rawUsage.input,
      completionTokens: this.rawUsage.completion,
      cachedTokens: this.rawUsage.cachedRead,
      cacheCreationTokens: this.rawUsage.creation,
      cacheReadTokens: this.rawUsage.cachedRead,
    });
  }

  push(payload: unknown): StreamEvent | null {
    const ev = payload as AnthropicWireEvent;
    switch (ev.type) {
      case "message_start":
        this.mergeUsage(ev.message?.usage);
        return null;
      case "content_block_start": {
        // Gateways that proxy an image-generating model onto the Messages API
        // deliver the picture as a whole image content block.
        if (ev.content_block?.type === "image") {
          const image = parseImagePart(ev.content_block, "message");
          if (image) addImage(this.images, this.seenImages, image);
          return null;
        }
        if (ev.content_block?.type === "tool_use") {
          this.calls.set(ev.index ?? this.calls.size, {
            id: ev.content_block.id ?? "",
            name: ev.content_block.name ?? "",
            arguments: "",
          });
        }
        return null;
      }
      case "content_block_delta": {
        const delta = ev.delta;
        if (delta?.type === "text_delta" && delta.text) {
          this.content += delta.text;
          return { type: "text", delta: delta.text };
        }
        if (delta?.type === "thinking_delta" && delta.thinking) {
          this.reasoning += delta.thinking;
          return { type: "reasoning", delta: delta.thinking };
        }
        if (delta?.type === "signature_delta") {
          // Signed extended-thinking tail; we do not replay thinking blocks, so
          // the signature has no round-trip use — surface nothing.
          return null;
        }
        if (delta?.type === "input_json_delta" && delta.partial_json) {
          const call = this.calls.get(ev.index ?? 0);
          if (call) call.arguments += delta.partial_json;
        }
        return null;
      }
      case "content_block_stop":
        return null;
      case "message_delta":
        if (ev.delta?.stop_reason) this.finishReason = mapAnthropicStopReason(ev.delta.stop_reason);
        this.mergeUsage(ev.usage);
        return null;
      case "message_stop":
        return this.finish();
      case "error":
        this.error = ev.error?.message ?? "Anthropic API error";
        return null;
      default:
        return null; // ping / content_block_* ignored
    }
  }

  getError(): string | null {
    return this.error;
  }

  finish(): StreamEvent {
    const toolCalls: AgentToolCall[] = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({
        id: c.id || synthCallId("toolu", index),
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
      ...(this.compressionInfo ? { compression: this.compressionInfo } : {}),
      ...(this.images.length > 0 ? { images: [...this.images] } : {}),
    };
  }
}

/**
 * Stream a completion from an Anthropic Messages API endpoint
 * (POST {root}/v1/messages with x-api-key, SSE events).
 */
export async function* streamAnthropicEvents(opts: TransportOptions): AsyncGenerator<StreamEvent> {
  // Base URLs often include a trailing /v1 (OpenAI-style); strip it so we never
  // POST to {base}/v1/v1/messages. Empty base falls back to api.anthropic.com.
  let root = (opts.apiBaseUrl || "https://api.anthropic.com").trim().replace(/\/+$/, "");
  if (root.endsWith("/v1")) root = root.slice(0, -3);
  if (root.length === 0) root = "https://api.anthropic.com";

  const built = toAnthropicMessages(opts.messages, opts.wire ?? {});
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 32768,
    stream: true,
    system: built.system,
    messages: built.messages,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }
  if (opts.thinking !== undefined) {
    // Classic extended thinking; newer "adaptive" mode is model-dependent, so
    // "enabled" + budget is the most widely accepted shape.
    body.thinking = { type: opts.thinking ? "enabled" : "disabled", budget_tokens: 4096 };
  }
  if (opts.effort) body.output_config = { effort: opts.effort };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "anthropic-version": opts.anthropicVersion ?? "2023-06-01",
  };
  // An empty token means a local provider (Ollama): send no credentials.
  if (opts.token) {
    if (opts.authHeader) headers.authorization = `Bearer ${opts.token}`;
    else headers["x-api-key"] = opts.token;
  }

  const res = await fetch(`${root}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(`Anthropic request failed (${res.status}). ${(await readError(res)).slice(0, 2000)}`.trim());
  }

  const acc = new AnthropicAccumulator(built.compression);
  for await (const payload of ssePayloads(res, opts.signal)) {
    const event = acc.push(payload);
    if (event) {
      if (event.type === "done") {
        // An error frame followed by message_stop must surface as a failure.
        const error = acc.getError();
        if (error) throw new Error(error);
        yield event;
        return;
      }
      yield event;
    }
  }
  const error = acc.getError();
  if (error) throw new Error(error);
  // Stream ended without message_stop (proxy cut): emit what we have.
  yield acc.finish();
}

/* OpenAI Responses API ------------------------------------------------------ */

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface ResponsesWireEvent {
  type?: string;
  delta?: string;
  item_id?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    /** image_generation_call: the finished picture, base64. */
    result?: unknown;
    content?: unknown;
  };
  /** response.image_generation_call.* frames carry the payload at the top level. */
  result?: unknown;
  partial_image_b64?: string;
  response?: { usage?: ResponsesUsage; incomplete_details?: { reason?: string } };
  error?: { code?: string; message?: string };
}

/**
 * Incremental OpenAI Responses API stream accumulator. Handles
 * response.output_text.delta / response.reasoning(_summary)_text.delta /
 * response.output_item.added (function_call) /
 * response.function_call_arguments.delta / response.output_item.done /
 * response.completed / response.incomplete / response.failed.
 */
export class ResponsesAccumulator {
  private content = "";
  private reasoning = "";
  private finishReason: string | null = null;
  private usage: TokenUsage | null = null;
  private calls = new Map<string, { id: string; name: string; arguments: string }>();
  private order: string[] = [];
  private error: string | null = null;
  private readonly images: StreamImage[] = [];
  private readonly seenImages = new Set<string>();
  private readonly compressionInfo?: { originalTokens: number; compressedTokens: number; ratio: number; results: CompressionResult[] };

  constructor(compression?: { originalTokens: number; compressedTokens: number; ratio: number; results: CompressionResult[] }) {
    this.compressionInfo = compression;
  }

  push(payload: unknown): StreamEvent | null {
    const ev = payload as ResponsesWireEvent;
    switch (ev.type) {
      case "response.output_text.delta":
        if (ev.delta) {
          this.content += ev.delta;
          return { type: "text", delta: ev.delta };
        }
        return null;
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta":
        if (ev.delta) {
          this.reasoning += ev.delta;
          return { type: "reasoning", delta: ev.delta };
        }
        return null;
      case "response.output_item.added": {
        if (ev.item?.type === "function_call") {
          const id = ev.item.id ?? ev.item.call_id ?? synthCallId("fc", this.order.length);
          this.calls.set(id, { id, name: ev.item.name ?? "", arguments: "" });
          this.order.push(id);
        }
        return null;
      }
      case "response.function_call_arguments.delta": {
        if (!ev.delta) return null;
        const id = ev.item_id ?? this.order[this.order.length - 1];
        const call = id ? this.calls.get(id) : undefined;
        if (call) call.arguments += ev.delta;
        return null;
      }
      case "response.image_generation_call.completed":
      case "response.image_generation_call.result": {
        // Final frame of the built-in image tool. Partial previews arrive as
        // response.image_generation_call.partial_image and are skipped: only the
        // completed picture is worth storing.
        const image = parseImagePart(ev.result ?? ev.item, "tool");
        if (image) addImage(this.images, this.seenImages, image);
        return null;
      }
      case "response.output_item.done": {
        const item = ev.item;
        // The built-in image tool reports its picture as a finished output item.
        if (item?.type === "image_generation_call") {
          const image = parseImagePart(item.result ?? item, "tool");
          if (image) addImage(this.images, this.seenImages, image);
          return null;
        }
        if (item?.type === "message" && Array.isArray(item.content)) {
          for (const part of item.content) {
            const image = parseImagePart(part, "message");
            if (image) addImage(this.images, this.seenImages, image);
          }
        }
        if (item?.type === "function_call") {
          const id = item.id ?? item.call_id ?? "";
          const call = (id && this.calls.get(id)) || (item.call_id ? this.calls.get(item.call_id) : undefined);
          if (call) {
            if (item.name) call.name = item.name;
            if (item.arguments) call.arguments = item.arguments;
          }
        }
        return null;
      }
      case "response.completed": {
        this.finishReason = "stop";
        this.mergeUsage(ev.response?.usage);
        return this.finish();
      }
      case "response.incomplete": {
        this.finishReason =
          ev.response?.incomplete_details?.reason === "max_output_tokens" ? "length" : "incomplete";
        this.mergeUsage(ev.response?.usage);
        return this.finish();
      }
      case "response.failed": {
        this.error = ev.error?.message ?? "Responses API error";
        this.mergeUsage(ev.response?.usage);
        return this.finish();
      }
      default:
        return null; // response.created / .output_text.done / .output_item.added(others) ...
    }
  }

  private mergeUsage(usage: ResponsesUsage | undefined): void {
    if (!usage) return;
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    this.usage = normalizeUsage({
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
      cachedTokens: cached,
    });
  }

  getError(): string | null {
    return this.error;
  }

  finish(): StreamEvent {
    const toolCalls: AgentToolCall[] = this.order
      .map((id) => this.calls.get(id))
      .filter((c): c is { id: string; name: string; arguments: string } => Boolean(c && c.name.length > 0))
      .map((c) => ({
        id: c.id || synthCallId("fc", 0),
        name: c.name,
        arguments: c.arguments,
      }));
    return {
      type: "done",
      content: this.content,
      reasoning: this.reasoning,
      toolCalls,
      finishReason: this.finishReason,
      usage: this.usage,
      ...(this.compressionInfo ? { compression: this.compressionInfo } : {}),
      ...(this.images.length > 0 ? { images: [...this.images] } : {}),
    };
  }
}

/**
 * Stream a completion from an OpenAI Responses API endpoint
 * (POST {base}/responses with Bearer auth, SSE events).
 */
export async function* streamResponsesEvents(opts: TransportOptions): AsyncGenerator<StreamEvent> {
  const built = toResponsesInput(opts.messages, opts.wire ?? {});
  const body: Record<string, unknown> = {
    model: opts.model,
    input: built.input,
    stream: true,
  };
  if (built.instructions !== undefined) body.instructions = built.instructions;
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  }
  if (opts.imageOutput) {
    // Built-in image tool: the model decides when to draw, and the picture comes
    // back as an image_generation_call output item.
    body.tools = [...((body.tools as unknown[]) ?? []), { type: "image_generation" }];
  }
  if (opts.effort) body.reasoning = { effort: opts.effort };
  if (opts.maxTokens !== undefined) body.max_output_tokens = opts.maxTokens;

  const responsesHeaders: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) responsesHeaders.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${opts.apiBaseUrl.replace(/\/+$/, "")}/responses`, {
    method: "POST",
    headers: responsesHeaders,
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(`Responses request failed (${res.status}). ${(await readError(res)).slice(0, 2000)}`.trim());
  }

  const acc = new ResponsesAccumulator(built.compression);
  for await (const payload of ssePayloads(res, opts.signal)) {
    const event = acc.push(payload);
    if (event) {
      if (event.type === "done") {
        // response.failed emits a done frame — never surface it as success.
        const error = acc.getError();
        if (error) throw new Error(error);
        yield event;
        return;
      }
      yield event;
    }
  }
  const error = acc.getError();
  if (error) throw new Error(error);
  yield acc.finish();
}
