import type { DeyinConfig } from "../shared/config.js";
import type { ModelInfo } from "../shared/types.js";
import type { AuthManager } from "./auth.js";

interface OpenAIModelListItem {
  id: string;
  context_length?: number;
  max_output_tokens?: number;
}

/**
 * Fetch the live model catalog from Openference (`GET /v1/models`), filtered by the
 * signed-in key's restrictions. Falls back to a small default set when signed out.
 */
export async function listModels(config: DeyinConfig, auth: AuthManager): Promise<ModelInfo[]> {
  const token = await auth.getAccessToken();
  if (!token) return DEFAULT_MODELS;

  try {
    const res = await fetch(`${config.apiBaseUrl}/models`, {
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

const DEFAULT_MODELS: ModelInfo[] = [
  { id: "GLM-5.2", name: "GLM-5.2" },
  { id: "DeepSeek-V4-Pro", name: "DeepSeek-V4-Pro" },
  { id: "Kimi-K3", name: "Kimi K3" },
  { id: "Qwen-Max", name: "Qwen Max" },
];
