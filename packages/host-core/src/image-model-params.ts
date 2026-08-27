import { modelEffortKey } from "./model-reasoning.js";

/** Per-model text-to-image tuning saved in settings (providerId::modelId key). */
export interface ImageModelParams {
  size?: string;
  numSteps?: number;
  guidance?: number;
  seed?: number;
  negativePrompt?: string;
  strength?: number;
}

export const DEFAULT_IMAGE_NEGATIVE_PROMPT =
  "blurry, low quality, deformed, extra fingers, extra limbs, bad anatomy, distorted face, watermark, text, cropped, duplicate";

export const IMAGE_SIZE_PRESETS = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "768x768",
  "512x512",
] as const;

const LIGHTNING_RE = /lightning|lcm/i;

/** Suggested defaults when the user has not saved overrides for this model. */
export function defaultImageModelParams(modelId: string): Required<
  Pick<ImageModelParams, "size" | "numSteps" | "guidance" | "negativePrompt">
> {
  const lightning = LIGHTNING_RE.test(modelId);
  return {
    size: "1024x1024",
    numSteps: lightning ? 4 : 20,
    guidance: 7.5,
    negativePrompt: DEFAULT_IMAGE_NEGATIVE_PROMPT,
  };
}

export function imageModelParamsKey(providerId: string, modelId: string): string {
  return modelEffortKey(providerId, modelId);
}

/** Merge saved overrides with model-specific defaults. */
export function resolveImageModelParams(
  modelId: string,
  saved?: ImageModelParams | null,
): ImageModelParams {
  const defaults = defaultImageModelParams(modelId);
  return {
    size: saved?.size ?? defaults.size,
    numSteps: saved?.numSteps ?? defaults.numSteps,
    guidance: saved?.guidance ?? defaults.guidance,
    negativePrompt: saved?.negativePrompt ?? defaults.negativePrompt,
    ...(saved?.seed != null ? { seed: saved.seed } : {}),
    ...(saved?.strength != null ? { strength: saved.strength } : {}),
  };
}

/** Map UI/settings fields onto the OpenAI-shaped /images/generations extras bag. */
export function imageParamsToExtra(params: ImageModelParams): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (params.negativePrompt?.trim()) extra.negative_prompt = params.negativePrompt.trim();
  if (params.numSteps != null) extra.num_steps = params.numSteps;
  if (params.guidance != null) extra.guidance = params.guidance;
  if (params.seed != null) extra.seed = params.seed;
  if (params.strength != null) extra.strength = params.strength;
  return extra;
}

export function pickImageModelParamsRecord(value: unknown): Record<string, ImageModelParams> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const clean: Record<string, ImageModelParams> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const params: ImageModelParams = {};
    if (typeof raw.size === "string" && raw.size.trim()) params.size = raw.size.trim();
    if (typeof raw.numSteps === "number" && Number.isFinite(raw.numSteps)) {
      params.numSteps = Math.max(1, Math.min(20, Math.floor(raw.numSteps)));
    }
    if (typeof raw.guidance === "number" && Number.isFinite(raw.guidance) && raw.guidance > 0) {
      params.guidance = raw.guidance;
    }
    if (typeof raw.seed === "number" && Number.isFinite(raw.seed)) {
      params.seed = Math.floor(raw.seed);
    }
    if (typeof raw.negativePrompt === "string" && raw.negativePrompt.trim()) {
      params.negativePrompt = raw.negativePrompt.trim();
    }
    if (typeof raw.strength === "number" && Number.isFinite(raw.strength)) {
      params.strength = Math.max(0, Math.min(1, raw.strength));
    }
    if (Object.keys(params).length > 0) clean[key] = params;
  }
  return clean;
}
