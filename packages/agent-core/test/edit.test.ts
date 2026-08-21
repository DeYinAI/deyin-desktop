import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdit, applyEdits, countOccurrences } from "../src/tools/edit.js";

test("countOccurrences counts non-overlapping matches", () => {
  assert.equal(countOccurrences("aaa", "aa"), 1);
  assert.equal(countOccurrences("a b a b", "a"), 2);
  assert.equal(countOccurrences("abc", "z"), 0);
  assert.equal(countOccurrences("abc", ""), 0);
});

test("replaces a unique occurrence", () => {
  const { next, replacements } = applyEdit("const a = 1;\nconst b = 2;", "const b = 2;", "const b = 3;", false);
  assert.equal(next, "const a = 1;\nconst b = 3;");
  assert.equal(replacements, 1);
});

test("rejects when old_string is missing", () => {
  assert.throws(() => applyEdit("hello", "nope", "x", false), /not found/);
});

test("rejects ambiguous matches unless replace_all", () => {
  assert.throws(() => applyEdit("x=1; x=1;", "x=1;", "y=1;", false), /appears 2 times/);
  const { next, replacements } = applyEdit("x=1; x=1;", "x=1;", "y=1;", true);
  assert.equal(next, "y=1; y=1;");
  assert.equal(replacements, 2);
});

test("rejects identical old and new strings", () => {
  assert.throws(() => applyEdit("abc", "abc", "abc", false), /identical/);
});

test("applies a batch of edits in order against the evolving content", () => {
  const { next, replacements } = applyEdits("const a = 1;\nconst b = 2;\nconst c = 3;", [
    { oldString: "const a = 1;", newString: "const a = 9;", replaceAll: false },
    { oldString: "const c = 3;", newString: "const c = 7;", replaceAll: false },
    { oldString: "const a = 9;", newString: "const a = 10;", replaceAll: false },
  ]);
  assert.equal(next, "const a = 10;\nconst b = 2;\nconst c = 7;");
  assert.equal(replacements, 3);
});

test("counts every replacement when a batched edit uses replace_all", () => {
  const { next, replacements } = applyEdits("x=1; x=1; y=2;", [
    { oldString: "x=1;", newString: "z=1;", replaceAll: true },
    { oldString: "y=2;", newString: "y=3;", replaceAll: false },
  ]);
  assert.equal(next, "z=1; z=1; y=3;");
  assert.equal(replacements, 3);
});

test("a failing edit aborts the whole batch and names its index", () => {
  assert.throws(
    () =>
      applyEdits("hello world", [
        { oldString: "hello", newString: "goodbye", replaceAll: false },
        { oldString: "nope", newString: "x", replaceAll: false },
      ]),
    /edits\[1\] failed:.*not found.*No edits were applied/s,
  );
});

test("a single-edit batch reports the bare reason, not an index", () => {
  assert.throws(() => applyEdits("hello", [{ oldString: "nope", newString: "x", replaceAll: false }]), /^Error: old_string not found/);
});

test("rejects an empty batch", () => {
  assert.throws(() => applyEdits("hello", []), /No edits provided/);
});
