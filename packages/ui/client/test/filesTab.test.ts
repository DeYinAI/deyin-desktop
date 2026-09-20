import assert from "node:assert/strict";
import test from "node:test";

test("openRequest seq deduplication allows user navigation after opening from chat", () => {
  let selectedPath: string | null = null;
  let lastHandledSeq: number | null = null;

  const openFile = (path: string) => {
    selectedPath = path;
  };

  const handleOpenRequest = (openRequest: { path: string; seq: number } | null) => {
    if (!openRequest?.path || openRequest.seq === lastHandledSeq) return;
    lastHandledSeq = openRequest.seq;
    openFile(openRequest.path);
  };

  // 1. User clicks file in chat
  const chatRequest = { path: "/workspace/docs/report.md", seq: 1001 };
  handleOpenRequest(chatRequest);
  assert.equal(selectedPath, "/workspace/docs/report.md");

  // 2. Component re-renders with openRequest still in props; must not re-trigger
  handleOpenRequest(chatRequest);
  assert.equal(selectedPath, "/workspace/docs/report.md");

  // 3. User clicks another file in the file tree
  openFile("/workspace/package.json");
  assert.equal(selectedPath, "/workspace/package.json");

  // 4. Component re-renders after file tree selection; stale openRequest in props must NOT overwrite selection
  handleOpenRequest(chatRequest);
  assert.equal(selectedPath, "/workspace/package.json", "file tree selection must not be clobbered by stale openRequest");

  // 5. User clicks a new file in chat (new sequence)
  const newChatRequest = { path: "/workspace/CONTRIBUTING.md", seq: 1002 };
  handleOpenRequest(newChatRequest);
  assert.equal(selectedPath, "/workspace/CONTRIBUTING.md");
});
