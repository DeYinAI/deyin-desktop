import { isImageModel } from "./images.js";
import type { ModelInfo } from "./types.js";

interface OpenAIModelListItem {
  id: string;
  context_length?: number;
  max_output_tokens?: number;
  /** Optional capability metadata when the catalog provides it. */
  vision?: boolean | number | string;
  capabilities?: unknown;
  /** Optional modality metadata: marks text-to-image entries. */
  type?: unknown;
  modality?: unknown;
  output_modalities?: unknown;
}

/** Model ids from known vision-capable families, used when the catalog carries
 * no explicit capability metadata. Deliberately conservative. */
const VISION_ID_RE =
  /(^|[^a-z0-9])(vl|vision|omni|4o)([^a-z0-9]|$)|glm-4(\.\d+)?v|gpt-4\.1|gpt-5|gemini|claude|pixtral|grok-\d|llama-?3\.?2-(11b|90b)|moondream|internvl/i;

/**
 * True when a model accepts image inputs. Prefers explicit catalog metadata
 * (`vision` flag or a capabilities array/object) and falls back to a curated
 * id heuristic for known multimodal families.
 */
export function modelSupportsVision(
  id: string,
  meta?: { vision?: boolean | number | string; capabilities?: unknown },
): boolean {
  if (meta?.vision !== undefined) return meta.vision === true || meta.vision === 1 || meta.vision === "true";
  const caps = meta?.capabilities;
  if (Array.isArray(caps)) {
    return caps.some((c) => {
      const s = String(c).toLowerCase();
      return s === "vision" || s.includes("image_input") || s.includes("image-input");
    });
  }
  if (caps && typeof caps === "object") {
    const v = (caps as Record<string, unknown>).vision;
    if (v === true || v === 1 || v === "true") return true;
  }
  return VISION_ID_RE.test(id);
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
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return DEFAULT_MODELS;
    const body = (await res.json()) as { data?: OpenAIModelListItem[] };
    const items = body.data ?? [];
    if (items.length === 0) return DEFAULT_MODELS;
    return items.map((m) => {
      const image = isImageModel(m.id, m);
      return {
        id: m.id,
        name: m.id,
        contextLength: m.context_length,
        maxOutputTokens: m.max_output_tokens,
        // Image models take a prompt, not a conversation: never route vision to them.
        vision: image ? false : modelSupportsVision(m.id, m),
        kind: image ? ("image" as const) : ("chat" as const),
      };
    });
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
