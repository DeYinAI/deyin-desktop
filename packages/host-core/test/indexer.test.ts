import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chunkFile, isIndexableFile, looksBinary } from "../src/indexer/chunker.js";
import { HashEmbedder, cosineSimilarity } from "../src/indexer/embedder.js";
import { IgnoreMatcher } from "../src/indexer/ignore.js";
import { IndexManager } from "../src/indexer/manager.js";
import { VectorStore } from "../src/indexer/store.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deyin-index-"));
}

test("chunker windows lines with overlap and skips binaries", () => {
  const lines = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join("\n");
  const chunks = chunkFile("src/a.ts", lines);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0]!.startLine, 1);
  assert.equal(chunks[0]!.endLine, 60);
  // Overlap: the second chunk starts before the first ends.
  assert.ok(chunks[1]!.startLine < chunks[0]!.endLine);

  assert.ok(isIndexableFile("index.ts", 100));
  assert.ok(!isIndexableFile("photo.png", 100));
  assert.ok(!isIndexableFile("big.ts", 10 * 1024 * 1024));
  assert.ok(looksBinary(Buffer.from([0x50, 0x00, 0x4b])));
  assert.ok(!looksBinary(Buffer.from("plain text")));
});

test("hash embedder is deterministic, normalized and ranks related text higher", async () => {
  const embedder = new HashEmbedder();
  const [a1] = await embedder.embed(["function parseSettings(json) { return JSON.parse(json); }"]);
  const [a2] = await embedder.embed(["function parseSettings(json) { return JSON.parse(json); }"]);
  assert.deepEqual([...a1!], [...a2!]);
  const norm = Math.sqrt([...a1!].reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-5);

  const [query, related, unrelated] = await embedder.embed([
    "parse settings from json",
    "export function parseSettings(raw) { const settings = JSON.parse(raw); return settings; }",
    "const terminalScrollbackBuffer = allocateRingBuffer(pty, rows);",
  ]);
  assert.ok(cosineSimilarity(query!, related!) > cosineSimilarity(query!, unrelated!));
});

test("ignore matcher honors defaults, .gitignore and .deyinignore", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, ".gitignore"), "dist/\n*.log\n");
    writeFileSync(join(dir, ".deyinignore"), "secrets/\n");
    const matcher = new IgnoreMatcher(dir);
    assert.ok(matcher.ignored("node_modules", true));
    assert.ok(matcher.ignored(".git", true));
    assert.ok(matcher.ignored("dist", true));
    assert.ok(matcher.ignored("app/debug.log", false));
    assert.ok(matcher.ignored("secrets", true));
    assert.ok(!matcher.ignored("src", true));
    assert.ok(!matcher.ignored("src/index.ts", false));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vector store round-trips through disk and searches by cosine", async () => {
  const dir = tempDir();
  try {
    const embedder = new HashEmbedder();
    const store = new VectorStore(join(dir, "idx"), embedder.id, embedder.dimensions);
    const texts = [
      "export class SettingsStore { get(): DeyinSettings }",
      "function renderTerminal(pty: NodePty) { /* xterm */ }",
    ];
    const vectors = await embedder.embed(texts);
    store.setFile("a.ts", "h1", [{ path: "a.ts", startLine: 1, endLine: 10, preview: texts[0]!, fileHash: "h1" }], [vectors[0]!]);
    store.setFile("b.ts", "h2", [{ path: "b.ts", startLine: 1, endLine: 10, preview: texts[1]!, fileHash: "h2" }], [vectors[1]!]);
    store.save();

    const reloaded = new VectorStore(join(dir, "idx"), embedder.id, embedder.dimensions);
    assert.ok(reloaded.load());
    assert.equal(reloaded.chunkCount, 2);
    const [query] = await embedder.embed(["where are settings persisted"]);
    const hits = reloaded.search(query!, 1);
    assert.equal(hits[0]!.chunk.path, "a.ts");

    reloaded.removeFile("a.ts");
    assert.equal(reloaded.chunkCount, 1);
    assert.equal(reloaded.fileCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("IndexManager indexes a workspace, searches it and syncs incrementally", async () => {
  const dir = tempDir();
  const workspace = join(dir, "ws");
  try {
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(
      join(workspace, "src", "auth.ts"),
      "export async function refreshAccessToken(oauthClient) {\n  return oauthClient.refresh();\n}\n",
    );
    writeFileSync(
      join(workspace, "src", "terminal.ts"),
      "export function createPtySession(shell) {\n  return spawnPty(shell);\n}\n",
    );
    mkdirSync(join(workspace, "node_modules", "junk"), { recursive: true });
    writeFileSync(join(workspace, "node_modules", "junk", "index.js"), "ignored");

    const manager = new IndexManager({ indexRoot: join(dir, "indexes"), isEnabled: () => true });
    await manager.setRoot(workspace);

    const status = manager.status();
    assert.equal(status.state, "ready");
    assert.equal(status.files, 2); // node_modules ignored
    assert.ok(status.chunks >= 2);

    const hits = await manager.search("refresh the oauth access token", 2);
    assert.ok(hits.length > 0);
    assert.equal(hits[0]!.path, "src/auth.ts");

    // Incremental: add a file, re-sync via rebuildless setRoot round-trip.
    writeFileSync(join(workspace, "src", "billing.ts"), "export function computeInvoiceTotals(lines) { return lines.reduce(sum); }\n");
    await manager.rebuild();
    assert.equal(manager.status().files, 3);
    const billing = await manager.search("compute invoice totals", 1);
    assert.equal(billing[0]!.path, "src/billing.ts");
    manager.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
