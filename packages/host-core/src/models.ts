import { modelImageCapability, type ImageModelMeta } from "./images.js";
import { parseModelReasoningMeta } from "./model-reasoning.js";
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
  modalities?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  /** OpenRouter-style nested modality block. */
  architecture?: unknown;
  /** Per-model reasoning effort configuration. */
  reasoning?: unknown;
  supported_parameters?: unknown;
}


/**
 * True when a model accepts image *inputs*, per EXPLICIT catalog metadata
 * only. Recognition order:
 * 1. explicit catalog `vision` flag;
 * 2. `capabilities` ("vision", "image_input");
 * 3. input-modality metadata third-party catalogs publish —
 *    `architecture.input_modalities` (OpenRouter), top-level `input_modalities`,
 *    or arrow/legacy `modality`/`modalities` declaring an image input
 *    ("text+image->text", ["text","image"]). Output-only image markers are
 * ignored so text-to-image endpoints stay non-vision.
 *
 * No id heuristic: a custom provider's catalog is the only source of truth,
 * and when it says nothing the stored `vision` stays `undefined` so the
 * client sends images anyway and the provider's own error (if any) surfaces
 * in the timeline. A model id that merely looks vision-capable is not
 * evidence.
 */
export function modelSupportsVision(
 _id: string,
  meta?: { vision?: unknown; capabilities?: unknown } & ImageModelMeta,
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
  if (meta && modalityInputImage(meta)) return true;
 return false;
}

/**
 * True when the entry's modality metadata declares an image *input*: the
 * OpenRouter `architecture.input_modalities` list, a top-level
 * `input_modalities` list, or an arrow-form `modality`/`modalities` string
 * like "text+image->text". Shares the image-side token grammar so "image/png"
 * and friends count. Plain "image" tags are deliberately NOT honored here —
 * those mark text-to-image output (see modelImageCapability), not vision.
 */
function modalityInputImage(meta: ImageModelMeta): boolean {
  const sources: unknown[] = [meta];
  if (meta.architecture && typeof meta.architecture === "object") sources.push(meta.architecture);
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const rec = source as Record<string, unknown>;
    for (const key of ["input_modalities", "inputModalities"] as const) {
      const raw = rec[key];
      if (!Array.isArray(raw)) continue;
      if (raw.some((t) => typeof t === "string" && isImageModalityToken(t))) return true;
    }
    for (const key of ["modality", "modalities"] as const) {
      const raw = rec[key];
      const entries = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
      // Only arrow-form entries prove an input side; bare tags stay ambiguous.
      for (const entry of entries) {
        const input = arrowModalityInput(entry);
        if (input?.some(isImageModalityToken)) return true;
      }
    }
  }
  return false;
}

/** Image-ish modality token: "image", "images", "image/png" (same grammar as images.ts). */
function isImageModalityToken(token: string): boolean {
  const t = token.trim().toLowerCase();
  return t === "image" || t === "images" || t.startsWith("image/");
}

/** Input side of an arrow-form modality string ("text+image->text"), or null. */
function arrowModalityInput(value: string): string[] | null {
  const match = /^([^-<>]*)(?:->|\u2192|=>)(.+)$/.exec(value.trim());
  if (!match) return null;
  return (match[1] ?? "").split(/[+,|/]/).map((s) => s.trim()).filter(Boolean);
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
      const capability = modelImageCapability(m.id, m);
 // "endpoint" models take a prompt, not a conversation: never route vision
 // to them. "chat" models generate pictures inside a normal completion, so
 // they stay chat models that additionally emit images. Vision capability is
 // explicit catalog metadata only — no metadata means unknown, and the
 // provider's own error is the fallback.
 const endpointOnly = capability === "endpoint";
      const reasoning = parseModelReasoningMeta(m);
      return {
        id: m.id,
        name: m.id,
        contextLength: m.context_length,
        maxOutputTokens: m.max_output_tokens,
        vision: endpointOnly ? false : modelSupportsVision(m.id, m),
        kind: endpointOnly ? ("image" as const) : ("chat" as const),
        ...(capability === "chat" ? { imageOutput: true } : {}),
        ...(reasoning ? { reasoning } : {}),
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
