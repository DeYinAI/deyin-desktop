import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * File-backed vector store: meta.json (chunk metadata + embedder id) plus
 * vectors.bin (packed Float32). Brute-force cosine search — plenty fast for
 * workspace-sized indexes (tens of thousands of chunks).
 */

export interface StoredChunk {
  path: string;
  startLine: number;
  endLine: number;
  /** Trimmed chunk text used for previews. */
  preview: string;
  /** Content hash of the source file at index time. */
  fileHash: string;
}

interface MetaFile {
  version: 1;
  embedder: string;
  dimensions: number;
  chunks: StoredChunk[];
  /** path -> content hash, for incremental sync. */
  files: Record<string, string>;
  savedAt: string;
}

export class VectorStore {
  private chunks: StoredChunk[] = [];
  private vectors: Float32Array = new Float32Array(0);
  private files = new Map<string, string>();

  constructor(
    private readonly dir: string,
    readonly embedderId: string,
    readonly dimensions: number,
  ) {}

  get chunkCount(): number {
    return this.chunks.length;
  }

  get fileCount(): number {
    return this.files.size;
  }

  fileHash(path: string): string | undefined {
    return this.files.get(path);
  }

  filePaths(): string[] {
    return [...this.files.keys()];
  }

  /** Load from disk; false when absent or built by a different embedder. */
  load(): boolean {
    try {
      const meta = JSON.parse(readFileSync(join(this.dir, "meta.json"), "utf8")) as MetaFile;
      if (meta.version !== 1 || meta.embedder !== this.embedderId || meta.dimensions !== this.dimensions) return false;
      const bin = readFileSync(join(this.dir, "vectors.bin"));
      const vectors = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
      if (vectors.length !== meta.chunks.length * this.dimensions) return false;
      this.chunks = meta.chunks;
      this.vectors = Float32Array.from(vectors);
      this.files = new Map(Object.entries(meta.files));
      return true;
    } catch {
      return false;
    }
  }

  save(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const meta: MetaFile = {
      version: 1,
      embedder: this.embedderId,
      dimensions: this.dimensions,
      chunks: this.chunks,
      files: Object.fromEntries(this.files),
      savedAt: new Date().toISOString(),
    };
    writeFileSync(join(this.dir, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
    writeFileSync(join(this.dir, "vectors.bin"), Buffer.from(this.vectors.buffer, this.vectors.byteOffset, this.vectors.byteLength), {
      mode: 0o600,
    });
  }

  clear(): void {
    this.chunks = [];
    this.vectors = new Float32Array(0);
    this.files.clear();
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Replace all chunks of one file. */
  setFile(path: string, hash: string, chunks: StoredChunk[], vectors: Float32Array[]): void {
    this.removeFile(path);
    this.files.set(path, hash);
    if (chunks.length === 0) return;
    const old = this.vectors;
    const next = new Float32Array(old.length + vectors.length * this.dimensions);
    next.set(old, 0);
    vectors.forEach((vec, i) => next.set(vec, old.length + i * this.dimensions));
    this.vectors = next;
    this.chunks.push(...chunks);
  }

  removeFile(path: string): void {
    if (!this.files.has(path) && !this.chunks.some((c) => c.path === path)) return;
    this.files.delete(path);
    const keep: number[] = [];
    this.chunks.forEach((chunk, i) => {
      if (chunk.path !== path) keep.push(i);
    });
    if (keep.length === this.chunks.length) return;
    const next = new Float32Array(keep.length * this.dimensions);
    keep.forEach((oldIndex, newIndex) => {
      next.set(this.vectors.subarray(oldIndex * this.dimensions, (oldIndex + 1) * this.dimensions), newIndex * this.dimensions);
    });
    this.chunks = keep.map((i) => this.chunks[i]!);
    this.vectors = next;
  }

  search(query: Float32Array, topK: number): { chunk: StoredChunk; score: number }[] {
    const scores: { index: number; score: number }[] = [];
    const dims = this.dimensions;
    for (let i = 0; i < this.chunks.length; i++) {
      let dot = 0;
      const base = i * dims;
      for (let d = 0; d < dims; d++) dot += this.vectors[base + d]! * query[d]!;
      scores.push({ index: i, score: dot });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK).map(({ index, score }) => ({ chunk: this.chunks[index]!, score }));
  }
}
