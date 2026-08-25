/** Defaults for the optional Local Vision plugin (Ollama + moondream, ~1.7 GB). */
export const DEFAULT_LOCAL_VISION_MODEL = "moondream";
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
/** Match composer limits so IPC cannot accept oversized payloads. */
export const LOCAL_VISION_MAX_IMAGES = 4;
export const LOCAL_VISION_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface LocalVisionDescription {
  index: number;
  text: string;
}

export interface LocalVisionDescribeResult {
  ok: boolean;
  model?: string;
  descriptions?: LocalVisionDescription[];
  /** Full user message with embedded descriptions (when userText was passed). */
  prompt?: string;
  error?: string;
}

export interface LocalVisionStatus {
  pluginInstalled: boolean;
  pluginEnabled: boolean;
  ollamaReachable: boolean;
  modelAvailable: boolean;
  model: string;
  baseUrl: string;
}

export interface LocalVisionImage {
  mediaType: string;
  base64: string;
}

export interface LocalVisionConfig {
  baseUrl?: string;
  model?: string;
  prompt?: string;
  signal?: AbortSignal;
}

export interface OllamaHealth {
  reachable: boolean;
  modelAvailable: boolean;
}

const DEFAULT_PROMPT =
  "Describe this image in detail for a developer assistant. Include visible text, UI elements, layout, and anything relevant to answering the user's question.";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Restrict Ollama endpoints to loopback so image bytes never leave the machine. */
export function resolveLocalOllamaBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Invalid OLLAMA_BASE_URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OLLAMA_BASE_URL must use http or https.");
  }
  const host = url.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") {
    throw new Error("OLLAMA_BASE_URL must point to localhost (127.0.0.1 or localhost).");
  }
  return normalizeBaseUrl(baseUrl);
}

/** Validate image payloads before calling Ollama; returns an error message or null. */
export function validateLocalVisionImages(images: LocalVisionImage[]): string | null {
  if (images.length === 0) return "No images to describe.";
  if (images.length > LOCAL_VISION_MAX_IMAGES) return `At most ${LOCAL_VISION_MAX_IMAGES} images per message.`;
  for (const img of images) {
    const b64 = img.base64?.trim() ?? "";
    if (!b64) return "Invalid image payload.";
    const approxBytes = Math.floor((b64.length * 3) / 4);
    if (approxBytes > LOCAL_VISION_MAX_IMAGE_BYTES) return "Image exceeds the 5 MB limit.";
  }
  return null;
}

/** Check whether Ollama is up and the vision model is pulled. */
export async function checkOllamaVisionModel(
  baseUrl = DEFAULT_OLLAMA_BASE_URL,
  model = DEFAULT_LOCAL_VISION_MODEL,
  signal?: AbortSignal,
): Promise<OllamaHealth> {
  const root = resolveLocalOllamaBaseUrl(baseUrl);
  try {
    const res = await fetch(`${root}/api/tags`, { signal: signal ?? AbortSignal.timeout(5_000) });
    if (!res.ok) return { reachable: false, modelAvailable: false };
    const body = (await res.json()) as { models?: { name?: string }[] };
    const names = (body.models ?? []).map((m) => String(m.name ?? "").split(":")[0]);
    return { reachable: true, modelAvailable: names.includes(model) };
  } catch {
    return { reachable: false, modelAvailable: false };
  }
}

/** Describe one image through Ollama's chat API (vision models accept `images`). */
export async function describeImageViaOllama(
  image: LocalVisionImage,
  config: LocalVisionConfig = {},
): Promise<string> {
  const root = resolveLocalOllamaBaseUrl(config.baseUrl ?? DEFAULT_OLLAMA_BASE_URL);
  const model = config.model ?? DEFAULT_LOCAL_VISION_MODEL;
  const res = await fetch(`${root}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: config.signal ?? AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: "user",
          content: config.prompt ?? DEFAULT_PROMPT,
          images: [image.base64],
        },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Ollama vision request failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const body = (await res.json()) as { message?: { content?: string } };
  const text = body.message?.content?.trim();
  if (!text) throw new Error("Ollama returned an empty vision description.");
  return text;
}

/** Describe multiple attached images sequentially (moondream is small — one at a time). */
export async function describeImagesViaOllama(
  images: LocalVisionImage[],
  config: LocalVisionConfig = {},
): Promise<LocalVisionDescription[]> {
  const out: LocalVisionDescription[] = [];
  for (let i = 0; i < images.length; i++) {
    const text = await describeImageViaOllama(images[i]!, config);
    out.push({ index: i + 1, text });
  }
  return out;
}

/** Inject local vision text into the user message so a text-only chat model can reason about pictures. */
export function formatUserMessageWithLocalVision(
  userText: string,
  descriptions: LocalVisionDescription[],
): string {
  if (descriptions.length === 0) return userText;
  const blocks = descriptions.map((d) => `[Attached image ${d.index}]\n${d.text}`).join("\n\n");
  const prefix = userText.trim();
  return `${prefix}\n\n---\nLocal vision (on-device):\n\n${blocks}`.trim();
}
