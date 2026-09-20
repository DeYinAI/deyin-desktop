import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openInEditor } from "../src/tui/editor.js";

test("openInEditor launches editor and reads back modified content", () => {
  const originalEditor = process.env.EDITOR;
  try {
    // A command that appends "-edited" to the file passed as $1
    process.env.EDITOR = "node -e 'require(\"node:fs\").writeFileSync(process.argv[1], \"hello-from-editor\")'";
    const res = openInEditor("initial");
    assert.equal(res, "hello-from-editor");
  } finally {
    if (originalEditor !== undefined) {
      process.env.EDITOR = originalEditor;
    } else {
      delete process.env.EDITOR;
    }
  }
});

test("openInEditor handles existing file paths with spaces as editor binary", () => {
  const dir = mkdtempSync(join(tmpdir(), "editor spaces "));
  const scriptPath = join(dir, "my editor.sh");
  try {
    writeFileSync(scriptPath, '#!/bin/sh\necho "from script with spaces" > "$1"\n', { mode: 0o755 });
    const originalEditor = process.env.EDITOR;
    try {
      process.env.EDITOR = scriptPath;
      const res = openInEditor("initial");
      assert.ok(res?.includes("from script with spaces"));
    } finally {
      if (originalEditor !== undefined) {
        process.env.EDITOR = originalEditor;
      } else {
        delete process.env.EDITOR;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openInEditor returns null if editor binary fails or does not exist", () => {
  const originalEditor = process.env.EDITOR;
  try {
    process.env.EDITOR = "non_existent_binary_xyz_12345";
    const res = openInEditor("initial");
    assert.equal(res, null);
  } finally {
    if (originalEditor !== undefined) {
      process.env.EDITOR = originalEditor;
    } else {
      delete process.env.EDITOR;
    }
  }
});
