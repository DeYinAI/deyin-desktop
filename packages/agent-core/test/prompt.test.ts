import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { loadContextFiles, loadContextFilesDetailed } from "../src/prompt.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deyin-context-"));
}

test("loads AGENTS.md from cwd and parents, nearest wins", async () => {
  const dir = tempDir();
  try {
    const child = join(dir, "a", "b");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "root rules\n");
    writeFileSync(join(child, "AGENTS.md"), "child rules\n");
    const files = await loadContextFiles(child);
    const contents = files.map((f) => f.content.trim());
    assert.deepEqual(contents, ["root rules", "child rules"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recognizes CLAUDE.md and DEYIN.md with .local variants, local wins", async () => {
  const dir = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "agents\n");
    writeFileSync(join(dir, "CLAUDE.md"), "claude\n");
    writeFileSync(join(dir, "DEYIN.md"), "deyin\n");
    writeFileSync(join(dir, "AGENTS.local.md"), "agents local\n");
    const files = await loadContextFiles(dir);
    const order = files.map((f) => f.path.split(sep).at(-1));
    assert.deepEqual(order, ["AGENTS.md", "CLAUDE.md", "DEYIN.md", "AGENTS.local.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loads user-global instructions from ~/.deyin first (lowest priority)", async () => {
  const dir = tempDir();
  try {
    const userDir = join(dir, "home", ".deyin");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "AGENTS.md"), "global\n");
    writeFileSync(join(dir, "AGENTS.md"), "project\n");
    const files = await loadContextFiles(dir, { userDir });
    const contents = files.map((f) => f.content.trim());
    assert.deepEqual(contents, ["global", "project"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deduplicates identical expanded content keeping the more specific source", async () => {
  const dir = tempDir();
  try {
    const userDir = join(dir, "home", ".deyin");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "AGENTS.md"), "same text\n");
    writeFileSync(join(dir, "AGENTS.md"), "same text\n");
    const files = await loadContextFiles(dir, { userDir });
    assert.equal(files.length, 1);
    assert.ok(files[0]!.path.includes(dir)); // the project copy survives
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("@import expands relative files and rejects escapes, absolutes and cycles", async () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "top\n@docs/guide.md\nbottom\n");
    writeFileSync(join(dir, "docs", "guide.md"), "guide body\n@../escape.md\n@/absolute.md\n");
    writeFileSync(join(dir, "escape.md"), "ESCAPED\n");
    writeFileSync(join(dir, "AGENTS.md").replace("AGENTS.md", "loop.md"), "@loop.md\n");
    const result = await loadContextFilesDetailed(dir);
    const agents = result.files.find((f) => f.path.endsWith("AGENTS.md"));
    assert.ok(agents, "AGENTS.md present");
    assert.ok(agents.content.includes("guide body"));
    assert.ok(!agents.content.includes("ESCAPED"), "parent escape rejected");
    assert.ok(!agents.content.includes("/absolute.md"), "absolute import rejected");
    assert.ok(result.diagnostics.some((d) => d.includes("escape")), "escape diagnostic surfaced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("@import cycle is rejected with a diagnostic", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "a.md"), "@b.md\n");
    writeFileSync(join(dir, "b.md"), "@a.md\n");
    writeFileSync(join(dir, "AGENTS.md"), "@a.md\n");
    const result = await loadContextFilesDetailed(dir);
    assert.ok(result.diagnostics.some((d) => d.includes("cycle")), "cycle diagnostic surfaced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("import depth is capped", async () => {
  const dir = tempDir();
  try {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, `f${i}.md`), i < 9 ? `@f${i + 1}.md\n` : "leaf\n");
    }
    writeFileSync(join(dir, "AGENTS.md"), "@f0.md\n");
    const result = await loadContextFilesDetailed(dir);
    assert.ok(result.diagnostics.some((d) => d.includes("depth")), "depth diagnostic surfaced");
    const agents = result.files.find((f) => f.path.endsWith("AGENTS.md"));
    assert.ok(agents && agents.content.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
