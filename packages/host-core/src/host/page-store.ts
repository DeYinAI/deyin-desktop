import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;

function safeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`Invalid ${label}.`);
  }
  return trimmed;
}

/** Escape text for a plain HTML title element. */
export function escapeHtmlTitle(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Wrap a body fragment in a minimal full HTML document when needed. */
export function wrapHtmlDocument(html: string, title?: string): string {
  const trimmed = html.trim();
  if (/^<!DOCTYPE/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return trimmed;
  const titleTag = title?.trim() ? `<title>${escapeHtmlTitle(title.trim())}</title>` : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${titleTag}</head><body>${trimmed}</body></html>`;
}

/**
 * Per-thread store for full-page HTML artifacts (one-page websites, landing pages).
 * Mirrors ImageStore: the agent writes here and the Preview panel reads by file name.
 */
export class PageStore {
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

  private safeFilePath(threadId: string, fileName: string): string {
    const dir = this.threadDir(threadId);
    if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
      throw new Error("Invalid page file name.");
    }
    const base = basename(fileName);
    if (!base || base === "." || base === "..") throw new Error("Invalid page file name.");
    const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_");
    const file = safe.endsWith(".html") ? safe : `${safe}.html`;
    const resolved = resolve(dir, file);
    const root = resolve(dir);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error("Page path escapes thread directory.");
    }
    return resolved;
  }

  writePage(threadId: string, fileName: string, html: string): { file: string; title: string } {
    const document = wrapHtmlDocument(html);
    if (Buffer.byteLength(document, "utf8") > MAX_BYTES) {
      throw new Error(`Page exceeds 2MB cap (${MAX_BYTES} bytes).`);
    }
    const file = this.safeFilePath(threadId, fileName);
    writeFileSync(file, document, "utf8");
    return { file, title: basename(file) };
  }

  readPage(threadId: string, fileName: string): string {
    const file = this.safeFilePath(threadId, fileName);
    if (!existsSync(file)) throw new Error(`Page not found: ${basename(file)}`);
    if (statSync(file).size > MAX_BYTES) throw new Error("Page file too large.");
    return readFileSync(file, "utf8");
  }
}
