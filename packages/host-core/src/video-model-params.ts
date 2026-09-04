import { modelEffortKey } from "./model-reasoning.js";

/** Agnes POST /v1/videos generation mode. */
export type VideoGenerationMode = "text" | "keyframe" | "reference";

/** Per-model video generation tuning saved in settings (providerId::modelId key). */
export interface VideoModelParams {
  /** Output aspect ratio (`aspect_ratio` in the Agnes API). */
  aspectRatio?: string;
  /** Clip length in seconds (4–12); sent as a string in the API body. */
  seconds?: number;
  /** Output resolution label; Flash models require `"720P"`. */
  size?: string;
  seed?: number;
  /** text = prompt-only; reference = image/audio refs; keyframe = first/last frame. */
  mode?: VideoGenerationMode | string;
}

/** Supported `aspect_ratio` values for Agnes Video 2.5 / Flash ([docs](https://www.agnes-ai.com/en/docs/agnes-video-25-flash)). */
export const VIDEO_ASPECT_PRESETS = [
  { id: "21:9", label: "21:9 ultrawide", pixels: "1680×720" },
  { id: "16:9", label: "16:9 landscape", pixels: "1280×704" },
  { id: "4:3", label: "4:3 landscape", pixels: "960×720" },
  { id: "1:1", label: "1:1 square", pixels: "720×720" },
  { id: "3:4", label: "3:4 portrait", pixels: "720×960" },
  { id: "9:16", label: "9:16 portrait", pixels: "720×1280" },
] as const;

/** Allowed clip lengths (seconds) for Agnes Video API. */
export const VIDEO_SECONDS_PRESETS = [4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

const AGNES_VIDEO_RE = /agnes-video|agnes.*video/i;
const AGNES_VIDEO_FLASH_RE = /agnes-video.*flash|agnes.*video.*flash/i;

export function isAgnesVideoModel(modelId: string): boolean {
  return AGNES_VIDEO_RE.test(modelId);
}

export function isAgnesVideoFlashModel(modelId: string): boolean {
  return AGNES_VIDEO_FLASH_RE.test(modelId);
}

/** Map saved/UI mode strings onto the API enum (includes legacy ti2vid / keyframes). */
export function normalizeVideoMode(mode?: string | null): VideoGenerationMode | undefined {
  if (!mode?.trim()) return undefined;
  const m = mode.trim().toLowerCase();
  switch (m) {
    case "text":
      return "text";
    case "keyframe":
    case "keyframes":
      return "keyframe";
    case "reference":
    case "ti2vid":
    case "i2v":
    case "image-to-video":
      return "reference";
    default:
      return undefined;
  }
}

/** Required by Agnes video API — default text, or reference when reference images are attached. */
export function resolveVideoGenerationMode(
  params: VideoModelParams,
  hasInputImages = false,
): VideoGenerationMode {
  const normalized = normalizeVideoMode(params.mode);
  if (normalized) return normalized;
  return hasInputImages ? "reference" : "text";
}

/** Suggested defaults when the user has not saved overrides for this model. */
export function defaultVideoModelParams(modelId: string): Required<
  Pick<VideoModelParams, "aspectRatio" | "seconds" | "mode">
> & Pick<VideoModelParams, "size"> {
  const flash = isAgnesVideoFlashModel(modelId);
  return {
    aspectRatio: "16:9",
    seconds: 5,
    mode: "text",
    ...(flash || isAgnesVideoModel(modelId) ? { size: "720P" } : {}),
  };
}

export function videoModelParamsKey(providerId: string, modelId: string): string {
  return modelEffortKey(providerId, modelId);
}

/** Merge saved overrides with model-specific defaults. */
export function resolveVideoModelParams(
  modelId: string,
  saved?: VideoModelParams | null,
): VideoModelParams {
  const defaults = defaultVideoModelParams(modelId);
  const legacy = saved as LegacyVideoModelParams | null | undefined;
  const seconds =
    saved?.seconds != null
      ? clampSeconds(saved.seconds)
      : legacySecondsFromFrames(legacy?.numFrames) ?? defaults.seconds;
  return {
    aspectRatio: saved?.aspectRatio ?? defaults.aspectRatio,
    seconds,
    size: saved?.size ?? defaults.size,
    mode: normalizeVideoMode(saved?.mode) ?? defaults.mode,
    ...(saved?.seed != null ? { seed: saved.seed } : {}),
  };
}

function clampSeconds(value: number): number {
  return Math.max(4, Math.min(12, Math.floor(value)));
}

/** Migrate pre-Agnes settings that stored frame counts instead of seconds. */
function legacySecondsFromFrames(numFrames?: number): number | undefined {
  if (numFrames == null || !Number.isFinite(numFrames)) return undefined;
  return clampSeconds(Math.round(numFrames / 24));
}

export interface VideoParamsToExtraOptions {
  /** When > 0 and mode is unset, defaults to `reference`. */
  inputImageCount?: number;
  modelId?: string;
}

/** Map UI/settings fields onto the Agnes/OpenAI-shaped POST /videos body. */
export function videoParamsToExtra(
  params: VideoModelParams,
  opts?: VideoParamsToExtraOptions,
): Record<string, unknown> {
  const modelId = opts?.modelId ?? "";
  const defaults = defaultVideoModelParams(modelId);
  const mode = resolveVideoGenerationMode(params, (opts?.inputImageCount ?? 0) > 0);
  const seconds = params.seconds ?? defaults.seconds;
  const extra: Record<string, unknown> = {
    mode,
    seconds: String(clampSeconds(seconds)),
    aspect_ratio: params.aspectRatio ?? defaults.aspectRatio,
    n: 1,
  };
  const size = params.size ?? defaults.size;
  if (size) extra.size = size;
  if (params.seed != null) extra.seed = params.seed;
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
    if (typeof raw.seconds === "number" && Number.isFinite(raw.seconds)) {
      params.seconds = clampSeconds(raw.seconds);
    } else if (typeof raw.numFrames === "number" && Number.isFinite(raw.numFrames)) {
      params.seconds = legacySecondsFromFrames(raw.numFrames);
    }
    if (typeof raw.size === "string" && raw.size.trim()) {
      params.size = raw.size.trim();
    }
    if (typeof raw.seed === "number" && Number.isFinite(raw.seed)) {
      params.seed = Math.floor(raw.seed);
    }
    if (typeof raw.mode === "string" && raw.mode.trim()) {
      const normalized = normalizeVideoMode(raw.mode);
      if (normalized) params.mode = normalized;
    }
    if (Object.keys(params).length > 0) clean[key] = params;
  }
  return clean;
}

/** @deprecated Legacy field kept for settings migration only. */
export interface LegacyVideoModelParams extends VideoModelParams {
  width?: number;
  height?: number;
  numFrames?: number;
  frameRate?: number;
  numInferenceSteps?: number;
  negativePrompt?: string;
}
