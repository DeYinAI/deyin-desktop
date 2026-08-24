import type { ChatMessage, ProviderApiFormat } from "./types.js";
import type { ReasoningEffort } from "./model-reasoning.js";
import { ssePayloads } from "./sse-core.js";

/** Token usage reported by the provider on the final stream frame. */
export interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Provider prompt-cache hits (OpenAI cached_tokens / Anthropic cache_read). */
  cachedPromptTokens?: number;
}

export interface StreamChatOptions {
  apiBaseUrl: string;
  token: string;
  model: string;
  messages: ChatMessage[];
  /** Request model reasoning ("thinking") when supported. */
  thinking?: boolean;
  /** Reasoning effort for models that support it. */
  effort?: ReasoningEffort;
  /** Called once with the real token usage, when the provider reports it. */
  onUsage?: (usage: StreamUsage) => void;
  signal?: AbortSignal;
  /**
   * Provider wire format. "chat-completions" (default) is the OpenAI-compatible
   * /chat/completions stream; "responses" speaks the OpenAI Responses API;
   * "anthropic" speaks the Anthropic Messages API (x-api-key, /v1/messages).
   */
  apiFormat?: ProviderApiFormat;
  /** Anthropic-compatible gateways using Bearer instead of x-api-key. */
  authHeader?: boolean;
  /** Max output tokens; omitted when unset (Anthropic defaults to 32768). */
  maxTokens?: number;
}

/** Normalize per-provider usage counters into one StreamUsage (cache-aware). */
function toUsage(u: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): StreamUsage {
  const prompt =
    u.input_tokens !== undefined
      ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      : (u.prompt_tokens ?? 0);
  const completion = u.output_tokens ?? u.completion_tokens ?? 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: u.total_tokens && u.total_tokens > 0 ? u.total_tokens : prompt + completion,
    ...(cached > 0 ? { cachedPromptTokens: cached } : {}),
  };
}

/** Typed view of the shared SSE payload stream (previously a local copy). */
async function* sseJson(res: Response): AsyncGenerator<Record<string, unknown>> {
  for await (const payload of ssePayloads(res)) {
    yield payload as Record<string, unknown>;
  }
}

/**
 * Stream a chat completion from any supported provider wire format. Yields
 * content deltas as they arrive. The Bearer token is the Openference access
 * token from OAuth (or a custom provider's API key).
 *
 * Usage metering: the request asks for `stream_options.include_usage`, so
 * spec-compliant providers emit a final frame with real token counts, which is
 * surfaced through `onUsage`. A few providers reject the parameter outright;
 * those requests are retried once without it (no usage frame, no estimate).
 *
 * This is the plain text-only stream used by the chat UI; the agentic loop with
 * tool calling lives in @deyin/agent-core (streamChatEvents).
 */
export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<string> {
  if (opts.apiFormat === "anthropic") {
    yield* streamAnthropicChat(opts);
    return;
  }
  if (opts.apiFormat === "responses") {
    yield* streamResponsesChat(opts);
    return;
  }
  yield* streamChatCompletions(opts);
}

/** OpenAI-compatible /chat/completions stream (existing path). */
async function* streamChatCompletions(opts: StreamChatOptions): AsyncGenerator<string> {
  const request = (includeUsage: boolean) =>
    fetch(`${opts.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Empty token = local provider (Ollama): no credentials sent.
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
        ...(opts.thinking !== undefined ? { reasoning: { enabled: opts.thinking } } : {}),
        ...(opts.effort ? { reasoning_effort: opts.effort } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal: opts.signal,
    });

  let res = await request(true);
  if (!res.ok) {
    let detail = await res.text().catch(() => "");
    // Some providers 400 on stream_options; retry once without it.
    if (res.status === 400 && /stream[_ ]?options/i.test(detail)) {
      res = await request(false);
      if (!res.ok) detail = await res.text().catch(() => "");
    }
    if (!res.ok) {
      throw new Error(`Chat request failed (${res.status}). ${detail}`.trim());
    }
  }

  let yielded = 0;
  for await (const json of sseJson(res)) {
    const usage = json.usage as Parameters<typeof toUsage>[0] | undefined;
    if (usage) opts.onUsage?.(toUsage(usage));
    const delta = (json.choices as Array<{ delta?: { content?: string } }> | undefined)?.[0]?.delta?.content;
    if (delta) {
      yielded += delta.length;
      yield delta;
    }
  }
  // A 200 stream with zero content deltas would surface as an empty assistant
  // bubble — indistinguishable from "nothing happened". Make it a real error.
  if (yielded === 0) {
    throw new Error("The model returned an empty response.");
  }
}

/** Anthropic Messages API text stream (no tool blocks in plain chat). */
async function* streamAnthropicChat(opts: StreamChatOptions): AsyncGenerator<string> {
  let root = (opts.apiBaseUrl || "https://api.anthropic.com").trim().replace(/\/+$/, "");
  if (root.endsWith("/v1")) root = root.slice(0, -3);
  if (root.length === 0) root = "https://api.anthropic.com";

  const system = opts.messages.filter((m) => m.role === "system").map((m) => ({ type: "text", text: m.content }));
  // Anthropic requires strictly alternating user/assistant roles; coalesce.
  const merged: Array<{ role: "user" | "assistant"; content: string[] }> = [];
  for (const m of opts.messages) {
    if (m.role === "system") continue;
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content.push(m.content);
    else merged.push({ role: m.role, content: [m.content] });
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "anthropic-version": "2023-06-01",
  };
  if (opts.token) {
    if (opts.authHeader) headers.authorization = `Bearer ${opts.token}`;
    else headers["x-api-key"] = opts.token;
  }

  const res = await fetch(`${root}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 32768,
      stream: true,
      system,
      messages: merged.map((g) => ({ role: g.role, content: g.content.join("\n") })),
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic request failed (${res.status}). ${detail}`.trim().slice(0, 2000));
  }

  let yielded = 0;
  for await (const json of sseJson(res)) {
    const type = json.type as string | undefined;
    if (type === "message_start" || type === "message_delta") {
      const usage = (json.message ?? json) as Parameters<typeof toUsage>[0] | undefined;
      if (usage && "input_tokens" in usage) opts.onUsage?.(toUsage(usage));
    }
    if (type === "content_block_delta") {
      const delta = json.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === "text_delta" && delta.text) {
        yielded += delta.text.length;
        yield delta.text;
      }
    }
    if (type === "error") {
      const err = json.error as { message?: string } | undefined;
      throw new Error(err?.message ?? "Anthropic API error");
    }
  }
  if (yielded === 0) {
    throw new Error("The model returned an empty response.");
  }
}

/** OpenAI Responses API text stream (no function calls in plain chat). */
async function* streamResponsesChat(opts: StreamChatOptions): AsyncGenerator<string> {
  const firstSystem = opts.messages.find((m) => m.role === "system");
  const input = opts.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  const res = await fetch(`${opts.apiBaseUrl.replace(/\/+$/, "")}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify({
      model: opts.model,
      ...(firstSystem ? { instructions: firstSystem.content } : {}),
      input,
      stream: true,
      ...(opts.maxTokens !== undefined ? { max_output_tokens: opts.maxTokens } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Responses request failed (${res.status}). ${detail}`.trim().slice(0, 2000));
  }

  let yielded = 0;
  for await (const json of sseJson(res)) {
    const type = json.type as string | undefined;
    if (type === "response.output_text.delta") {
      const delta = json.delta as string | undefined;
      if (delta) {
        yielded += delta.length;
        yield delta;
      }
    }
    if (type === "response.completed") {
      const response = json.response as { usage?: Parameters<typeof toUsage>[0] } | undefined;
      if (response?.usage) opts.onUsage?.(toUsage(response.usage));
    }
    if (type === "response.failed") {
      const err = json.error as { message?: string } | undefined;
      throw new Error(err?.message ?? "Responses API error");
    }
  }
  if (yielded === 0) {
    throw new Error("The model returned an empty response.");
  }
}
