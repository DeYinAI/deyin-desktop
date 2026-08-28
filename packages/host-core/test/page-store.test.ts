import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PageStore, wrapHtmlDocument } from "../src/host/page-store.js";

test("wrapHtmlDocument wraps fragments and preserves full documents", () => {
  const wrapped = wrapHtmlDocument("<h1>Hi</h1>", "Hello");
  assert.match(wrapped, /<title>Hello<\/title>/);
  assert.match(wrapped, /<h1>Hi<\/h1>/);
  const full = "<!DOCTYPE html><html><body>OK</body></html>";
  assert.equal(wrapHtmlDocument(full), full);
});

test("PageStore write and read round-trip", () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-page-"));
  try {
    const store = new PageStore(root);
    const { title } = store.writePage("thread-1", "landing.html", "<main>Landing</main>");
    assert.equal(title, "landing.html");
    const html = store.readPage("thread-1", "landing.html");
    assert.match(html, /<main>Landing<\/main>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PageStore rejects path traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-page-safe-"));
  try {
    const store = new PageStore(root);
    assert.throws(() => store.writePage("thread-1", "../evil.html", "<p>x</p>"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
