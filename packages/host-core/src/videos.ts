/**
 * Text-to-video support: catalog classification plus the OpenAI-compatible
 * `POST /v1/videos` client with async polling. Browser-safe (fetch only).
 */

import type { ImageModelMeta } from "./images.js";
import { deyinUserAgent } from "./user-agent.js";

export type GeneratedVideoMediaType = "video/mp4" | "video/webm";

export interface GeneratedVideo {
  base64: string;
  mediaType: GeneratedVideoMediaType;
}

/** Model ids from known text-to-video families served by POST /v1/videos. */
const VIDEO_ID_RE =
  /(agnes[._-]?video|agnes.*video|video-2\.5|video-v|text-to-video|sora|kling|luma|runway|veo|minimax-video|wan-video|hunyuan-video|seedance|cogvideo|mochi)/i;

function isVideoToken(token: string): boolean {
  const t = token.trim().toLowerCase();
  return t === "video" || t === "videos" || t.startsWith("video/");
}

function isTextToken(token: string): boolean {
  const t = token.trim().toLowerCase();
  return t === "text" || t === "texts" || t.startsWith("text/") || t === "chat";
}

function saysVideoGeneration(value: unknown): boolean {
  if (typeof value === "string") {
    const s = value.toLowerCase().replace(/\s+/g, "-");
    return (
      s.includes("text-to-video") ||
      s.includes("text2video") ||
      s.includes("video-generation") ||
      s.includes("video_generation") ||
      s.includes("video-gen") ||
      s.includes("image-to-video") ||
      s.includes("image_to_video")
    );
  }
  if (Array.isArray(value)) return value.some(saysVideoGeneration);
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const [key, v] of Object.entries(rec)) {
      if (v === true && saysVideoGeneration(key)) return true;
      if (typeof v === "string" && saysVideoGeneration(v)) return true;
    }
  }
  return false;
}

function parseArrowModality(value: string): { input: string[]; output: string[] } | null {
  const match = /^([^-<>]*)(?:->|→|=>)(.+)$/.exec(value.trim());
  if (!match) return null;
  const split = (side: string) => side.split(/[+,|/]/).map((s) => s.trim()).filter(Boolean);
  return { input: split(match[1] ?? ""), output: split(match[2] ?? "") };
}

function tokensOf(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[+,|]/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(tokensOf);
  return [];
}

function collectVideoModalities(meta?: ImageModelMeta): { outputVideo: boolean; declared: boolean } {
  const out = { outputVideo: false, declared: false };
  if (!meta) return out;

  const sources: unknown[] = [meta];
  const arch = (meta as Record<string, unknown>).architecture;
  if (arch && typeof arch === "object") sources.push(arch);

  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const rec = source as Record<string, unknown>;

    for (const key of ["modality", "modalities", "type"]) {
      const raw = rec[key];
      if (typeof raw === "string") {
        const arrow = parseArrowModality(raw);
        if (arrow) {
          out.declared = true;
          if (arrow.output.some(isVideoToken)) out.outputVideo = true;
        } else if (isVideoToken(raw)) {
          out.declared = true;
          out.outputVideo = true;
        }
      }
    }

    const outputs = tokensOf(rec.output_modalities ?? (rec as { outputModalities?: unknown }).outputModalities);
    if (outputs.length > 0) {
      out.declared = true;
      if (outputs.some(isVideoToken)) out.outputVideo = true;
    }

    for (const key of ["type", "modality", "modalities"]) {
      const raw = rec[key];
      if (raw === undefined || (typeof raw === "string" && parseArrowModality(raw))) continue;
      const tokens = tokensOf(raw);
      if (tokens.some(isVideoToken)) {
        out.declared = true;
        out.outputVideo = true;
      } else if (tokens.some(isTextToken)) {
        out.declared = true;
      }
    }

    for (const key of ["capabilities", "features", "tags", "supported_parameters"]) {
      if (saysVideoGeneration(rec[key])) {
        out.declared = true;
        out.outputVideo = true;
      }
    }
  }
  return out;
}

/** True when a model generates video via POST /v1/videos (not chat completions). */
export function isVideoModel(id: string, meta?: ImageModelMeta): boolean {
  const m = collectVideoModalities(meta);
  if (m.outputVideo) return true;
  if (m.declared) return false;
  return VIDEO_ID_RE.test(id);
}

/** Catalog `kind` or id heuristic — use at send time when the cache may predate video classification. */
export function modelIsVideo(id: string, kind?: string, meta?: ImageModelMeta): boolean {
  return kind === "video" || isVideoModel(id, meta);
}

export interface GenerateVideoOptions {
  apiBaseUrl: string;
  token: string;
  model: string;
  prompt: string;
  /** Reference image for image-to-video (base64, no data: prefix). */
  inputImages?: { base64: string; mediaType: string }[];
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Poll interval in ms (default 8000). */
  pollIntervalMs?: number;
  /** Max wait before giving up in ms (default 30 min). */
  maxWaitMs?: number;
  onProgress?: (status: string, progress?: number) => void;
}

type VideoTaskStatus = "queued" | "in_progress" | "processing" | "completed" | "failed" | "cancelled";

interface VideoTaskBody {
  id?: string;
  task_id?: string;
  video_id?: string;
  status?: string;
  progress?: number;
  url?: string;
  video_url?: string;
  output?: unknown;
  data?: unknown;
  error?: { message?: string } | string;
  message?: string;
  remixed_from_video_id?: string;
}

const BASE64_RE = /^[A-Za-z0-9+/\r\n]+={0,2}$/;

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sniffVideoMediaType(base64: string): GeneratedVideoMediaType {
  const bytes = bytesFromBase64(base64.slice(0, 32));
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "video/webm";
  }
  return "video/mp4";
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message);
    if (message) return `${message} (HTTP ${res.status})`;
  } catch {
    // Not JSON.
  }
  return text.trim().length > 0 ? `${text.trim().slice(0, 300)} (HTTP ${res.status})` : `HTTP ${res.status}`;
}

function normalizeStatus(value: string | undefined): VideoTaskStatus | null {
  if (!value) return null;
  const s = value.toLowerCase().replace(/\s+/g, "_");
  if (s === "queued" || s === "pending") return "queued";
  if (s === "in_progress" || s === "processing" || s === "running") return "in_progress";
  if (s === "completed" || s === "succeeded" || s === "success") return "completed";
  if (s === "failed" || s === "error") return "failed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return null;
}

function taskIds(body: VideoTaskBody): string[] {
  const ids = [body.video_id, body.id, body.task_id].filter((v): v is string => typeof v === "string" && v.length > 0);
  return [...new Set(ids)];
}

async function extractVideoUrl(entry: unknown, signal?: AbortSignal): Promise<string | null> {
  if (typeof entry === "string") {
    if (/^https?:\/\//i.test(entry)) return entry;
    if (BASE64_RE.test(entry) && entry.length > 128) return null;
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  for (const key of ["url", "video_url", "remixed_from_video_id", "download_url", "output_url"]) {
    if (typeof rec[key] === "string" && /^https?:\/\//i.test(rec[key] as string)) return rec[key] as string;
  }
  for (const key of ["output", "result", "video", "data"]) {
    const nested = rec[key];
    if (nested !== undefined) {
      const url = await extractVideoUrl(nested, signal);
      if (url) return url;
    }
  }
  if (Array.isArray(rec.data)) {
    for (const item of rec.data) {
      const url = await extractVideoUrl(item, signal);
      if (url) return url;
    }
  }
  for (const key of ["b64_json", "base64", "video"]) {
    const value = rec[key];
    if (typeof value === "string" && BASE64_RE.test(value) && value.length > 128) return null;
  }
  return null;
}

async function fetchVideoUrl(url: string, signal?: AbortSignal): Promise<GeneratedVideo | null> {
  const res = await fetch(url, { headers: { "user-agent": deyinUserAgent() }, signal });
  if (!res.ok) return null;
  const buffer = await res.arrayBuffer();
  const base64 = base64FromBytes(new Uint8Array(buffer));
  const declared = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  const mediaType: GeneratedVideoMediaType =
    declared === "video/webm" ? "video/webm" : declared === "video/mp4" ? "video/mp4" : sniffVideoMediaType(base64);
  return { base64, mediaType };
}

async function videoFromBody(body: unknown, signal?: AbortSignal): Promise<GeneratedVideo | null> {
  if (!body || typeof body !== "object") return null;
  const rec = body as Record<string, unknown>;

  for (const key of ["b64_json", "base64", "video"]) {
    const value = rec[key];
    if (typeof value === "string" && BASE64_RE.test(value) && value.length > 128) {
      return { base64: value, mediaType: sniffVideoMediaType(value) };
    }
  }

  const url = await extractVideoUrl(body, signal);
  if (url) return await fetchVideoUrl(url, signal);
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function pollVideoTask(
  apiBaseUrl: string,
  token: string,
  ids: string[],
  opts: GenerateVideoOptions,
): Promise<GeneratedVideo> {
  const base = apiBaseUrl.replace(/\/$/, "");
  const pollMs = opts.pollIntervalMs ?? 8_000;
  const deadline = Date.now() + (opts.maxWaitMs ?? 1_800_000);
  const pollPaths = (id: string) => [`${base}/videos/${encodeURIComponent(id)}`, `${base}/agnesapi?video_id=${encodeURIComponent(id)}`];

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");

    for (const id of ids) {
      for (const path of pollPaths(id)) {
        try {
          const res = await fetch(path, {
            headers: { authorization: `Bearer ${token}`, "user-agent": deyinUserAgent() },
            signal: opts.signal ?? AbortSignal.timeout(60_000),
          });
          if (!res.ok) continue;
          const body = (await res.json().catch(() => null)) as VideoTaskBody | null;
          if (!body) continue;

          const status = normalizeStatus(body.status);
          opts.onProgress?.(body.status ?? "unknown", typeof body.progress === "number" ? body.progress : undefined);

          if (status === "failed" || status === "cancelled") {
            const err =
              typeof body.error === "string"
                ? body.error
                : (body.error?.message ?? body.message ?? "Video generation failed.");
            throw new Error(err);
          }

          const video = await videoFromBody(body, opts.signal);
          if (video) return video;

          if (status === "completed") {
            const url = await extractVideoUrl(body, opts.signal);
            if (url) {
              const fetched = await fetchVideoUrl(url, opts.signal);
              if (fetched) return fetched;
            }
            throw new Error("Video generation completed but returned no video data.");
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          if (err instanceof Error && err.message.includes("Video generation")) throw err;
        }
      }
    }

    await sleep(pollMs, opts.signal);
  }

  throw new Error("Video generation timed out. Try again or reduce duration.");
}

/**
 * Generate a video from a prompt through POST /v1/videos, polling until the
 * async task completes and downloading the result.
 */
export async function generateVideo(opts: GenerateVideoOptions): Promise<GeneratedVideo> {
  const url = `${opts.apiBaseUrl.replace(/\/$/, "")}/videos`;
  const payload: Record<string, unknown> = {
    model: opts.model,
    prompt: opts.prompt,
    ...(opts.extra ?? {}),
  };

  const inputs = opts.inputImages ?? [];
  if (inputs.length === 1) {
    const image = inputs[0]!;
    payload.image = `data:${image.mediaType};base64,${image.base64}`;
  } else if (inputs.length > 1) {
    payload.extra_body = {
      ...(typeof payload.extra_body === "object" && payload.extra_body ? payload.extra_body : {}),
      image: inputs.map((image) => `data:${image.mediaType};base64,${image.base64}`),
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.token}`,
      "user-agent": deyinUserAgent(),
    },
    body: JSON.stringify(payload),
    signal: opts.signal ?? AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Video generation failed: ${await errorMessage(res)}`);

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.startsWith("video/")) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    const base64 = base64FromBytes(bytes);
    return { base64, mediaType: contentType.includes("webm") ? "video/webm" : "video/mp4" };
  }

  const body = (await res.json().catch(() => null)) as VideoTaskBody | null;
  if (!body) throw new Error("Video generation returned an empty response.");

  const immediate = await videoFromBody(body, opts.signal);
  if (immediate) return immediate;

  const status = normalizeStatus(body.status);
  if (status === "failed" || status === "cancelled") {
    const err =
      typeof body.error === "string" ? body.error : (body.error?.message ?? body.message ?? "Video generation failed.");
    throw new Error(err);
  }

  const ids = taskIds(body);
  if (ids.length === 0) throw new Error("Video generation returned no task id to poll.");
  opts.onProgress?.(body.status ?? "queued", typeof body.progress === "number" ? body.progress : undefined);
  return await pollVideoTask(opts.apiBaseUrl, opts.token, ids, opts);
}
