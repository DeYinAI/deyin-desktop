import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

/** Generated images are capped well under the IPC/WebSocket payload budget. */
const MAX_BYTES = 12 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface SavedImage {
  /** File name to embed in the ::deyin-inline-image directive. */
  file: string;
  /** Absolute path on disk. */
  path: string;
  mediaType: string;
  bytes: number;
}

export interface StoredImage {
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

/**
 * Per-thread store for generated images, mirroring the visualization store: the
 * agent (or a direct image-model run) writes bytes here and the chat embeds them
 * by file name, so a thread still renders its pictures after a restart.
 */
export class ImageStore {
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
      throw new Error("Invalid image file name.");
    }
    const base = basename(fileName);
    if (!base || base === "." || base === "..") throw new Error("Invalid image file name.");
    let safe = base.replace(/[^a-zA-Z0-9._-]/g, "_");
    if (!MEDIA_TYPES[extname(safe).toLowerCase()]) safe += EXTENSIONS[mediaType ?? "image/png"] ?? ".png";
    const resolved = resolve(dir, safe);
    const root = resolve(dir);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error("Image path escapes thread directory.");
    }
    return resolved;
  }

  /** Write base64 image bytes; returns the file name to embed in chat. */
  save(threadId: string, input: { base64: string; mediaType?: string; fileName?: string }): SavedImage {
    const mediaType = input.mediaType && EXTENSIONS[input.mediaType] ? input.mediaType : "image/png";
    const bytes = Buffer.from(input.base64, "base64");
    if (bytes.byteLength === 0) throw new Error("Image data is empty.");
    if (bytes.byteLength > MAX_BYTES) throw new Error(`Image exceeds the ${Math.round(MAX_BYTES / 1024 / 1024)}MB cap.`);
    const name = input.fileName ?? `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const path = this.safeFilePath(threadId, name, mediaType);
    writeFileSync(path, bytes);
    return { file: basename(path), path, mediaType, bytes: bytes.byteLength };
  }

  /** Read one stored image back as base64 for rendering. */
  read(threadId: string, fileName: string): StoredImage {
    const path = this.safeFilePath(threadId, fileName);
    if (!existsSync(path)) throw new Error(`Image not found: ${basename(path)}`);
    if (statSync(path).size > MAX_BYTES) throw new Error("Image file too large.");
    return {
      base64: readFileSync(path).toString("base64"),
      mediaType: MEDIA_TYPES[extname(path).toLowerCase()] ?? "image/png",
    };
  }

  /** File names stored for a thread, oldest first. */
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

/** `data:` URL for a stored image, ready for an <img src>. */
export function imageDataUrl(image: StoredImage): string {
  return `data:${image.mediaType};base64,${image.base64}`;
}
