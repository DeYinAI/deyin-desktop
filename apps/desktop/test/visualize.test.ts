import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInlineVisDirectives, stripInlineVisDirectives } from "../src/main/visualize-directive.js";

test("parse inline visualization directives", () => {
  const text = 'Here is a chart:\n::deyin-inline-vis{file="chart.html" title="Sales"}';
  const dirs = parseInlineVisDirectives(text);
  assert.equal(dirs.length, 1);
  assert.equal(dirs[0]?.file, "chart.html");
  assert.equal(dirs[0]?.title, "Sales");
  assert.equal(stripInlineVisDirectives(text).includes("::deyin-inline-vis"), false);
});
