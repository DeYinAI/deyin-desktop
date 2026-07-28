/** Code chunking for the local index: line windows with overlap. */

export interface Chunk {
  /** Workspace-relative path (forward slashes). */
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

const WINDOW = 60;
const OVERLAP = 10;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_CHUNK_CHARS = 6_000;

const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "css", "scss", "less", "html", "vue", "svelte",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "lua", "zig",
  "md", "mdx", "txt", "yaml", "yml", "toml", "ini", "cfg", "env", "sh", "bash", "zsh", "fish", "ps1",
  "sql", "graphql", "proto", "prisma", "dockerfile", "makefile", "cmake", "gradle", "tf", "hcl", "xml", "svg",
]);

export function isIndexableFile(name: string, sizeBytes: number): boolean {
  if (sizeBytes > MAX_FILE_BYTES || sizeBytes === 0) return false;
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower === "makefile") return true;
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  return TEXT_EXTENSIONS.has(ext);
}

export function looksBinary(sample: Buffer): boolean {
  const limit = Math.min(sample.length, 8_192);
  for (let i = 0; i < limit; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

/** Split file content into overlapping line windows. */
export function chunkFile(relPath: string, content: string): Chunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) return [];
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += WINDOW - OVERLAP) {
    const end = Math.min(start + WINDOW, lines.length);
    const text = lines.slice(start, end).join("\n").slice(0, MAX_CHUNK_CHARS);
    if (text.trim().length > 0) {
      chunks.push({ path: relPath, startLine: start + 1, endLine: end, text });
    }
    if (end >= lines.length) break;
  }
  return chunks;
}
