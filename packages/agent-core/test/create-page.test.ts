import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PageStore } from "@deyin/host-core";
import { createPageTool } from "@deyin/agent-core";

test("create_page writes artifact and fires onPageCreated", async () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-create-page-"));
  try {
    const store = new PageStore(root);
    let created: unknown;
    const result = await createPageTool.execute(
      {
        title: "My Landing",
        html: "<h1>Welcome</h1>",
        file: "landing.html",
      },
      {
        cwd: "/",
        todos: [],
        pageArtifact: {
          write: async ({ threadId, file, html }) => {
            const written = store.writePage(threadId, file, html);
            const content = store.readPage(threadId, written.title);
            return { fileName: written.title, filePath: written.file, html: content };
          },
        },
        onPageCreated: (page) => {
          created = page;
        },
        sessionMeta: { threadId: "t-99", mode: "agent", approvalMode: "ask-first", model: "test", cwd: "/" },
      },
    );
    assert.match(result, /Preview panel/);
    assert.ok(created && typeof created === "object");
    const page = created as { title: string; fileName: string; preview?: string };
    assert.equal(page.title, "My Landing");
    assert.equal(page.fileName, "landing.html");
    assert.match(page.preview ?? "", /Welcome/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create_page without bridge returns error", async () => {
  const result = await createPageTool.execute(
    { title: "X", html: "<p>y</p>" },
    { cwd: "/", todos: [], sessionMeta: { threadId: "t", mode: "agent", approvalMode: "ask-first", model: "test", cwd: "/" } },
  );
  assert.match(result, /not available/);
});
