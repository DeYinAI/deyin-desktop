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

// Regression: results without snippets must not shift later snippets onto the
// wrong result (the old implementation paired snippets by array index).
const MISALIGNED = `
<div class="result">
 <a class="result__a" href="/l/?uddg=https%3A%2F%2Fa.example%2F1">First</a>
 <a class="result__snippet" href="/l/">Snippet for FIRST</a>
</div>
<div class="result">
 <a class="result__a" href="/l/?uddg=https%3A%2F%2Fb.example%2F2">Second (no snippet)</a>
</div>
<div class="result">
 <a class="result__a" href="/l/?uddg=https%3A%2F%2Fc.example%2F3">Third</a>
 <a class="result__snippet" href="/l/">Snippet for THIRD</a>
</div>`;

test("keeps snippets aligned when a result has no snippet", () => {
 const results = parseDuckDuckGoHtml(MISALIGNED, 8);
 assert.deepEqual(results, [
 { title: "First", url: "https://a.example/1", snippet: "Snippet for FIRST" },
 { title: "Second (no snippet)", url: "https://b.example/2", snippet: "" },
 { title: "Third", url: "https://c.example/3", snippet: "Snippet for THIRD" },
 ]);
});

test("skips empty/garbage titles and honors the limit", () => {
 const html = `
 <a class="result__a" href="javascript:void(0)">bad scheme</a>
 <a class="result__a" href="https://good.example/x">Good</a>
 <a class="result__snippet" href="https://good.example/x">Good snippet</a>
 <a class="result__a" href="https://overflow.example/y">Overflow</a>`;
 const results = parseDuckDuckGoHtml(html, 1);
 assert.deepEqual(results, [{ title: "Good", url: "https://good.example/x", snippet: "Good snippet" }]);
});

test("decodes numeric and named entities without double-decoding", () => {
 const html = `
 <a class="result__a" href="https://e.example/x">Caf&eacute; &amp; Co &#x2713; &#39;q&#39; &amp;amp; literal</a>
 <a class="result__snippet" href="https://e.example/x">a &lt;b&gt; &#8230; end &amp;notanentity;</a>`;
 const [r] = parseDuckDuckGoHtml(html, 8);
 // single-encoded refs decode fully; "&amp;amp;" stays literal "&amp;" after
 // one pass (browser behavior); unknown entities remain untouched.
 assert.equal(r?.title, "Café & Co ✓ 'q' &amp; literal");
 assert.equal(r?.snippet, "a <b> … end &notanentity;");
});
