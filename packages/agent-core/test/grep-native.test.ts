import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nativeAvailable, nativeGrep } from "../src/native.js";
import { grepTool } from "../src/tools/grep.js";
import type { ToolContext } from "../src/types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deyin-grep-native-"));
}

const ctx = (cwd: string): ToolContext => ({ cwd, todos: [] });

test("grep tool finds literal content", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "alpha.ts"), "LITERAL_GREP_MARKER\n");
    const out = await grepTool.execute({ pattern: "LITERAL_GREP_MARKER", path: dir }, ctx(dir));
    assert.ok(out.includes("alpha.ts"));
    assert.ok(out.includes("LITERAL_GREP_MARKER"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native brace glob matches test and spec files", { skip: !nativeAvailable() }, () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "main.test.ts"), "BRACE_GLOB_MARKER\n");
    writeFileSync(join(dir, "main.spec.ts"), "BRACE_GLOB_MARKER\n");
    writeFileSync(join(dir, "main.ts"), "other\n");

    const native = nativeGrep(dir, "BRACE_GLOB_MARKER", "*.{test,spec}.ts", 10, false);
    assert.ok(native);
    assert.equal(native!.matches.length, 2);
    const files = native!.matches.map((m) => m.file).sort();
    assert.deepEqual(files, ["main.spec.ts", "main.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regex alternation bypasses native and still finds via ripgrep", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "alt.ts"), "ALT_LEFT_OR_RIGHT\n");
    const out = await grepTool.execute({ pattern: "ALT_LEFT|ALT_RIGHT", path: dir }, ctx(dir));
    assert.ok(out.includes("alt.ts"));
    assert.ok(out.includes("ALT_LEFT"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty native results fall through to ripgrep", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "word.ts"), "hello FALLBACK_TOKEN world\n");
    // Native treats \\b as escaped "b", not a word boundary; ripgrep handles \\b correctly.
    const out = await grepTool.execute({ pattern: "\\bFALLBACK_TOKEN\\b", path: dir }, ctx(dir));
    assert.ok(out.includes("word.ts"), out);
    assert.ok(out.includes("FALLBACK_TOKEN"), out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep brace glob via tool", async () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "app.test.ts"), "TOOL_BRACE_MARKER\n");
    writeFileSync(join(dir, "src", "app.ts"), "other\n");

    const out = await grepTool.execute(
      { pattern: "TOOL_BRACE_MARKER", path: dir, glob: "*.{test,spec}.ts" },
      ctx(dir),
    );
    assert.ok(out.includes("app.test.ts"));
    assert.ok(!out.includes("app.ts:1:"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
