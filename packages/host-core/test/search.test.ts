import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuckDuckGoHtml } from "../src/search.js";

const FIXTURE = `
<div class="result">
  <a rel="nofollow" class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example <b>Docs</b></a>
  <a class="result__snippet" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">The &quot;official&quot; docs &amp; guides.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://plain.example.org/page">Plain link</a>
  <a class="result__snippet" href="https://plain.example.org/page">Second snippet</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="javascript:void(0)">Bad scheme</a>
</div>
`;

test("parses titles, unwraps DDG redirects and decodes entities", () => {
  const results = parseDuckDuckGoHtml(FIXTURE, 8);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    title: "Example Docs",
    url: "https://example.com/docs",
    snippet: 'The "official" docs & guides.',
  });
  assert.equal(results[1]?.url, "https://plain.example.org/page");
});

test("respects the limit", () => {
  assert.equal(parseDuckDuckGoHtml(FIXTURE, 1).length, 1);
});

test("returns empty on garbage input", () => {
  assert.deepEqual(parseDuckDuckGoHtml("<html>nothing here</html>", 5), []);
});
