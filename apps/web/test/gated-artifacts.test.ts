import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildArtifactObjectKey } from "@deyin/host-core";
import { GatedArtifactStore } from "../src/server/gated-artifacts.js";
import { MemoryObjectStore } from "../src/server/r2-client.js";

/** 1x1 transparent PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("GatedArtifactStore mirrors pages to R2 under the authenticated user sub", async () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-gated-page-"));
  const r2 = new MemoryObjectStore();
  try {
    const store = new GatedArtifactStore("user-a", root, r2);
    const written = await store.writePage("t1", "landing.html", "<h1>Hello</h1>");
    const key = buildArtifactObjectKey({
      userSub: "user-a",
      kind: "pages",
      threadId: "t1",
      fileName: written.title,
    });
    const remote = await r2.get(key);
    assert.ok(remote);
    assert.match(remote.toString("utf8"), /<h1>Hello<\/h1>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GatedArtifactStore readPage falls back to R2 and user B cannot read user A objects", async () => {
  const rootA = mkdtempSync(join(tmpdir(), "deyin-gated-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "deyin-gated-b-"));
  const r2 = new MemoryObjectStore();
  try {
    const storeA = new GatedArtifactStore("user-a", rootA, r2);
    await storeA.writePage("t1", "site.html", "<p>Secret A</p>");

    const storeB = new GatedArtifactStore("user-b", rootB, r2);
    await assert.rejects(() => storeB.readPage("t1", "site.html"));

    const storeA2 = new GatedArtifactStore("user-a", mkdtempSync(join(tmpdir(), "deyin-gated-a2-")), r2);
    const html = await storeA2.readPage("t1", "site.html");
    assert.match(html, /Secret A/);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("GatedArtifactStore mirrors and reads images across sessions", async () => {
  const root1 = mkdtempSync(join(tmpdir(), "deyin-gated-img1-"));
  const root2 = mkdtempSync(join(tmpdir(), "deyin-gated-img2-"));
  const r2 = new MemoryObjectStore();
  try {
    const store1 = new GatedArtifactStore("user-a", root1, r2);
    const saved = await store1.saveImage("t1", { base64: PNG, mediaType: "image/png" });

    const store2 = new GatedArtifactStore("user-a", root2, r2);
    const read = await store2.readImage("t1", saved.file);
    assert.equal(read.base64, PNG);
  } finally {
    rmSync(root1, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});
