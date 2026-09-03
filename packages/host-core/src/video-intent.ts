import type { ModelInfo } from "./types.js";

export interface VideoGenerationIntent {
  prompt: string;
}

/** Meta questions about capability — not a generation request. */
const META_QUESTION_RE =
  /^(?:can you|do you|are you able to|could you|will you)\s+(?:generate|create|make|produce)\s+(?:an?\s+)?(?:videos?|clips?|animations?)\s*\??$/i;

/** Explaining or analyzing — not asking for a new video. */
const EXCLUDE_RE =
  /\b(?:how (?:do|does|to|can)|what is|explain|describe|write code|implement|function|api|library|algorithm|tutorial|documentation)\b|\b(?:read|analyze|analyse|identify|detect|extract|what(?:'s| is) in)\b.*\b(?:video|clip|footage|recording)\b|\b(?:in|from|of) (?:this|the|my|that|your|an?) (?:attached|uploaded)?\s*(?:video|clip|footage|recording)\b|\bgenerate_video\s*\(|generateVideos?\s*\(|```/i;

const GENERATION_RES: RegExp[] = [
  /^\/?generate-video(?:\s+(.+))?$/i,
  /\b(?:generate|create|make|produce|render|animate)\s+(?:me\s+)?(?:an?\s+)?(?:video|clip|animation|footage|movie|short)\b/i,
  /\b(?:video|clip|animation|footage|movie)\s+of\b/i,
  /\bshow\s+me\s+(?:an?\s+)?(?:video|clip|animation)\b/i,
  /\bi\s+(?:want|need|would like)\s+(?:to\s+see|an?\s+(?:video|clip|animation))\b/i,
];

function matchesGenerationIntent(text: string): boolean {
  return GENERATION_RES.some((re) => re.test(text));
}

/** Detect when the user is asking for a new generated video. */
export function detectVideoGenerationIntent(text: string): VideoGenerationIntent | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 4000) return null;
  if (META_QUESTION_RE.test(trimmed)) return null;
  if (EXCLUDE_RE.test(trimmed)) return null;
  if (!matchesGenerationIntent(trimmed)) return null;

  const slash = trimmed.match(/^\/?generate-video(?:\s+(.+))?$/i);
  if (slash) {
    const subject = slash[1]?.trim();
    return { prompt: subject && subject.length > 0 ? subject : trimmed };
  }

  return { prompt: trimmed };
}

/** Pick the first video model from the provider catalog. */
export function pickVideoModelForGeneration(models: ModelInfo[]): string | undefined {
  return models.find((m) => m.kind === "video")?.id;
}

/** User-facing hint when video intent was detected but no video model is available. */
export function videoGenerationBlockedMessage(): string {
  return (
    "Your plan doesn't include a video model yet. Pick a text-to-video model (Agnes Video, etc.) " +
    "under Settings → Models, then try again."
  );
}
