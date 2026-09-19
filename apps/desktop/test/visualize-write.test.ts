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

test("visualize_write handles subdirectory paths and saves workspace copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-vis-sub-"));
  const workspace = mkdtempSync(join(tmpdir(), "deyin-vis-ws-"));
  try {
    const service = new VisualizeStore(root);
    const tool = createVisualizeWriteTool(service);
    const result = await tool.execute(
      { file: "deyin-audit-sandbox/status.html", html: "<p>all good</p>", title: "Status" },
      { cwd: workspace, sessionMeta: { threadId: "t-sub", mode: "agent", approvalMode: "ask-first", model: "test", cwd: workspace } },
    );
    assert.match(result, /status\.html/);
    assert.match(result, /workspace copy/);
    assert.equal(service.readFragment("t-sub", "status.html"), "<p>all good</p>");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
