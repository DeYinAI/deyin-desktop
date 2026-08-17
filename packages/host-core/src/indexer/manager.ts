import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { IndexSearchHit, IndexStatus } from "../types.js";
import { chunkFile, isIndexableFile, looksBinary } from "./chunker.js";
import { createEmbedder, type Embedder } from "./embedder.js";
import { IgnoreMatcher } from "./ignore.js";
import { VectorStore, type StoredChunk } from "./store.js";

/**
 * Live local workspace index. On open: full sync (only changed files re-embed
 * thanks to content hashes). Afterwards: fs.watch where recursive watching is
 * supported (macOS/Windows), with a polling rescan fallback elsewhere (Linux),
 * both debounced. Everything runs in-process with cooperative yields — the
 * hash embedder is sub-millisecond per chunk.
 */

const POLL_MS = 60_000;
const DEBOUNCE_MS = 1_500;
const MAX_FILES = 20_000;

export interface IndexManagerOptions {
  /** Directory that holds per-workspace index folders. */
  indexRoot: string;
  /** Model cache directory for the optional ONNX embedder. */
  modelCacheDir?: string;
  isEnabled: () => boolean;
  onStatus?: (status: IndexStatus) => void;
}

export class IndexManager {
  private root: string | null = null;
  private store: VectorStore | null = null;
  private embedder: Embedder | null = null;
  private ignore: IgnoreMatcher | null = null;
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private pendingSync = false;
  private state: IndexStatus["state"] = "no-workspace";
  private error: string | undefined;
  private lastSync: string | null = null;
  private progress: { done: number; total: number } | undefined;

  constructor(private readonly opts: IndexManagerOptions) {}

  status(): IndexStatus {
    return {
      state: this.opts.isEnabled() ? this.state : "disabled",
      root: this.root,
      files: this.store?.fileCount ?? 0,
      chunks: this.store?.chunkCount ?? 0,
      lastSync: this.lastSync,
      progress: this.progress,
      model: this.embedder?.id ?? "hash-v1",
      watching: this.watcher !== null || this.pollTimer !== null,
      error: this.error,
    };
  }

  private emit(): void {
    this.opts.onStatus?.(this.status());
  }

  /** Point the index at a workspace (null tears down). */
  async setRoot(root: string | null): Promise<void> {
    if (this.root === root) return;
    this.stopWatching();
    this.root = root;
    this.store = null;
    this.ignore = null;
    this.state = root ? "scanning" : "no-workspace";
    this.error = undefined;
    this.emit();
    if (!root || !this.opts.isEnabled()) return;

    this.embedder ??= await createEmbedder(this.opts.modelCacheDir);
    const dirName = createHash("sha256").update(root).digest("hex").slice(0, 16);
    this.store = new VectorStore(join(this.opts.indexRoot, dirName), this.embedder.id, this.embedder.dimensions);
    this.store.load();
    this.ignore = new IgnoreMatcher(root);
    await this.sync();
    this.startWatching();
  }

  async rebuild(): Promise<void> {
    if (!this.root || !this.store) return;
    this.store.clear();
    this.ignore = new IgnoreMatcher(this.root);
    await this.sync();
  }

  /** Re-check enabled state (settings toggle). */
  async refresh(): Promise<void> {
    if (!this.opts.isEnabled()) {
      this.stopWatching();
      this.emit();
      return;
    }
    if (this.root && !this.store) {
      const root = this.root;
      this.root = null;
      await this.setRoot(root);
    } else {
      this.startWatching();
      this.emit();
    }
  }

  async search(query: string, topK: number): Promise<IndexSearchHit[]> {
    if (!this.store || !this.embedder || this.store.chunkCount === 0) return [];
    const [vector] = await this.embedder.embed([query]);
    return this.store.search(vector!, topK).map(({ chunk, score }) => ({
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score,
      preview: chunk.preview,
    }));
  }

  /* Sync ---------------------------------------------------------------- */

  private async sync(): Promise<void> {
    if (!this.root || !this.store || !this.embedder || !this.ignore) return;
    if (this.syncing) {
      this.pendingSync = true;
      return;
    }
    this.syncing = true;
    this.state = "scanning";
    this.error = undefined;
    this.emit();

    try {
      const files = await this.listFiles(this.root);
      const seen = new Set<string>();
      const stale: { rel: string; abs: string; hash: string }[] = [];

      for (const file of files) {
        seen.add(file.rel);
        if (this.store.fileHash(file.rel) !== file.hash) stale.push(file);
      }
      for (const known of this.store.filePaths()) {
        if (!seen.has(known)) this.store.removeFile(known);
      }

      this.state = "indexing";
      this.progress = { done: 0, total: stale.length };
      this.emit();

      for (const file of stale) {
        await this.indexFile(file.rel, file.abs, file.hash);
        this.progress = { done: (this.progress?.done ?? 0) + 1, total: stale.length };
        if ((this.progress.done & 15) === 0) {
          this.emit();
          await new Promise((r) => setImmediate(r));
        }
      }

      this.store.save();
      this.lastSync = new Date().toISOString();
      this.state = "ready";
      this.progress = undefined;
    } catch (err) {
      this.state = "error";
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.syncing = false;
      this.emit();
      if (this.pendingSync) {
        this.pendingSync = false;
        void this.sync();
      }
    }
  }

  private async indexFile(rel: string, abs: string, hash: string): Promise<void> {
    if (!this.store || !this.embedder) return;
    let raw: Buffer;
    try {
      raw = await readFile(abs);
    } catch {
      this.store.removeFile(rel);
      return;
    }
    if (looksBinary(raw)) return;
    const chunks = chunkFile(rel, raw.toString("utf8"));
    if (chunks.length === 0) {
      this.store.setFile(rel, hash, [], []);
      return;
    }
    const vectors = await this.embedder.embed(chunks.map((c) => c.text));
    const stored: StoredChunk[] = chunks.map((c) => ({
      path: c.path,
      startLine: c.startLine,
      endLine: c.endLine,
      preview: c.text.split("\n").slice(0, 8).join("\n").slice(0, 400),
      fileHash: hash,
    }));
    this.store.setFile(rel, hash, stored, vectors);
  }

  /** Walk the workspace; hash = "mtimeMs-size", a cheap reliable change detector. */
  private async listFiles(root: string): Promise<{ rel: string; abs: string; hash: string }[]> {
    const out: { rel: string; abs: string; hash: string }[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (out.length >= MAX_FILES) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= MAX_FILES) return;
        const abs = join(dir, entry.name);
        const rel = relative(root, abs).split(sep).join("/");
        if (entry.isDirectory()) {
          if (!this.ignore!.ignored(rel, true)) await walk(abs);
          continue;
        }
        if (!entry.isFile() || this.ignore!.ignored(rel, false)) continue;
        let info;
        try {
          info = await stat(abs);
        } catch {
          continue;
        }
        if (!isIndexableFile(entry.name, info.size)) continue;
        out.push({ rel, abs, hash: `${info.mtimeMs}-${info.size}` });
      }
    };
    await walk(root);
    return out;
  }

  /* Watching -------------------------------------------------------------- */

  private startWatching(): void {
    if (!this.root || this.watcher || this.pollTimer || !this.opts.isEnabled()) return;
    try {
      // Recursive fs.watch works on macOS/Windows; Linux throws.
      this.watcher = watch(this.root, { recursive: true }, () => this.scheduleSync());
      this.watcher.on("error", () => {
        this.stopWatching();
        this.pollTimer = setInterval(() => this.scheduleSync(), POLL_MS);
        (this.pollTimer as { unref?: () => void }).unref?.();
      });
    } catch {
      this.pollTimer = setInterval(() => this.scheduleSync(), POLL_MS);
      (this.pollTimer as { unref?: () => void }).unref?.();
    }
    this.emit();
  }

  private stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private scheduleSync(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.sync(), DEBOUNCE_MS);
  }

  dispose(): void {
    this.stopWatching();
  }
}
