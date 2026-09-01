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

/** Model ids from known vision-capable families, used when the catalog carries
 * no explicit capability metadata. Deliberately conservative. */
const VISION_ID_RE =
  /(^|[^a-z0-9])(vl|vision|omni|4o)([^a-z0-9]|$)|glm-4(\.\d+)?v|gpt-4\.1|gpt-5|gemini|claude|pixtral|grok-\d|llama-?3\.?2-(11b|90b)|moondream|internvl/i;

/**
 * True when a model accepts image *inputs*. Recognition order (conservative):
 * 1. explicit catalog `vision` flag;
 * 2. `capabilities` ("vision", "image_input");
 * 3. input-modality metadata third-party catalogs publish —
 *    `architecture.input_modalities` (OpenRouter), top-level `input_modalities`,
 *    or arrow/legacy `modality`/`modalities` declaring an image input
 *    ("text+image->text", ["text","image"]). Output-only image markers are
 *    ignored so text-to-image endpoints stay non-vision;
 * 4. curated id heuristic for known multimodal families.
 */
export function modelSupportsVision(
  id: string,
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
  return VISION_ID_RE.test(id);
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

/**
 * Stored-catalog view of vision capability: true / false / unknown.
 * Unlike {@link modelSupportsVision} (which answers "would this id plausibly
 * take images?" and falls back to the id heuristic), this preserves
 * "unknown": only explicit metadata asserts `false` (the `vision` flag or a
 * capabilities list naming its features without vision), never the bare id
 * regex. Stores persist `undefined` so the renderer keeps the user's
 * selection and lets the API decide, instead of blocking image sends with a
 * fabricated `vision: false`.
 */
export function visionCapability(
 id: string,
 meta?: { vision?: unknown; capabilities?: unknown } & ImageModelMeta,
): boolean | undefined {
 if (modelSupportsVision(id, meta)) return true;
 // Explicit negatives only: the flag, or a capabilities list that names its
 // supported features without vision. Anything else stays unknown.
 if (meta?.vision === false) return false;
 if (Array.isArray(meta?.capabilities)) return false;
 return undefined;
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
      // they stay chat models that additionally emit images.
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
