import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeFilePath, resolveWorkspaceFilePath } from "../src/filePath.js";

test("looksLikeFilePath: recognizes common file and directory refs", () => {
  assert.equal(looksLikeFilePath("browsermmorpg_vote.py"), true);
  assert.equal(looksLikeFilePath("requirements.txt"), true);
  assert.equal(looksLikeFilePath("vote_ready_proxies.json"), true);
  assert.equal(looksLikeFilePath("automation/proxy_scraper.py"), true);
  assert.equal(looksLikeFilePath("_browser_profile/"), true);
  assert.equal(looksLikeFilePath(".env"), true);
});

test("looksLikeFilePath: rejects non-path inline code", () => {
  assert.equal(looksLikeFilePath("requests"), false);
  assert.equal(looksLikeFilePath("playwright"), false);
  assert.equal(looksLikeFilePath("1579"), false);
  assert.equal(looksLikeFilePath("https://example.com/a.py"), false);
  assert.equal(looksLikeFilePath("foo bar.py"), false);
});

test("resolveWorkspaceFilePath: joins relative paths to workspace root", () => {
  const root = "/tmp/deyin-ws";
  assert.equal(resolveWorkspaceFilePath(root, "automation/vote.py"), "/tmp/deyin-ws/automation/vote.py");
  assert.equal(resolveWorkspaceFilePath(root, "/etc/passwd"), "/etc/passwd");
  assert.equal(resolveWorkspaceFilePath(null, "vote.py"), "vote.py");
});
