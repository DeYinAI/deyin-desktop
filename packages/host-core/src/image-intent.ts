import type { ImageCapability } from "./images.js";
import type { ModelInfo } from "./types.js";

export interface ImageGenerationIntent {
  /** Prompt to send to the image model (usually the user's message). */
  prompt: string;
}

/** Result of picking an image model from the catalog for auto-generation. */
export interface PickedImageModel {
  id: string;
  route: ImageCapability;
}

/** Meta questions about capability — not a generation request. */
const META_QUESTION_RE =
  /^(?:can you|do you|are you able to|could you|will you)\s+(?:generate|create|draw|make)\s+(?:an?\s+)?(?:images?|pictures?|photos?|illustrations?)\s*\??$/i;

/** Explaining, coding, or analyzing — not asking for a new picture. */
const EXCLUDE_RE =
  /\b(?:how (?:do|does|to|can)|what is|explain|describe|write code|implement|function|api|library|algorithm|tutorial|documentation)\b|\b(?:read|analyze|analyse|identify|detect|ocr|extract|what(?:'s| is) in)\b.*\b(?:image|picture|photo|screenshot)\b|\b(?:in|from|of) (?:this|the|my|that|your|an?) (?:attached|uploaded|attached)?\s*(?:image|picture|photo|screenshot)\b|\bgenerate_image\s*\(|generateImages?\s*\(|```/i;

/** Strong generation signals — verb + image noun, or "image of …". */
const GENERATION_RES: RegExp[] = [
  /^\/?generate-image(?:\s+(.+))?$/i,
  /\b(?:generate|create|make|draw|paint|render|design|illustrate|sketch)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|illustration|artwork|drawing|sketch|icon|logo|mockup|poster|wallpaper|avatar|rendering|art)\b/i,
  /\b(?:draw|paint|sketch|illustrate)\s+(?:me\s+)?(?:an?\s+)?(?!(?:code|a function|the code)\b)[\w"'-]/i,
  /\b(?:image|picture|photo|illustration|artwork|drawing|sketch|icon|logo|mockup|poster|wallpaper|avatar)\s+of\b/i,
  /\bshow\s+me\s+(?:an?\s+)?(?:image|picture|photo|illustration|drawing|sketch)\b/i,
  /\bi\s+(?:want|need|would like)\s+(?:to\s+see|an?\s+(?:image|picture|photo|illustration|drawing|sketch))\b/i,
];

function matchesGenerationIntent(text: string): boolean {
  return GENERATION_RES.some((re) => re.test(text));
}

/**
 * Detect when the user is asking for a new generated image rather than code help,
 * image analysis, or a meta question about capabilities. Mirrors how web chat apps
 * route "draw me a cat" to an image model before the text model can refuse.
 */
export function detectImageGenerationIntent(text: string): ImageGenerationIntent | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 4000) return null;
  if (META_QUESTION_RE.test(trimmed)) return null;
  if (EXCLUDE_RE.test(trimmed)) return null;
  if (!matchesGenerationIntent(trimmed)) return null;

  const slash = trimmed.match(/^\/?generate-image(?:\s+(.+))?$/i);
  if (slash) {
    const subject = slash[1]?.trim();
    return { prompt: subject && subject.length > 0 ? subject : trimmed };
  }

  return { prompt: trimmed };
}

/**
 * Pick the best image model from the provider catalog for an automatic generation
 * run. Dedicated text-to-image models are preferred over chat models that draw.
 */
export function pickImageModelForGeneration(models: ModelInfo[]): PickedImageModel | undefined {
  const endpoint = models.find((m) => m.kind === "image");
  if (endpoint) return { id: endpoint.id, route: "endpoint" };
  const chatDraw = models.find((m) => m.kind !== "image" && m.imageOutput);
  if (chatDraw) return { id: chatDraw.id, route: "chat" };
  return undefined;
}

/** User-facing hint when image intent was detected but the plan has no image model. */
export function imageGenerationBlockedMessage(): string {
  return (
    "Your plan doesn't include an image model yet. Pick a text-to-image model (FLUX, SDXL, gpt-image) " +
    "or a chat model that draws (Gemini flash-image) under Settings → Models, then try again."
  );
}
