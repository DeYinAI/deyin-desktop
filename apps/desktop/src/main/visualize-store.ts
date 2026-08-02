import { basename, join, resolve, sep } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";

const MAX_BYTES = 2 * 1024 * 1024;

function safeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`Invalid ${label}.`);
  }
  return trimmed;
}

/** Manages HTML visualization artifacts per thread. */
export class VisualizeStore {
  private root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(this.root, { recursive: true });
  }

  threadDir(threadId: string): string {
    const safeThread = safeSegment(threadId, "thread id");
    const dir = join(this.root, safeThread);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private safeFilePath(threadId: string, fileName: string): string {
    const dir = this.threadDir(threadId);
    if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
      throw new Error("Invalid visualization file name.");
    }
    const base = basename(fileName);
    if (!base || base === "." || base === "..") throw new Error("Invalid visualization file name.");
    const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_");
    const file = safe.endsWith(".html") ? safe : `${safe}.html`;
    const resolved = resolve(dir, file);
    const root = resolve(dir);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error("Visualization path escapes thread directory.");
    }
    return resolved;
  }

  writeFragment(threadId: string, fileName: string, html: string): { file: string; title: string } {
    if (Buffer.byteLength(html, "utf8") > MAX_BYTES) {
      throw new Error(`Visualization exceeds 2MB cap (${MAX_BYTES} bytes).`);
    }
    const file = this.safeFilePath(threadId, fileName);
    writeFileSync(file, html, "utf8");
    return { file, title: basename(file) };
  }

  readFragment(threadId: string, fileName: string): string {
    const file = this.safeFilePath(threadId, fileName);
    if (!existsSync(file)) throw new Error(`Visualization not found: ${basename(file)}`);
    if (statSync(file).size > MAX_BYTES) throw new Error("Visualization file too large.");
    return readFileSync(file, "utf8");
  }
}
