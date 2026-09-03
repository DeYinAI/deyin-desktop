import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

/** Generated videos are capped below typical IPC/WebSocket payload budgets. */
const MAX_BYTES = 100 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

const MEDIA_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export interface SavedVideo {
  /** File name to embed in the ::deyin-inline-video directive. */
  file: string;
  path: string;
  mediaType: string;
  bytes: number;
}

export interface StoredVideo {
  base64: string;
  mediaType: string;
}

function safeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`Invalid ${label}.`);
  }
  return trimmed;
}

/** Per-thread store for generated videos, mirroring the image store. */
export class VideoStore {
  private root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(this.root, { recursive: true });
  }

  threadDir(threadId: string): string {
    const dir = join(this.root, safeSegment(threadId, "thread id"));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private safeFilePath(threadId: string, fileName: string, mediaType?: string): string {
    const dir = this.threadDir(threadId);
    if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
      throw new Error("Invalid video file name.");
    }
    const base = basename(fileName);
    if (!base || base === "." || base === "..") throw new Error("Invalid video file name.");
    let safe = base.replace(/[^a-zA-Z0-9._-]/g, "_");
    if (!MEDIA_TYPES[extname(safe).toLowerCase()]) safe += EXTENSIONS[mediaType ?? "video/mp4"] ?? ".mp4";
    const resolved = resolve(dir, safe);
    const root = resolve(dir);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error("Video path escapes thread directory.");
    }
    return resolved;
  }

  save(threadId: string, input: { base64: string; mediaType?: string; fileName?: string }): SavedVideo {
    const mediaType = input.mediaType && EXTENSIONS[input.mediaType] ? input.mediaType : "video/mp4";
    const bytes = Buffer.from(input.base64, "base64");
    if (bytes.byteLength === 0) throw new Error("Video data is empty.");
    if (bytes.byteLength > MAX_BYTES) {
      throw new Error(`Video exceeds the ${Math.round(MAX_BYTES / 1024 / 1024)}MB cap.`);
    }
    const name = input.fileName ?? `vid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const path = this.safeFilePath(threadId, name, mediaType);
    writeFileSync(path, bytes);
    return { file: basename(path), path, mediaType, bytes: bytes.byteLength };
  }

  read(threadId: string, fileName: string): StoredVideo {
    const path = this.safeFilePath(threadId, fileName);
    if (!existsSync(path)) throw new Error(`Video not found: ${basename(path)}`);
    if (statSync(path).size > MAX_BYTES) throw new Error("Video file too large.");
    return {
      base64: readFileSync(path).toString("base64"),
      mediaType: MEDIA_TYPES[extname(path).toLowerCase()] ?? "video/mp4",
    };
  }

  list(threadId: string): string[] {
    try {
      return readdirSync(this.threadDir(threadId))
        .filter((f) => MEDIA_TYPES[extname(f).toLowerCase()] !== undefined)
        .sort();
    } catch {
      return [];
    }
  }
}

/** `data:` URL for a stored video, ready for a <video src>. */
export function videoDataUrl(video: StoredVideo): string {
  return `data:${video.mediaType};base64,${video.base64}`;
}
