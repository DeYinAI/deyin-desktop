/**
 * Local embedding backends. The default is a fast, dependency-free hashed
 * n-gram embedder (deterministic, offline, no model download). When the
 * optional `@huggingface/transformers` package is installed, a MiniLM ONNX
 * model is used instead for true semantic vectors — same interface, so the
 * upgrade is drop-in.
 */

export interface Embedder {
  /** Identifier persisted with the index; a mismatch triggers a rebuild. */
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

const DIM = 384;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tokenizeCode(text: string): string[] {
  // Split identifiers on camelCase / snake_case so `getUserName` ≈ "get user name".
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && t.length < 40);
}

/** Hashed unigram+bigram bag-of-words with TF damping, L2-normalized. */
export class HashEmbedder implements Embedder {
  readonly id = "hash-v1";
  readonly dimensions = DIM;

  embedOne(text: string): Float32Array {
    const vec = new Float32Array(DIM);
    const tokens = tokenizeCode(text);
    for (let i = 0; i < tokens.length; i++) {
      const uni = tokens[i]!;
      vec[fnv1a(uni) % DIM]! += 1;
      if (i + 1 < tokens.length) {
        vec[fnv1a(`${uni}_${tokens[i + 1]}`) % DIM]! += 0.75;
      }
    }
    // Sub-linear TF then L2 norm.
    let sum = 0;
    for (let i = 0; i < DIM; i++) {
      vec[i] = Math.sqrt(vec[i]!);
      sum += vec[i]! * vec[i]!;
    }
    const norm = Math.sqrt(sum) || 1;
    for (let i = 0; i < DIM; i++) vec[i]! /= norm;
    return vec;
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map((t) => this.embedOne(t)));
  }
}

interface TransformersPipeline {
  (texts: string[], opts: { pooling: "mean"; normalize: boolean }): Promise<{ tolist(): number[][] }>;
}

/** ONNX MiniLM embedder via optional @huggingface/transformers. */
class TransformersEmbedder implements Embedder {
  readonly id = "minilm-l6-v2";
  readonly dimensions = 384;
  constructor(private readonly pipe: TransformersPipeline) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    const output = await this.pipe(texts, { pooling: "mean", normalize: true });
    return output.tolist().map((row) => Float32Array.from(row));
  }
}

/**
 * Best available local embedder: the ONNX model when @huggingface/transformers
 * is installed (downloads the model once into cacheDir), else the hash backend.
 */
export async function createEmbedder(cacheDir?: string): Promise<Embedder> {
  try {
    const mod = (await import("@huggingface/transformers" as string)) as {
      pipeline?: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
      env?: { cacheDir?: string };
    };
    if (mod.pipeline) {
      if (mod.env && cacheDir) mod.env.cacheDir = cacheDir;
      const pipe = (await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        dtype: "q8",
      })) as unknown as TransformersPipeline;
      return new TransformersEmbedder(pipe);
    }
  } catch {
    // Package not installed or model download failed — hash embedder still works offline.
  }
  return new HashEmbedder();
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot; // vectors are L2-normalized
}
