import assert from "node:assert/strict";
import test from "node:test";
import { clampSlashIndex, stepSlashIndex } from "../src/slashMenu.js";

test("clampSlashIndex keeps the highlight inside the list", () => {
  assert.equal(clampSlashIndex(0, 3), 0);
  assert.equal(clampSlashIndex(2, 3), 2);
  assert.equal(clampSlashIndex(7, 3), 2, "a shrinking list pulls the highlight back to the last row");
  assert.equal(clampSlashIndex(-4, 3), 0);
});

test("clampSlashIndex has no valid index for an empty list, so it falls to 0", () => {
  assert.equal(clampSlashIndex(5, 0), 0);
  assert.equal(clampSlashIndex(-1, 0), 0);
});

test("stepSlashIndex moves one row and wraps at both ends", () => {
  assert.equal(stepSlashIndex(0, 1, 3), 1);
  assert.equal(stepSlashIndex(1, 1, 3), 2);
  assert.equal(stepSlashIndex(2, 1, 3), 0, "Down on the last row wraps to the first");
  assert.equal(stepSlashIndex(0, -1, 3), 2, "Up on the first row wraps to the last");
  assert.equal(stepSlashIndex(2, -1, 3), 1);
});

test("stepSlashIndex starts from a clamped index when the list shrank", () => {
  assert.equal(stepSlashIndex(9, 1, 3), 0);
  assert.equal(stepSlashIndex(9, -1, 3), 1);
});

test("stepSlashIndex on one row stays put, and on an empty list returns 0", () => {
  assert.equal(stepSlashIndex(0, 1, 1), 0);
  assert.equal(stepSlashIndex(0, -1, 1), 0);
  assert.equal(stepSlashIndex(0, 1, 0), 0);
});
