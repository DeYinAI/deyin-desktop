import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyHunksToFile, applyPatchTool, parseUnifiedDiff } from "../src/tools/patch.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deyin-patch-test-"));
}

test("parseUnifiedDiff parses standard git diff headers and hunks", () => {
  const diff = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import foo from "./foo";
+import bar from "./bar";

 export const val = 42;
`;

  const parsed = parseUnifiedDiff(diff);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.oldPath, "src/index.ts");
  assert.equal(parsed[0]?.newPath, "src/index.ts");
  assert.equal(parsed[0]?.hunks.length, 1);
  assert.equal(parsed[0]?.hunks[0]?.oldStart, 1);
  assert.equal(parsed[0]?.hunks[0]?.oldCount, 3);
  assert.equal(parsed[0]?.hunks[0]?.newStart, 1);
  assert.equal(parsed[0]?.hunks[0]?.newCount, 4);
});

test("applyHunksToFile adds and deletes lines accurately", () => {
  const original = `line 1
line 2
line 3
line 4`;

  const hunks = [
    {
      oldStart: 2,
      oldCount: 2,
      newStart: 2,
      newCount: 3,
      lines: [
        " line 2",
        "-line 3",
        "+line 3 modified",
        "+line 3.5 added",
        " line 4",
      ],
    },
  ];

  const res = applyHunksToFile(original, hunks);
  assert.equal(res.appliedHunks, 1);
  assert.equal(res.additions, 2);
  assert.equal(res.deletions, 1);
  assert.equal(
    res.next,
    `line 1
line 2
line 3 modified
line 3.5 added
line 4`,
  );
});

test("applyHunksToFile handles line offset fuzzing", () => {
  // File has 3 extra lines at the top
  const original = `header 1
header 2
header 3
line 1
line 2
line 3`;

  const hunks = [
    {
      oldStart: 1, // claims line 1, but is actually at line 4
      oldCount: 3,
      newStart: 1,
      newCount: 3,
      lines: [
        " line 1",
        "-line 2",
        "+line 2 replacement",
        " line 3",
      ],
    },
  ];

  const res = applyHunksToFile(original, hunks, 10);
  assert.equal(res.appliedHunks, 1);
  assert.ok(res.next.includes("line 2 replacement"));
  assert.ok(!res.next.includes("line 2\n"));
});

test("applyPatchTool execute modifies workspace file", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "calc.ts");
    writeFileSync(
      file,
      `export function add(a: number, b: number): number {
  return a - b;
}
`,
    );

    const patch = `--- a/calc.ts
+++ b/calc.ts
@@ -1,3 +1,3 @@
 export function add(a: number, b: number): number {
-  return a - b;
+  return a + b;
 }
`;

    const result = await applyPatchTool.execute({ patch }, { cwd: dir, todos: [] });
    assert.ok(result.includes("Successfully applied patch"));

    const after = readFileSync(file, "utf8");
    assert.ok(after.includes("return a + b;"));
    assert.ok(!after.includes("return a - b;"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
