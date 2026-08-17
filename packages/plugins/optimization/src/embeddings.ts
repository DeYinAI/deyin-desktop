/**
 * DeYinAI Embedding service.
 * Prefers ONNX (deyinai-embedding.onnx) when present; otherwise uses a hashed
 * n-gram embedder tuned for code/tool text (offline, zero deps).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface EmbedOptions {
  instruction?: string;
  dimensions?: number;
  normalize?: boolean;
}

export interface EmbeddingBackend {
  readonly id: string;
  readonly dimensions: number;
  embed(text: string, options?: EmbedOptions): Promise<Float32Array>;
  dispose?(): void;
}

const HASH_DIM = 384;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_./\\-]+/)
    .filter((t) => t.length > 1 && t.length < 64);
}

function l2normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i++) vec[i]! /= norm;
  return vec;
}

/** Fast offline embedder — same family as host-core HashEmbedder. */
export class HashEmbeddingBackend implements EmbeddingBackend {
  readonly id = "deyinai-hash-v1";
  readonly dimensions = HASH_DIM;

  async embed(text: string, options?: EmbedOptions): Promise<Float32Array> {
    const input = options?.instruction ? `Instruct: ${options.instruction}\nQuery:${text}` : text;
    const vec = new Float32Array(HASH_DIM);
    const tokens = tokenize(input);
    for (let i = 0; i < tokens.length; i++) {
      const uni = tokens[i]!;
      vec[fnv1a(uni) % HASH_DIM]! += 1;
      if (i + 1 < tokens.length) vec[fnv1a(`${uni}_${tokens[i + 1]}`) % HASH_DIM]! += 0.75;
    }
    for (let i = 0; i < HASH_DIM; i++) vec[i] = Math.sqrt(vec[i]!);
    return l2normalize(vec);
  }
}

// ONNX backend deferred until tokenizer assets ship with the model pack.
// Creating InferenceSession without a working embed path leaked native memory.

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

export class EmbeddingService {
  private backend: EmbeddingBackend;
  private ready = false;

  constructor(private readonly modelDir: string) {
    this.backend = new HashEmbeddingBackend();
  }

  get id(): string {
    return this.backend.id;
  }

  get dimensions(): number {
    return this.backend.dimensions;
  }

  async initialize(): Promise<{ backend: string; modelPresent: boolean }> {
    const onnxPath = join(this.modelDir, "deyinai-embedding.onnx");
    const modelPresent = existsSync(onnxPath);
    // ONNX path requires a bundled tokenizer that is not shipped yet.
    // Detect the model file for status, but do not create an InferenceSession
    // (would leak native memory while still falling back to hash).
    this.backend = new HashEmbeddingBackend();
    this.ready = true;
    return { backend: this.backend.id, modelPresent };
  }

  async embed(text: string, options?: EmbedOptions): Promise<Float32Array> {
    if (!this.ready) await this.initialize();
    return this.backend.embed(text, options);
  }

  async embedBatch(texts: string[], options?: EmbedOptions): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const t of texts) out.push(await this.embed(t, options));
    return out;
  }

  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    return cosineSimilarity(a, b);
  }

  dispose(): void {
    this.backend.dispose?.();
  }
}
