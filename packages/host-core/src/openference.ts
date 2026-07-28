import type { ChatMessage } from "./types.js";

/** Token usage reported by the provider on the final stream frame. */
export interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StreamChatOptions {
  apiBaseUrl: string;
  token: string;
  model: string;
  messages: ChatMessage[];
  /** Request model reasoning ("thinking") when supported. */
  thinking?: boolean;
  /** Called once with the real token usage, when the provider reports it. */
  onUsage?: (usage: StreamUsage) => void;
  signal?: AbortSignal;
}

/**
 * Stream a chat completion from an OpenAI-compatible endpoint. Yields content
 * deltas as they arrive. The Bearer token is the Openference access token from
 * OAuth (or a custom provider's API key).
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
  const request = (includeUsage: boolean) =>
    fetch(`${opts.apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
        ...(opts.thinking !== undefined ? { reasoning: { enabled: opts.thinking } } : {}),
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
  if (!res.body) {
    throw new Error(`Chat request failed (${res.status}). Empty response body.`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let yielded = 0;

  let finished = false;
  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        finished = true;
        break;
      }
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
        };
        if (json.usage) {
          const promptTokens = json.usage.prompt_tokens ?? 0;
          const completionTokens = json.usage.completion_tokens ?? 0;
          opts.onUsage?.({
            promptTokens,
            completionTokens,
            totalTokens: json.usage.total_tokens ?? promptTokens + completionTokens,
          });
        }
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          yielded += delta.length;
          yield delta;
        }
      } catch {
        // Ignore keep-alive / non-JSON lines.
      }
    }
  }
  // A 200 stream with zero content deltas would surface as an empty assistant
  // bubble — indistinguishable from "nothing happened". Make it a real error.
  if (yielded === 0) {
    throw new Error("The model returned an empty response.");
  }
}
