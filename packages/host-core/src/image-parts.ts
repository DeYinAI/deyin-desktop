/**
 * Extract generated images out of a model response.
 *
 * Chat models that emit pictures (Gemini flash-image / nano-banana, OpenAI
 * image tools on the Responses API, gateways that proxy either) attach the image
 * to the assistant message rather than answering on the images endpoint. Every
 * gateway spells that attachment differently, so the shapes are parsed in one
 * place and shared by the chat-completions, Responses and Anthropic transports.
 */

/** One image a model produced inside its completion. */
export interface StreamImage {
  /** Base64 payload without the `data:` prefix, when the bytes came inline. */
  base64?: string;
  /** Hosted URL, when the provider returned a link instead of bytes. */
  url?: string;
  mediaType: string;
  /** Assistant message attachment vs. a provider-side image tool call. */
  source: "message" | "tool";
}

const DATA_URI_RE = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i;
const BASE64_RE = /^[A-Za-z0-9+/\r\n]+={0,2}$/;
/** Below this a "base64" string is far more likely to be an id or a caption. */
const MIN_BASE64_LEN = 64;

/** Media type from base64 magic bytes; PNG when unknown. */
function sniffMediaType(base64: string): string {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  return "image/png";
}

function normalizeMediaType(value: unknown, base64?: string): string {
  if (typeof value === "string" && /^image\//i.test(value)) {
    return value.toLowerCase().replace("image/jpg", "image/jpeg");
  }
  return base64 ? sniffMediaType(base64) : "image/png";
}

/** A bare string: data URI, http(s) URL, or raw base64. */
function fromString(value: string, source: StreamImage["source"], mediaType?: unknown): StreamImage | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const uri = DATA_URI_RE.exec(trimmed);
  if (uri) {
    const base64 = uri[2]!.replace(/\s+/g, "");
    return { base64, mediaType: normalizeMediaType(uri[1], base64), source };
  }
  if (/^https?:\/\//i.test(trimmed)) return { url: trimmed, mediaType: normalizeMediaType(mediaType), source };
  if (trimmed.length >= MIN_BASE64_LEN && BASE64_RE.test(trimmed)) {
    const base64 = trimmed.replace(/\s+/g, "");
    return { base64, mediaType: normalizeMediaType(mediaType, base64), source };
  }
  return null;
}

/** Keys that carry the payload, in the order gateways prefer them. */
const PAYLOAD_KEYS = ["b64_json", "base64", "image_base64", "imageBase64", "result", "data", "image", "url", "image_url"];

/**
 * Turn one response part into an image, or null when the part is not one.
 * Recurses one level into wrapper objects (`image_url: { url }`,
 * `source: { data, media_type }`, `inline_data: { data, mime_type }`).
 */
export function parseImagePart(part: unknown, source: StreamImage["source"] = "message", depth = 0): StreamImage | null {
  if (depth > 3) return null;
  if (typeof part === "string") return fromString(part, source);
  if (!part || typeof part !== "object" || Array.isArray(part)) return null;
  const rec = part as Record<string, unknown>;

  const type = typeof rec.type === "string" ? rec.type.toLowerCase() : "";
  // A typed part that is explicitly not an image (text, reasoning, tool call).
  // Only the outer part is judged this way: inside a wrapper, `type` describes
  // the payload encoding instead ("base64", "url"), not the part's kind.
  if (depth === 0 && type && !type.includes("image") && !type.includes("inline_data")) return null;
  const nestedSource: StreamImage["source"] = type.includes("generation_call") || type.includes("tool") ? "tool" : source;

  // Anthropic / Gemini wrappers carry the media type next to the bytes.
  const declared = rec.media_type ?? rec.mediaType ?? rec.mime_type ?? rec.mimeType ?? rec.content_type;
  for (const wrapper of [rec.image_url, rec.source, rec.inline_data, rec.inlineData, rec.image]) {
    if (wrapper && typeof wrapper === "object") {
      const nested = parseImagePart(wrapper, nestedSource, depth + 1);
      if (nested) return declared ? { ...nested, mediaType: normalizeMediaType(declared, nested.base64) } : nested;
    }
  }

  for (const key of PAYLOAD_KEYS) {
    const value = rec[key];
    if (typeof value !== "string") continue;
    const image = fromString(value, nestedSource, declared);
    if (image) return image;
  }
  return null;
}

/**
 * Every image attached to one chat-completions message or delta. Covers
 * `images: [{ image_url: { url } }]` (OpenRouter), content-part arrays
 * (`[{ type: "image_url", ... }]`), and single-object variants.
 */
export function imagesFromMessage(message: unknown): StreamImage[] {
  if (!message || typeof message !== "object") return [];
  const rec = message as Record<string, unknown>;
  const out: StreamImage[] = [];
  const consider = (value: unknown, source: StreamImage["source"]) => {
    if (value === undefined || value === null) return;
    for (const entry of Array.isArray(value) ? value : [value]) {
      const image = parseImagePart(entry, source);
      if (image) out.push(image);
    }
  };
  consider(rec.images, "message");
  consider(rec.image, "message");
  // `content` is usually a plain string; only arrays can hold image parts.
  if (Array.isArray(rec.content)) consider(rec.content, "message");
  consider(rec.attachments, "message");
  return out;
}

/** Stable identity for an image, so repeated frames do not save it twice. */
export function imageKey(image: StreamImage): string {
  return image.base64 ? `b:${image.base64.length}:${image.base64.slice(0, 64)}` : `u:${image.url ?? ""}`;
}

/** Append `image` to `into` unless an equal image is already there. */
export function addImage(into: StreamImage[], seen: Set<string>, image: StreamImage): boolean {
  const key = imageKey(image);
  if (seen.has(key)) return false;
  seen.add(key);
  into.push(image);
  return true;
}
