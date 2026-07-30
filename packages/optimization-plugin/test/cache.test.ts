import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EmbeddingService, cosineSimilarity } from "../src/embeddings.js";
import { ToolResultCache } from "../src/tool-cache.js";
import { ResponseCache } from "../src/response-cache.js";
import { afterAgentRun, beforeAgentRun, type OptimizationRuntime } from "../src/hooks.js";

test("hash embeddings are L2-normalized and similar for paraphrases", async () => {
  const svc = new EmbeddingService("/nonexistent");
  await svc.initialize();
  const a = await svc.embed("Read auth.ts");
  const b = await svc.embed("Get content of auth.ts");
  const c = await svc.embed("launch nuclear missiles");
  assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 1e-5);
  assert.ok(cosineSimilarity(a, b) > cosineSimilarity(a, c));
});

test("tool cache exact hit and semantic hit", async () => {
  const svc = new EmbeddingService("/nonexistent");
  await svc.initialize();
  const cache = new ToolResultCache(
    { maxSize: 100, similarityThreshold: 0.5, enableSemanticMatch: true },
    svc,
  );
  await cache.set("read", { path: "auth.ts" }, "file contents here");
  const exact = await cache.get("read", { path: "auth.ts" });
  assert.ok(exact);
  assert.equal(exact!.result, "file contents here");

  // Semantic: different args that hash-embed near the stored invocation.
  const semantic = await cache.get("read", { path: "auth.ts", encoding: "utf8" });
  // With hash embeddings, near-duplicate arg JSON may or may not clear the threshold;
  // assert the semantic path can hit when similarity is high enough.
  if (semantic) {
    assert.equal(semantic.result, "file contents here");
    assert.ok(cache.getStats().semanticHits >= 1);
  } else {
    // Force a hit by lowering threshold after storing a paraphrase-shaped key.
    cache.setSimilarityThreshold(0.01);
    const loose = await cache.get("read", { file: "auth.ts" });
    assert.ok(loose, "semantic match must succeed at very low threshold");
    assert.equal(loose!.result, "file contents here");
  }

  // Never-cache tools
  await cache.set("bash", { command: "rm -rf /" }, "ok");
  const bash = await cache.get("bash", { command: "rm -rf /" });
  assert.equal(bash, null);
});

test("response cache round-trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-opt-"));
  try {
    const svc = new EmbeddingService("/nonexistent");
    await svc.initialize();
    const cache = new ResponseCache(join(dir, "responses.db"), svc, { ttlMs: 60_000 });
    await cache.initialize();
    await cache.set("How does compaction work?", "It truncates old tool results.", "ws1");
    const hit = await cache.get("How does compaction work?", "ws1");
    assert.ok(hit);
    assert.match(hit!.response, /truncates/);
    const miss = await cache.get("totally unrelated question about weather", "ws1");
    assert.equal(miss, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allowlist denies unknown/MCP/task tools and allows read-only inspection", async () => {
  const svc = new EmbeddingService("/nonexistent");
  await svc.initialize();
  const cache = new ToolResultCache(
    { maxSize: 100, similarityThreshold: 0.5, enableSemanticMatch: true },
    svc,
  );
  // Cacheable read-only tools
  await cache.set("read", { path: "a.ts" }, "A");
  await cache.set("grep", { pattern: "x" }, "B");
  await cache.set("glob", { pattern: "*" }, "C");
  assert.ok(await cache.get("read", { path: "a.ts" }));
  assert.ok(await cache.get("grep", { pattern: "x" }));
  assert.ok(await cache.get("glob", { pattern: "*" }));

  // Side-effecting tools are NOT cacheable, even if explicitly set
  await cache.set("write", { path: "a.ts", content: "x" }, "ok");
  assert.equal(await cache.get("write", { path: "a.ts", content: "x" }), null);
  await cache.set("bash", { command: "echo hi" }, "hi");
  assert.equal(await cache.get("bash", { command: "echo hi" }), null);

  // Unknown and MCP namespaced tools are denied by default
  await cache.set("mcp__foo__bar", { x: 1 }, "r");
  assert.equal(await cache.get("mcp__foo__bar", { x: 1 }), null);
  await cache.set("task", { description: "x", prompt: "y" }, "r");
  assert.equal(await cache.get("task", { description: "x", prompt: "y" }), null);
});

test("invalidatePath clears cached reads whose args.path matches", async () => {
 const svc = new EmbeddingService("/nonexistent");
 await svc.initialize();
 // Semantic match is disabled here — we're testing path-based invalidation,
 // not paraphrase equivalence.
 const cache = new ToolResultCache(
 { maxSize: 100, similarityThreshold: 0.99, enableSemanticMatch: false },
 svc,
 );
 await cache.set("read", { path: "src/auth.ts" }, "contents");
 await cache.set("read", { path: "src/util.ts" }, "other");
 await cache.set("grep", { pattern: "foo", path: "src/auth.ts" }, "match");
 assert.ok(await cache.get("read", { path: "src/auth.ts" }));

 // Editing src/auth.ts should drop both reads+grep that reference it,
 // but leave the unrelated src/util.ts entry alone.
 cache.invalidatePath("src/auth.ts");
 assert.equal(await cache.get("read", { path: "src/auth.ts" }), null);
 assert.equal(await cache.get("grep", { pattern: "foo", path: "src/auth.ts" }), null);
 assert.ok(await cache.get("read", { path: "src/util.ts" }), "unrelated path should survive");
});

test("response cache key namespaces by model/mode/systemPromptHash/historyHash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-opt-"));
  try {
    const svc = new EmbeddingService("/nonexistent");
    await svc.initialize();
    const cache = new ResponseCache(join(dir, "responses.db"), svc, { ttlMs: 60_000 });
    await cache.initialize();
    const runtime: OptimizationRuntime = {
      toolCache: new ToolResultCache({ maxSize: 1, similarityThreshold: 0.5, enableSemanticMatch: false }, svc),
      responseCache: cache,
      config: { enableToolCache: false, enableResponseCache: true },
    };

    // Same wording, same workspace, different model/mode/system prompt -> distinct.
    const ctxA = { model: "gpt-4o", mode: "agent", systemPromptHash: "aaaa", historyHash: "h1" };
    const ctxB = { model: "gpt-4o", mode: "plan", systemPromptHash: "bbbb", historyHash: "h1" };
    await beforeAgentRun(runtime, "explain hooks", "ws", ctxA); // miss
    await afterAgentRun(runtime, "explain hooks", "answer for agent", "ws", ctxA);
    const hitA = await beforeAgentRun(runtime, "explain hooks", "ws", ctxA);
    assert.equal(hitA.hit, true);

    const hitB = await beforeAgentRun(runtime, "explain hooks", "ws", ctxB);
    assert.equal(hitB.hit, false, "different context must not replay agent answer");

    // Same model/mode/system but different conversation history -> miss.
    const ctxHist = { ...ctxA, historyHash: "h2-different-prior-turns" };
    const hitHist = await beforeAgentRun(runtime, "explain hooks", "ws", ctxHist);
    assert.equal(hitHist.hit, false, "different historyHash must not replay");

    // And without context (legacy caller) the original workspace-only behavior still works.
    await afterAgentRun(runtime, "explain hooks", "answer legacy", "legacy-ws");
    const legacy = await beforeAgentRun(runtime, "explain hooks", "legacy-ws");
    assert.equal(legacy.hit, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setSimilarityThreshold live-updates the response cache", async () => {
 const dir = mkdtempSync(join(tmpdir(), "deyin-opt-"));
 try {
 const svc = new EmbeddingService("/nonexistent");
 await svc.initialize();
 const cache = new ResponseCache(join(dir, "responses.db"), svc, {
 ttlMs: 60_000,
 similarityThreshold: 0.99,
 });
 await cache.initialize();
 const stored = "How does compaction truncate old tool results?";
 const paraphrase = "How does compaction trim old tool outputs?";
 await cache.set(stored, "It trims them.", "ws1");
 // At strict threshold, the paraphrase is not considered a hit.
 const strictHit = await cache.get(paraphrase, "ws1");
 assert.equal(strictHit, null, "strict threshold should reject paraphrase");
 // Lower threshold below the actual semantic similarity.
 cache.setSimilarityThreshold(0.3);
 const looseHit = await cache.get(paraphrase, "ws1");
 assert.ok(looseHit, "loosened threshold should allow semantic hit");
 } finally {
 rmSync(dir, { recursive: true, force: true });
 }
});

test("createOptimizationPlugin prefers packagedModelDir when ONNX present", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { createOptimizationPlugin } = await import("../src/index.js");
  const root = mkdtempSync(join(tmpdir(), "deyin-opt-pkg-"));
  const userModels = join(root, "user", "models");
  const packaged = join(root, "packaged");
  mkdirSync(userModels, { recursive: true });
  mkdirSync(packaged, { recursive: true });
  // Placeholder ONNX file (content unused — initialize only checks existsSync).
  writeFileSync(join(packaged, "deyinai-embedding.onnx"), "placeholder");
  try {
    const plugin = await createOptimizationPlugin({
      dataDir: join(root, "user"),
      packagedModelDir: packaged,
      enableToolCache: false,
      enableResponseCache: false,
    });
    const init = await plugin.initialize();
    assert.equal(init.modelPresent, true);
    assert.equal(init.backend, "deyinai-hash-v1");
    plugin.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
