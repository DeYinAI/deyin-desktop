/**
 * Text-to-image support: catalog classification plus the OpenAI-compatible
 * `POST /images/generations` client. Browser-safe (fetch only), so the desktop
 * renderer, the web client and both agent hosts share one implementation.
 */

import { imagesFromMessage } from "./image-parts.js";
import { isVideoModel } from "./videos.js";
import { deyinUserAgent } from "./user-agent.js";

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
 * Model ids from known text-to-image families that answer on the dedicated
 * images endpoint. Deliberately conservative: a false positive here would route
 * a chat model to `/images/generations`.
 */
const IMAGE_ID_RE =
  /(sdxl|sd-?[1-9]|stable-?diffusion|flux|dall-?e|gpt-image|playground-v|kandinsky|pixart|imagen|ideogram|recraft|seedream|midjourney|hunyuan-image|qwen-image|kolors|auraflow|dreamshaper|realvis|juggernaut|latent-consistency|lcm-)/i;

/**
 * Model ids that generate images *inside a chat completion* — the picture comes
 * back attached to the assistant message instead of from the images endpoint
 * (Gemini "flash image"/nano-banana, image-preview chat models). These keep
 * conversation context, so they are chat models that also emit images.
 */
const CHAT_IMAGE_ID_RE = /(nano-?banana|flash-image|image-preview|-image-chat|gemini[\w.-]*-image)/i;

/** Catalog fields that can declare a model's modalities. */
export interface ImageModelMeta {
  /** Some catalogs tag the entry: "image", "text-to-image", "chat". */
  type?: unknown;
  modality?: unknown;
  modalities?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  capabilities?: unknown;
  features?: unknown;
  tags?: unknown;
  /** OpenRouter nests modality metadata here. */
  architecture?: unknown;
}

/** What a catalog entry says it can take in and hand back. */
interface Modalities {
  outputImage: boolean;
  outputText: boolean;
  inputImage: boolean;
  /** True once any field described the output, so heuristics can stand down. */
  declared: boolean;
}

/** Does one modality token name images? ("image", "image/png", "IMAGE") */
export function isImageToken(token: string): boolean {
  const t = token.trim().toLowerCase();
  return t === "image" || t === "images" || t.startsWith("image/");
}

function isTextToken(token: string): boolean {
  const t = token.trim().toLowerCase();
  return t === "text" || t === "texts" || t.startsWith("text/") || t === "chat";
}

/** Split "text+image->text+image" / "text->image" into sides. */
export function parseArrowModality(value: string): { input: string[]; output: string[] } | null {
  const match = /^([^-<>]*)(?:->|→|=>)(.+)$/.exec(value.trim());
  if (!match) return null;
  const split = (side: string) => side.split(/[+,|/]/).map((s) => s.trim()).filter(Boolean);
  return { input: split(match[1] ?? ""), output: split(match[2] ?? "") };
}

/** Tokens from a string / string[] / nested object field. */
function tokensOf(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[+,|]/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(tokensOf);
  return [];
}

/** Phrases that mean "this model makes pictures", wherever they appear. */
function saysImageGeneration(value: unknown): boolean {
  if (typeof value === "string") {
    const s = value.toLowerCase().replace(/\s+/g, "-");
    return (
      s.includes("text-to-image") ||
      s.includes("text2image") ||
      s.includes("image-generation") ||
      s.includes("image_generation") ||
      s.includes("image-gen") ||
      s.includes("imagegeneration")
    );
  }
  if (Array.isArray(value)) return value.some(saysImageGeneration);
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const [key, v] of Object.entries(rec)) {
      if (v === true && saysImageGeneration(key)) return true;
      if (typeof v === "string" && saysImageGeneration(v)) return true;
    }
  }
  return false;
}

/**
 * Read every modality field a gateway might publish. Covers OpenRouter
 * (`architecture.output_modalities`, `architecture.modality: "text->image"`),
 * flat `output_modalities`/`modality`/`type` tags, and capability lists
 * ("image_generation", "text-to-image").
 */
function collectModalities(meta?: ImageModelMeta): Modalities {
  const out: Modalities = { outputImage: false, outputText: false, inputImage: false, declared: false };
  if (!meta) return out;

  const sources: unknown[] = [meta];
  const arch = (meta as Record<string, unknown>).architecture;
  if (arch && typeof arch === "object") sources.push(arch);

  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const rec = source as Record<string, unknown>;

    // Arrow-form modality strings describe both sides at once.
    for (const key of ["modality", "modalities", "type"]) {
      const raw = rec[key];
      if (typeof raw !== "string") continue;
      const arrow = parseArrowModality(raw);
      if (!arrow) continue;
      out.declared = true;
      if (arrow.output.some(isImageToken)) out.outputImage = true;
      if (arrow.output.some(isTextToken)) out.outputText = true;
      if (arrow.input.some(isImageToken)) out.inputImage = true;
    }

    const outputs = tokensOf(rec.output_modalities ?? (rec as { outputModalities?: unknown }).outputModalities);
    if (outputs.length > 0) {
      out.declared = true;
      if (outputs.some(isImageToken)) out.outputImage = true;
      if (outputs.some(isTextToken)) out.outputText = true;
    }

    const inputs = tokensOf(rec.input_modalities ?? (rec as { inputModalities?: unknown }).inputModalities);
    if (inputs.some(isImageToken)) out.inputImage = true;

    // Plain tags: `type: "image"`, `modality: ["image"]`, `type: "chat"`.
    for (const key of ["type", "modality", "modalities"]) {
      const raw = rec[key];
      if (raw === undefined || (typeof raw === "string" && parseArrowModality(raw))) continue;
      const tokens = tokensOf(raw);
      if (tokens.length === 0) continue;
      if (tokens.some(isImageToken)) {
        out.declared = true;
        out.outputImage = true;
      } else if (tokens.some(isTextToken)) {
        out.declared = true;
        out.outputText = true;
      }
    }

    for (const key of ["capabilities", "features", "tags", "supported_parameters"]) {
      if (saysImageGeneration(rec[key])) {
        out.declared = true;
        out.outputImage = true;
      }
    }
  }
  return out;
}

/**
 * How a model produces pictures:
 * - "endpoint": text-to-image model served by `POST /images/generations`
 *   (SDXL, FLUX, DALL·E, gpt-image). It has no chat completion to stream.
 * - "chat": a chat model that returns images attached to the assistant message
 *   (Gemini flash-image / nano-banana). It keeps conversation context.
 * - "none": text-only chat model.
 *
 * Explicit catalog metadata always wins; the id heuristics only run when the
 * catalog said nothing about output modalities.
 */
export function modelImageCapability(id: string, meta?: ImageModelMeta): ImageCapability {
  const m = collectModalities(meta);
  if (m.outputImage) return m.outputText ? "chat" : "endpoint";
  if (m.declared) return "none";
  if (CHAT_IMAGE_ID_RE.test(id)) return "chat";
  if (IMAGE_ID_RE.test(id)) return "endpoint";
  return "none";
}

/** How a model hands back generated images. */
export type ImageCapability = "none" | "endpoint" | "chat";

/**
 * True when a model *only* produces images (text-to-image endpoint) rather than
 * chat text. Chat models that also emit images are excluded: they still stream a
 * normal completion — see {@link modelEmitsImages}.
 */
export function isImageModel(id: string, meta?: ImageModelMeta): boolean {
  return modelImageCapability(id, meta) === "endpoint";
}

/** True when a chat model can return images inside its completion. */
export function modelEmitsImages(id: string, meta?: ImageModelMeta): boolean {
  return modelImageCapability(id, meta) === "chat";
}

/**
 * Backfill `kind` on catalog entries that predate modality classification
 * (models cached by an older build, or a custom provider's stored model list).
 */
export function classifyModelKinds<T extends { id: string; kind?: "chat" | "image" | "video"; imageOutput?: boolean }>(
  models: T[],
): (T & { kind: "chat" | "image" | "video"; imageOutput: boolean })[] {
  return models.map((m) => {
    if (m.kind === "video" || isVideoModel(m.id)) {
      return { ...m, kind: "video" as const, imageOutput: m.imageOutput ?? false };
    }
    const capability = modelImageCapability(m.id);
    return {
      ...m,
      kind: m.kind ?? ((capability === "endpoint" ? "image" : "chat") as "chat" | "image"),
      imageOutput: m.imageOutput ?? capability === "chat",
    };
  });
}

export interface GenerateImagesOptions {
  apiBaseUrl: string;
  token: string;
  model: string;
  prompt: string;
  /**
   * How the model hands back pictures. "endpoint" (default) posts to
   * `/images/generations`; "chat" asks a chat model that draws — the picture
   * comes back attached to the assistant message.
   */
  route?: ImageCapability;
  /** Pictures to edit or use as reference (base64, no `data:` prefix). */
  inputImages?: { base64: string; mediaType: string }[];
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
  // Chat-message shape: { type: "image_url", image_url: { url } }.
  for (const key of ["image_url", "source", "inline_data"]) {
    const wrapper = rec[key];
    if (wrapper && typeof wrapper === "object") {
      const image = await toImage(wrapper, signal);
      if (image) return revised ? { ...image, revisedPrompt: revised } : image;
    }
  }
  return null;
}

/** Download a hosted result (providers that return URLs) into base64. */
async function fetchImageUrl(url: string, signal?: AbortSignal): Promise<GeneratedImage | null> {
  const res = await fetch(url, { headers: { "user-agent": deyinUserAgent() }, signal });
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

/** Bytes from base64 without Buffer, so this module stays browser-safe. */
function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Download a hosted image into base64. Providers that answer a generation with a
 * link — and chat models that attach one — need this before the picture can be
 * stored with the thread.
 */
export async function fetchImageAsBase64(url: string, signal?: AbortSignal): Promise<GeneratedImage | null> {
  return await fetchImageUrl(url, signal);
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
  // A chat model that draws has no images endpoint: ask it in a completion.
  if (opts.route === "chat") return await generateImagesViaChat(opts);
  // Editing an existing picture is a different endpoint with a multipart body.
  if (opts.inputImages && opts.inputImages.length > 0) return await editImages(opts);
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
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}`, "user-agent": deyinUserAgent() },
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

/**
 * Edit or extend existing pictures through the OpenAI-compatible
 * `POST /images/edits` endpoint (multipart). Used whenever the caller supplies
 * input images: "make the sky stormy", "turn this sketch into a logo".
 */
async function editImages(opts: GenerateImagesOptions): Promise<GeneratedImage[]> {
  const url = `${opts.apiBaseUrl.replace(/\/$/, "")}/images/edits`;
  const form = new FormData();
  form.set("model", opts.model);
  form.set("prompt", opts.prompt);
  form.set("n", String(opts.n ?? 1));
  if (opts.size) form.set("size", opts.size);
  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    if (value !== undefined && value !== null) form.set(key, String(value));
  }
  const inputs = opts.inputImages ?? [];
  inputs.forEach((image, index) => {
    const blob = new Blob([bytesFromBase64(image.base64)], { type: image.mediaType });
    // OpenAI takes repeated `image[]` parts for multi-image edits and a single
    // `image` otherwise; gateways accept both spellings of the single case.
    form.append(inputs.length > 1 ? "image[]" : "image", blob, `input-${index}.${extensionFor(image.mediaType)}`);
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.token}`, "user-agent": deyinUserAgent() },
    body: form,
    signal: opts.signal ?? AbortSignal.timeout(180_000),
  });
  if (res.status === 404 || res.status === 405) {
    throw new Error(`${opts.model} cannot edit images on this provider (no /images/edits endpoint).`);
  }
  if (!res.ok) throw new Error(`Image edit failed: ${await errorMessage(res)}`);
  const body = (await res.json().catch(() => null)) as unknown;
  const images = await parseImageResponse(body, opts.signal);
  if (images.length === 0) throw new Error("Image edit returned no image data.");
  return images;
}

/** File extension for a media type, for the multipart part filename. */
function extensionFor(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  return "png";
}

/**
 * Generate with a chat model that draws (Gemini flash-image / nano-banana): one
 * non-streamed completion asking for both modalities, with any input images
 * attached as content parts so the model can edit rather than start over.
 */
async function generateImagesViaChat(opts: GenerateImagesOptions): Promise<GeneratedImage[]> {
  const url = `${opts.apiBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const content: unknown[] = [{ type: "text", text: opts.prompt }];
  for (const image of opts.inputImages ?? []) {
    content.push({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } });
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}`, "user-agent": deyinUserAgent() },
    body: JSON.stringify({
      model: opts.model,
      messages: [{ role: "user", content }],
      modalities: ["text", "image"],
      ...(opts.extra ?? {}),
    }),
    signal: opts.signal ?? AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Image generation failed: ${await errorMessage(res)}`);
  const body = (await res.json().catch(() => null)) as
    | { choices?: { message?: { content?: unknown } }[] }
    | null;
  const message = body?.choices?.[0]?.message;
  const parts = imagesFromMessage(message);
  const images: GeneratedImage[] = [];
  for (const part of parts) {
    if (part.base64) {
      images.push({ base64: part.base64, mediaType: asMediaType(part.mediaType) });
      continue;
    }
    if (part.url) {
      const fetched = await fetchImageUrl(part.url, opts.signal);
      if (fetched) images.push(fetched);
    }
  }
  if (images.length === 0) {
    // The model answered in words instead of pixels — surface what it said.
    const said = typeof message?.content === "string" ? message.content.trim().slice(0, 200) : "";
    throw new Error(said ? `${opts.model} returned text, not an image: ${said}` : "The model returned no image data.");
  }
  return images.slice(0, Math.max(1, opts.n ?? 1));
}

/** Narrow an arbitrary media-type string onto the types the store accepts. */
function asMediaType(value: string): GeneratedMediaType {
  switch (value.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "image/jpeg";
    case "image/webp":
      return "image/webp";
    case "image/gif":
      return "image/gif";
    default:
      return "image/png";
  }
}
