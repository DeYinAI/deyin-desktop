import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { notebookEditTool } from "../src/tools/notebook-edit.js";
import type { ToolContext } from "../src/types.js";

test("notebook_edit preserves array formatting for cell source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-nb-"));
  const nbPath = join(dir, "test.ipynb");
  const initialJson = {
    cells: [
      {
        cell_type: "code",
        metadata: {},
        source: ["import os\n", "print(1)"],
      },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 2,
  };
  writeFileSync(nbPath, JSON.stringify(initialJson, null, 1));

  try {
    const ctx: ToolContext = { cwd: dir, todos: [] };

    // Update existing cell
    const res = await notebookEditTool.execute(
      { path: "test.ipynb", cell_idx: 0, new_string: "import sys\nimport os\nprint(2)" },
      ctx,
    );
    assert.match(res, /test\.ipynb updated/);

    const updated = JSON.parse(readFileSync(nbPath, "utf8"));
    assert.ok(Array.isArray(updated.cells[0].source));
    assert.deepEqual(updated.cells[0].source, ["import sys\n", "import os\n", "print(2)"]);

    // Insert a new cell
    await notebookEditTool.execute(
      { path: "test.ipynb", cell_idx: 1, is_new_cell: true, new_string: "print('new cell')\nx = 10" },
      ctx,
    );
    const updated2 = JSON.parse(readFileSync(nbPath, "utf8"));
    assert.equal(updated2.cells.length, 2);
    assert.ok(Array.isArray(updated2.cells[1].source));
    assert.deepEqual(updated2.cells[1].source, ["print('new cell')\n", "x = 10"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
