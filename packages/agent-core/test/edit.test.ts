import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdit, countOccurrences } from "../src/tools/edit.js";

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
