import assert from "node:assert/strict";
import test from "node:test";
import { splitInlineEmbeds } from "../src/embeds.js";

test("splitInlineEmbeds: pulls image directives out of the surrounding markdown", () => {
  const segments = splitInlineEmbeds('Here it is:\n\n::deyin-inline-image{file="img-a.png" alt="Fox"}\n\nWant a variant?');
  assert.deepEqual(segments, [
    { kind: "md", text: "Here it is:\n\n" },
    { kind: "image", file: "img-a.png", alt: "Fox" },
    { kind: "md", text: "\n\nWant a variant?" },
  ]);
});

test("splitInlineEmbeds: keeps visualization directives working alongside images", () => {
  const segments = splitInlineEmbeds('::deyin-inline-vis{file="chart.html" title="Sales"}::deyin-inline-image{file="i.png"}');
  assert.deepEqual(segments, [
    { kind: "vis", file: "chart.html", title: "Sales" },
    { kind: "image", file: "i.png", alt: undefined },
  ]);
});

test("splitInlineEmbeds: plain markdown stays one segment", () => {
  assert.deepEqual(splitInlineEmbeds("no directives here"), [{ kind: "md", text: "no directives here" }]);
});

test("splitInlineEmbeds: a directive without a file is dropped, not rendered", () => {
  assert.deepEqual(splitInlineEmbeds('before ::deyin-inline-image{alt="broken"} after'), [
    { kind: "md", text: "before " },
    { kind: "md", text: " after" },
  ]);
});
