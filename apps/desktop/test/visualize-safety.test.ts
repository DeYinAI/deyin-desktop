import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { VisualizeStore } from "../src/main/visualize-store.js";

test("visualize rejects path traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-vis-"));
  try {
    const service = new VisualizeStore(root);
    assert.throws(() => service.readFragment("thread-1", "../secret.html"), /Invalid|escapes/);
    assert.throws(() => service.readFragment("thread-1", "..\\secret.html"), /Invalid/);
    assert.throws(() => service.writeFragment("thread-1", "/etc/passwd", "<p>x</p>"), /Invalid/);
    const written = service.writeFragment("thread-1", "chart.html", "<p>ok</p>");
    assert.equal(written.title, "chart.html");
    assert.equal(service.readFragment("thread-1", "chart.html"), "<p>ok</p>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
