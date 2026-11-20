import assert from "node:assert/strict";
import test from "node:test";
import { PIN_THRESHOLD, readPin } from "../src/chatPin.js";

const reading = (top: number, height = 1000, viewport = 400) => ({ top, height, viewport });

test("at or near the bottom the view is pinned, whatever it was before", () => {
  assert.equal(readPin(false, 0, reading(600)), true, "exactly at the bottom");
  assert.equal(readPin(false, 0, reading(600 - PIN_THRESHOLD)), true, "at the threshold");
  assert.equal(readPin(true, 600, reading(600)), true);
});

test("the person scrolling up, away from the bottom, un-pins it", () => {
  assert.equal(readPin(true, 600, reading(400)), false);
  assert.equal(readPin(true, 600, reading(600 - PIN_THRESHOLD - 2)), false, "just past the threshold, and moving up");
});

test("a viewport that got shorter while the view stayed put does not un-pin it", () => {
  // The scroll to the bottom ended at top 825; by the time its event arrived a permission card had cut the viewport.
  assert.equal(readPin(true, 752, { top: 825, height: 1344, viewport: 424 }), true);
});

test("a viewport that got shorter with the view unchanged keeps whatever it was", () => {
  assert.equal(readPin(true, 825, { top: 825, height: 1344, viewport: 424 }), true);
  assert.equal(readPin(false, 825, { top: 825, height: 1344, viewport: 424 }), false, "a view the person left stays left");
});

test("content growing below the view does not un-pin it, and does not re-pin one the person left", () => {
  assert.equal(readPin(true, 500, { top: 500, height: 1800, viewport: 400 }), true);
  assert.equal(readPin(false, 500, { top: 500, height: 1800, viewport: 400 }), false);
});

test("scrolling down toward the bottom does not pin until it gets there", () => {
  assert.equal(readPin(false, 100, reading(300)), false);
  assert.equal(readPin(false, 300, reading(560)), true);
});

test("a content shrink that clamps the view to the bottom keeps it pinned although the view moved up", () => {
  assert.equal(readPin(true, 920, { top: 825, height: 1344, viewport: 519 }), true);
});

test("a move of a pixel or less is not the person leaving", () => {
  assert.equal(readPin(true, 400.5, { top: 400, height: 2000, viewport: 400 }), true);
  assert.equal(readPin(true, 402, { top: 400, height: 2000, viewport: 400 }), false);
});
