import type { ChatMessage } from "../../shared/types.js";

export interface StreamChatOptions {
  apiBaseUrl: string;
  token: string;
  model: string;
  messages: ChatMessage[];
  /** Request model reasoning ("thinking") when supported. */
  thinking?: boolean;
  signal?: AbortSignal;
}

/**
 * Stream a chat completion from Openference's OpenAI-compatible endpoint. Yields content
 * deltas as they arrive. The Bearer token is the Openference access token from OAuth.
 */
export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<string> {
  const res = await fetch(`${opts.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: true,
      ...(opts.thinking !== undefined ? { reasoning: { enabled: opts.thinking } } : {}),
    }),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Chat request failed (${res.status}). ${detail}`.trim());
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // Ignore keep-alive / non-JSON lines.
      }
    }
  }
}
