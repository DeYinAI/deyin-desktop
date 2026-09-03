import { modelEffortKey } from "./model-reasoning.js";

/** Per-model video generation tuning saved in settings (providerId::modelId key). */
export interface VideoModelParams {
  /** Preset aspect ratio; maps to width/height when generating. */
  aspectRatio?: string;
  width?: number;
  height?: number;
  numFrames?: number;
  frameRate?: number;
  numInferenceSteps?: number;
  seed?: number;
  negativePrompt?: string;
  /** Image-to-video / keyframe mode when supported (e.g. keyframes, ti2vid). */
  mode?: string;
}

export const VIDEO_ASPECT_PRESETS = [
  { id: "16:9", label: "16:9 landscape", width: 1152, height: 768 },
  { id: "9:16", label: "9:16 portrait", width: 768, height: 1152 },
  { id: "1:1", label: "1:1 square", width: 768, height: 768 },
  { id: "4:3", label: "4:3 landscape", width: 1024, height: 768 },
  { id: "3:4", label: "3:4 portrait", width: 768, height: 1024 },
] as const;

/** Allowed frame counts for Agnes-style video models (8n+1, max 441). */
export const VIDEO_FRAME_PRESETS = [
  { frames: 81, label: "~3s @ 24fps" },
  { frames: 121, label: "~5s @ 24fps" },
  { frames: 161, label: "~7s @ 24fps" },
  { frames: 241, label: "~10s @ 24fps" },
  { frames: 441, label: "~18s @ 24fps" },
] as const;

export const DEFAULT_VIDEO_NEGATIVE_PROMPT =
  "blurry, low quality, distorted, watermark, text overlay, flickering, jittery motion, deformed";

const AGNES_VIDEO_RE = /agnes-video|agnes.*video/i;

/** Suggested defaults when the user has not saved overrides for this model. */
export function defaultVideoModelParams(modelId: string): Required<
  Pick<VideoModelParams, "aspectRatio" | "width" | "height" | "numFrames" | "frameRate" | "negativePrompt">
> {
  const agnes = AGNES_VIDEO_RE.test(modelId);
  return {
    aspectRatio: "16:9",
    width: 1152,
    height: 768,
    numFrames: agnes ? 121 : 121,
    frameRate: 24,
    negativePrompt: DEFAULT_VIDEO_NEGATIVE_PROMPT,
  };
}

export function videoModelParamsKey(providerId: string, modelId: string): string {
  return modelEffortKey(providerId, modelId);
}

function resolveDimensions(
  saved: VideoModelParams | null | undefined,
  defaults: ReturnType<typeof defaultVideoModelParams>,
): { width: number; height: number; aspectRatio: string } {
  const preset = VIDEO_ASPECT_PRESETS.find((p) => p.id === (saved?.aspectRatio ?? defaults.aspectRatio));
  if (saved?.width != null && saved?.height != null) {
    return {
      width: saved.width,
      height: saved.height,
      aspectRatio: saved.aspectRatio ?? defaults.aspectRatio,
    };
  }
  if (preset) return { width: preset.width, height: preset.height, aspectRatio: preset.id };
  return { width: defaults.width, height: defaults.height, aspectRatio: defaults.aspectRatio };
}

/** Merge saved overrides with model-specific defaults. */
export function resolveVideoModelParams(
  modelId: string,
  saved?: VideoModelParams | null,
): VideoModelParams {
  const defaults = defaultVideoModelParams(modelId);
  const dims = resolveDimensions(saved, defaults);
  return {
    aspectRatio: dims.aspectRatio,
    width: dims.width,
    height: dims.height,
    numFrames: saved?.numFrames ?? defaults.numFrames,
    frameRate: saved?.frameRate ?? defaults.frameRate,
    negativePrompt: saved?.negativePrompt ?? defaults.negativePrompt,
    ...(saved?.numInferenceSteps != null ? { numInferenceSteps: saved.numInferenceSteps } : {}),
    ...(saved?.seed != null ? { seed: saved.seed } : {}),
    ...(saved?.mode?.trim() ? { mode: saved.mode.trim() } : {}),
  };
}

/** Map UI/settings fields onto the OpenAI-shaped POST /videos body. */
export function videoParamsToExtra(params: VideoModelParams): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (params.width != null) extra.width = params.width;
  if (params.height != null) extra.height = params.height;
  if (params.numFrames != null) extra.num_frames = params.numFrames;
  if (params.frameRate != null) extra.frame_rate = params.frameRate;
  if (params.numInferenceSteps != null) extra.num_inference_steps = params.numInferenceSteps;
  if (params.negativePrompt?.trim()) extra.negative_prompt = params.negativePrompt.trim();
  if (params.seed != null) extra.seed = params.seed;
  if (params.mode?.trim()) {
    extra.extra_body = { mode: params.mode.trim() };
  }
  return extra;
}

export function pickVideoModelParamsRecord(value: unknown): Record<string, VideoModelParams> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const clean: Record<string, VideoModelParams> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const params: VideoModelParams = {};
    if (typeof raw.aspectRatio === "string" && raw.aspectRatio.trim()) {
      params.aspectRatio = raw.aspectRatio.trim();
    }
    if (typeof raw.width === "number" && Number.isFinite(raw.width)) {
      params.width = Math.max(256, Math.min(2048, Math.floor(raw.width)));
    }
    if (typeof raw.height === "number" && Number.isFinite(raw.height)) {
      params.height = Math.max(256, Math.min(2048, Math.floor(raw.height)));
    }
    if (typeof raw.numFrames === "number" && Number.isFinite(raw.numFrames)) {
      params.numFrames = Math.max(9, Math.min(441, Math.floor(raw.numFrames)));
    }
    if (typeof raw.frameRate === "number" && Number.isFinite(raw.frameRate)) {
      params.frameRate = Math.max(1, Math.min(60, raw.frameRate));
    }
    if (typeof raw.numInferenceSteps === "number" && Number.isFinite(raw.numInferenceSteps)) {
      params.numInferenceSteps = Math.max(1, Math.min(50, Math.floor(raw.numInferenceSteps)));
    }
    if (typeof raw.seed === "number" && Number.isFinite(raw.seed)) {
      params.seed = Math.floor(raw.seed);
    }
    if (typeof raw.negativePrompt === "string" && raw.negativePrompt.trim()) {
      params.negativePrompt = raw.negativePrompt.trim();
    }
    if (typeof raw.mode === "string" && raw.mode.trim()) params.mode = raw.mode.trim();
    if (Object.keys(params).length > 0) clean[key] = params;
  }
  return clean;
}
