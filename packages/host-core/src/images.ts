/**
 * Text-to-image support: catalog classification plus the OpenAI-compatible
 * `POST /images/generations` client. Browser-safe (fetch only), so the desktop
 * renderer, the web client and both agent hosts share one implementation.
 */

/** Media types we accept back from an image endpoint. */
export type GeneratedMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** One image returned by a generation request (base64, no data: prefix). */
export interface GeneratedImage {
  base64: string;
  mediaType: GeneratedMediaType;
  /** Provider-rewritten prompt, when the endpoint reports one. */
  revisedPrompt?: string;
}

/**
 * Model ids from known text-to-image families, used when the catalog carries no
 * explicit modality metadata. Deliberately conservative: a false positive here
 * would route a chat model to the image endpoint.
 */
const IMAGE_ID_RE =
  /(sdxl|sd-?[1-9]|stable-?diffusion|flux|dall-?e|playground-v|kandinsky|pixart|imagen|ideogram|recraft|seedream|midjourney|hunyuan-image|qwen-image|kolors|auraflow|dreamshaper|realvis|juggernaut|latent-consistency|lcm-)/i;

/** Catalog fields that can declare a model's output modality. */
export interface ImageModelMeta {
  /** Some catalogs tag the entry: "image", "text-to-image", "chat". */
  type?: unknown;
  modality?: unknown;
  output_modalities?: unknown;
  capabilities?: unknown;
}

function declaresImageOutput(value: unknown): boolean {
  if (typeof value === "string") {
    const s = value.toLowerCase();
    return s === "image" || s === "images" || s.includes("text-to-image") || s.includes("text2image") || s.includes("image_generation") || s.includes("image-generation");
  }
  if (Array.isArray(value)) return value.some(declaresImageOutput);
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return declaresImageOutput(rec.type) || declaresImageOutput(rec.modality) || declaresImageOutput(rec.output_modalities);
  }
  return false;
}

/**
 * True when a model *produces* images (text-to-image) rather than chat text.
 * Prefers explicit catalog metadata and falls back to a curated id heuristic
 * for the families gateways commonly expose (SDXL, FLUX, DALL·E, ...).
 */
export function isImageModel(id: string, meta?: ImageModelMeta): boolean {
  if (meta) {
    for (const field of [meta.type, meta.modality, meta.output_modalities, meta.capabilities]) {
      if (declaresImageOutput(field)) return true;
    }
  }
  return IMAGE_ID_RE.test(id);
}

/**
 * Backfill `kind` on catalog entries that predate modality classification
 * (models cached by an older build, or a custom provider's stored model list).
 */
export function classifyModelKinds<T extends { id: string; kind?: "chat" | "image" }>(models: T[]): T[] {
  return models.map((m) => (m.kind ? m : { ...m, kind: (isImageModel(m.id) ? "image" : "chat") as "chat" | "image" }));
}

export interface GenerateImagesOptions {
  apiBaseUrl: string;
  token: string;
  model: string;
  prompt: string;
  /** Square-ish default; providers that reject the size fall back to their own. */
  size?: string;
  /** How many images to return (providers may cap this at 1). */
  n?: number;
  /** Extra provider knobs (steps, seed, negative_prompt, guidance...). */
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Sniff the media type from base64 magic bytes; PNG when unknown. */
function sniffMediaType(base64: string): GeneratedMediaType {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  return "image/png";
}

/** Strip a `data:<type>;base64,` prefix and report the declared type. */
function fromDataUri(value: string): GeneratedImage | null {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.+)$/is.exec(value.trim());
  if (!match) return null;
  const declared = match[1]!.toLowerCase().replace("image/jpg", "image/jpeg") as GeneratedMediaType;
  return { base64: match[2]!.trim(), mediaType: declared };
}

const BASE64_RE = /^[A-Za-z0-9+/\r\n]+={0,2}$/;

/** Turn one response entry into an image (base64 field, data URI or http url). */
async function toImage(entry: unknown, signal?: AbortSignal): Promise<GeneratedImage | null> {
  if (typeof entry === "string") {
    const uri = fromDataUri(entry);
    if (uri) return uri;
    if (/^https?:\/\//i.test(entry)) return await fetchImageUrl(entry, signal);
    return BASE64_RE.test(entry) && entry.length > 64 ? { base64: entry, mediaType: sniffMediaType(entry) } : null;
  }
  if (!entry || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  const revised = typeof rec.revised_prompt === "string" ? rec.revised_prompt : undefined;
  // OpenAI (b64_json), Stability (base64), Cloudflare Workers AI (image).
  for (const key of ["b64_json", "base64", "image", "imageBase64", "data"]) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) {
      const image = await toImage(value, signal);
      if (image) return revised ? { ...image, revisedPrompt: revised } : image;
    }
  }
  if (typeof rec.url === "string" && rec.url.length > 0) {
    const image = await toImage(rec.url, signal);
    if (image) return revised ? { ...image, revisedPrompt: revised } : image;
  }
  return null;
}

/** Download a hosted result (providers that return URLs) into base64. */
async function fetchImageUrl(url: string, signal?: AbortSignal): Promise<GeneratedImage | null> {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const buffer = await res.arrayBuffer();
  const declared = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  const base64 = base64FromBytes(new Uint8Array(buffer));
  const mediaType: GeneratedMediaType =
    declared === "image/jpeg" || declared === "image/jpg"
      ? "image/jpeg"
      : declared === "image/webp"
        ? "image/webp"
        : declared === "image/gif"
          ? "image/gif"
          : declared === "image/png"
            ? "image/png"
            : sniffMediaType(base64);
  return { base64, mediaType };
}

/** Base64 without Buffer, so this module stays browser-safe. */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Pull the image entries out of the many shapes gateways answer with. */
async function parseImageResponse(body: unknown, signal?: AbortSignal): Promise<GeneratedImage[]> {
  if (!body || typeof body !== "object") return [];
  const rec = body as Record<string, unknown>;
  const candidates: unknown[] = [];
  for (const key of ["data", "images", "artifacts", "output"]) {
    const value = rec[key];
    if (Array.isArray(value)) candidates.push(...value);
    else if (value !== undefined && value !== null) candidates.push(value);
  }
  // Cloudflare Workers AI style: { result: { image: "<base64>" } }.
  if (candidates.length === 0 && rec.result !== undefined) candidates.push(rec.result);
  if (candidates.length === 0) candidates.push(rec);
  const images: GeneratedImage[] = [];
  for (const candidate of candidates) {
    const image = await toImage(candidate, signal);
    if (image) images.push(image);
  }
  return images;
}

/** The error text a failed generation should surface (provider message first). */
async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message);
    if (message) return `${message} (HTTP ${res.status})`;
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return text.trim().length > 0 ? `${text.trim().slice(0, 300)} (HTTP ${res.status})` : `HTTP ${res.status}`;
}

/**
 * Generate images from a prompt through the OpenAI-compatible images endpoint.
 * `response_format: "b64_json"` is requested first (no second round trip for
 * hosted URLs); providers that reject the parameter are retried once without it,
 * mirroring how streamChat handles `stream_options`.
 */
export async function generateImages(opts: GenerateImagesOptions): Promise<GeneratedImage[]> {
  const url = `${opts.apiBaseUrl.replace(/\/$/, "")}/images/generations`;
  const payload: Record<string, unknown> = {
    model: opts.model,
    prompt: opts.prompt,
    n: opts.n ?? 1,
    ...(opts.size ? { size: opts.size } : {}),
    ...(opts.extra ?? {}),
  };

  const post = (body: Record<string, unknown>) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(180_000),
    });

  let res = await post({ ...payload, response_format: "b64_json" });
  if (res.status === 400 || res.status === 422) res = await post(payload);
  if (!res.ok) throw new Error(`Image generation failed: ${await errorMessage(res)}`);

  // Some gateways answer with the raw image bytes instead of JSON.
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.startsWith("image/")) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    const base64 = base64FromBytes(bytes);
    return [{ base64, mediaType: sniffMediaType(base64) }];
  }

  const body = (await res.json().catch(() => null)) as unknown;
  const images = await parseImageResponse(body, opts.signal);
  if (images.length === 0) throw new Error("Image generation returned no image data.");
  return images;
}
