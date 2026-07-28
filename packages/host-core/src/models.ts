import type { ModelInfo } from "./types.js";

interface OpenAIModelListItem {
  id: string;
  context_length?: number;
  max_output_tokens?: number;
}

/** Anything that can produce a valid Openference access token (or null when signed out). */
export type TokenSource = () => Promise<string | null>;

/**
 * Fetch the live model catalog from Openference (`GET /v1/models`), filtered by the
 * signed-in key's restrictions. Falls back to a small default set when signed out.
 */
export async function listModels(opts: { apiBaseUrl: string }, getToken: TokenSource): Promise<ModelInfo[]> {
  const token = await getToken();
  if (!token) return DEFAULT_MODELS;

  try {
    const res = await fetch(`${opts.apiBaseUrl}/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return DEFAULT_MODELS;
    const body = (await res.json()) as { data?: OpenAIModelListItem[] };
    const items = body.data ?? [];
    if (items.length === 0) return DEFAULT_MODELS;
    return items.map((m) => ({
      id: m.id,
      name: m.id,
      contextLength: m.context_length,
      maxOutputTokens: m.max_output_tokens,
    }));
  } catch {
    return DEFAULT_MODELS;
  }
}

export const DEFAULT_MODELS: ModelInfo[] = [
  { id: "GLM-5.2", name: "GLM-5.2" },
  { id: "DeepSeek-V4-Pro", name: "DeepSeek-V4-Pro" },
  { id: "Kimi-K3", name: "Kimi K3" },
  { id: "Qwen-Max", name: "Qwen Max" },
];
