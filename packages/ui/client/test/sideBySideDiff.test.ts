import assert from "node:assert/strict";
import test from "node:test";
import { computeLineDiff, computeSideBySideDiff, diffStats } from "../src/diff.js";

// NOTE: inputs below avoid trailing newlines on purpose — a trailing "\n" still
// makes split("\n") emit an empty last line, which just adds a harmless empty
// context row. An entirely empty file is a separate case: zero lines.

test("sideBySide: unchanged file stays row-aligned context", () => {
  const rows = computeSideBySideDiff("a\nb\nc", "a\nb\nc");
  assert.equal(rows.length, 3);
  for (const [i, row] of rows.entries()) {
    assert.equal(row.left.type, "context");
    assert.equal(row.right.type, "context");
    assert.equal(row.left.no, i + 1);
    assert.equal(row.right.no, i + 1);
  }
});

test("sideBySide: pure insertion pads the left side with an empty cell", () => {
  const rows = computeSideBySideDiff("a\nc", "a\nb\nc");
  assert.deepEqual(
    rows.map((r) => [r.left.type, r.right.type]),
    [
      ["context", "context"],
      ["empty", "add"],
      ["context", "context"],
    ],
  );
  assert.equal(rows[1]!.right.text, "b");
  assert.equal(rows[1]!.right.no, 2);
  assert.equal(rows[1]!.left.no, null);
});

test("sideBySide: pure deletion pads the right side with an empty cell", () => {
  const rows = computeSideBySideDiff("a\nb\nc", "a\nc");
  assert.deepEqual(
    rows.map((r) => [r.left.type, r.right.type]),
    [
      ["context", "context"],
      ["del", "empty"],
      ["context", "context"],
    ],
  );
  assert.equal(rows[1]!.left.text, "b");
  assert.equal(rows[1]!.left.no, 2);
  assert.equal(rows[1]!.right.no, null);
});

test("sideBySide: modification pairs the del/add line in one row", () => {
  const rows = computeSideBySideDiff("a\nold", "a\nnew");
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.left.type, "del");
  assert.equal(rows[1]!.left.text, "old");
  assert.equal(rows[1]!.left.no, 2);
  assert.equal(rows[1]!.right.type, "add");
  assert.equal(rows[1]!.right.text, "new");
  assert.equal(rows[1]!.right.no, 2);
});

test("sideBySide: unbalanced block pads the shorter side", () => {
  // 2 removed lines replaced by 3 added lines
  const rows = computeSideBySideDiff("x1\nx2", "y1\ny2\ny3");
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.left.type),
    ["del", "del", "empty"],
  );
  assert.deepEqual(
    rows.map((r) => r.right.type),
    ["add", "add", "add"],
  );
  assert.deepEqual(
    rows.map((r) => r.left.no),
    [1, 2, null],
  );
  assert.deepEqual(
    rows.map((r) => r.right.no),
    [1, 2, 3],
  );
});

test("sideBySide: separate hunks stay grouped and ordered", () => {
  const rows = computeSideBySideDiff("d\nkeep\nx", "n\nkeep\ny");
  assert.deepEqual(
    rows.map((r) => `${r.left.type}/${r.right.type}`),
    ["del/add", "context/context", "del/add"],
  );
  assert.deepEqual(
    rows.map((r) => [r.left.text, r.right.text]),
    [
      ["d", "n"],
      ["keep", "keep"],
      ["x", "y"],
    ],
  );
});

test("sideBySide: a new file is all adds, with nothing on the old side", () => {
  // An empty "before" is an empty file, not a file holding one blank line: it
  // used to report a deletion of blank line 1, which drew a stray red row in
  // the unified view and a lone "1" in an otherwise empty OLD pane.
  const rows = computeSideBySideDiff("", "one\ntwo");
  assert.deepEqual(
    rows.map((r) => [r.left.type, r.right.type]),
    [
      ["empty", "add"],
      ["empty", "add"],
    ],
  );
  assert.deepEqual(
    rows.map((r) => r.left.no),
    [null, null],
  );
  assert.deepEqual(
    rows.map((r) => r.right.no),
    [1, 2],
  );
});

test("sideBySide: a deleted file is all dels, with nothing on the new side", () => {
  const rows = computeSideBySideDiff("one\ntwo", "");
  assert.deepEqual(
    rows.map((r) => [r.left.type, r.right.type]),
    [
      ["del", "empty"],
      ["del", "empty"],
    ],
  );
  assert.deepEqual(
    rows.map((r) => r.right.no),
    [null, null],
  );
});

test("sideBySide: an unchanged empty file has no rows at all", () => {
  assert.deepEqual(computeSideBySideDiff("", ""), []);
});

test("diffStats counts a new file's lines without a phantom deletion", () => {
  assert.deepEqual(diffStats("", "one\ntwo"), { adds: 2, dels: 0, renderable: true });
  assert.deepEqual(diffStats("one\ntwo", ""), { adds: 0, dels: 2, renderable: true });
  // A real blank line is still a line.
  assert.deepEqual(diffStats("\n", ""), { adds: 0, dels: 2, renderable: true });
});

test("sideBySide: row count equals max(old, new) across every hunk (no drift)", () => {
  const before = "keep\nr1\nr2\nr3\nkeep";
  const after = "keep\nn1\nn2\nn3\nn4\nn5\nkeep";
  const rows = computeSideBySideDiff(before, after);
  // 2 context + max(3 del, 5 add) = 7 rows
  assert.equal(rows.length, 7);
  // Each side's line numbers are strictly increasing (fillers are null).
  let lastLeft = 0;
  let lastRight = 0;
  for (const row of rows) {
    if (row.left.no !== null) {
      assert.ok(row.left.no > lastLeft);
      lastLeft = row.left.no;
    }
    if (row.right.no !== null) {
      assert.ok(row.right.no > lastRight);
      lastRight = row.right.no;
    }
  }
});

test("sideBySide: agrees with computeLineDiff totals (dels + adds)", () => {
  const before = "a\nb\nc\nd";
  const after = "a\nB\nc\nD\nE";
  const rows = computeSideBySideDiff(before, after);
  const lineDels = computeLineDiff(before, after).filter((l) => l.type === "del").length;
  const lineAdds = computeLineDiff(before, after).filter((l) => l.type === "add").length;
  const rowDels = rows.filter((r) => r.left.type === "del").length;
  const rowAdds = rows.filter((r) => r.right.type === "add").length;
  assert.equal(rowDels, lineDels);
  assert.equal(rowAdds, lineAdds);
});
