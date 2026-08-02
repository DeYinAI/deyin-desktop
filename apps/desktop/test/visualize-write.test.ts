import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { VisualizeStore } from "../src/main/visualize-store.js";
import { createVisualizeWriteTool } from "../src/main/visualize-tools.js";

test("visualize_write round-trip", async () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-vis-write-"));
  try {
    const service = new VisualizeStore(root);
    const tool = createVisualizeWriteTool(service);
    const result = await tool.execute(
      { file: "sales.html", html: "<h1>Sales</h1>", title: "Sales chart" },
      { cwd: "/", sessionMeta: { threadId: "t-42", mode: "agent", approvalMode: "ask-first", model: "test", cwd: "/" } },
    );
    assert.match(result, /::deyin-inline-vis/);
    assert.equal(service.readFragment("t-42", "sales.html"), "<h1>Sales</h1>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
