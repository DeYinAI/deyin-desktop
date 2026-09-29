import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { resetSearchBackends } from "@deyin/host-core";
import { websearchTool } from "../src/tools/websearch.js";
import type { ToolContext } from "../src/types.js";

/**
 * The websearch tool is the agent's only window onto the web. DuckDuckGo's HTML
 * endpoint answers scrapers with an HTTP 202 "anomaly" challenge page that the
 * old code parsed as "zero results" — so a blocked search read as "the internet
 * has nothing on this", and the model would stop looking. These pin the fix.
 */

const CTX = { signal: undefined } as unknown as ToolContext;

const DDG_CHALLENGE = '<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></body></html>';
const DDG_EMPTY = "<html><body><div class='no-results'>No results.</div></body></html>";
const BING_RESULTS = `<ol id="b_results">
<li class="b_algo"><h2><a href="https://example.com/a">Result &amp; A</a></h2><div class="b_caption"><p>First snippet</p></div></li>
<li class="b_algo"><h2><a href="https://example.org/b">Result B</a></h2><div class="b_caption"><p>Second snippet</p></div></li>
</ol>`;
const BING_EMPTY = '<ol id="b_results"><li class="b_no">There are no results for that.</li></ol>';

type Route = (url: URL) => Response;
const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/html" } });

const originalFetch = globalThis.fetch;
let seen: string[] = [];

function route(handlers: { ddg: Route; bing: Route }): void {
  seen = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push(url.hostname);
    if (url.hostname.endsWith("duckduckgo.com")) return handlers.ddg(url);
    if (url.hostname.endsWith("bing.com")) return handlers.bing(url);
    return new Response("unexpected host", { status: 500 });
  }) as typeof fetch;
}

beforeEach(() => resetSearchBackends());
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("a challenged DuckDuckGo falls through to Bing and the results come back formatted", async () => {
  route({ ddg: () => html(DDG_CHALLENGE, 202), bing: () => html(BING_RESULTS) });
  const out = await websearchTool.execute({ query: "deyin desktop" }, CTX);
  assert.equal(
    out,
    ["1. Result & A", "   https://example.com/a", "   First snippet", "2. Result B", "   https://example.org/b", "   Second snippet"].join("\n"),
  );
  assert.ok(seen.some((h) => h.endsWith("duckduckgo.com")), "DuckDuckGo is tried first");
  assert.ok(seen.some((h) => h.endsWith("bing.com")));
});

test("when no engine can answer, the model is told the search could not run — never 'No results'", async () => {
  route({ ddg: () => html(DDG_CHALLENGE, 202), bing: () => html("upstream error", 500) });
  const out = await websearchTool.execute({ query: "anything" }, CTX);
  assert.match(out, /^ERROR: Web search is unavailable/);
  assert.match(out, /does not mean there are no results/);
  assert.match(out, /webfetch/, "it points the model at a way forward");
  assert.doesNotMatch(out, /^No results\.?$/);
});

test("'No results.' is reserved for engines that genuinely answered with nothing", async () => {
  route({ ddg: () => html(DDG_EMPTY), bing: () => html(BING_EMPTY) });
  assert.equal(await websearchTool.execute({ query: "zzzz qqqq xxxx" }, CTX), "No results.");
});

test("a working first engine is enough: Bing is not consulted", async () => {
  const ddgResults =
    '<div class="result results_links results_links_deep web-result"><h2 class="result__title"><a class="result__a" href="https://example.net/ddg">DDG hit</a></h2><a class="result__snippet" href="https://example.net/ddg">A DDG snippet</a></div>';
  route({ ddg: () => html(ddgResults), bing: () => html(BING_RESULTS) });
  const out = await websearchTool.execute({ query: "q" }, CTX);
  assert.match(out, /DDG hit/);
  assert.ok(!seen.some((h) => h.endsWith("bing.com")));
});

test("the limit argument caps the number of results", async () => {
  route({ ddg: () => html(DDG_CHALLENGE, 202), bing: () => html(BING_RESULTS) });
  const out = await websearchTool.execute({ query: "q", limit: 1 }, CTX);
  assert.match(out, /Result & A/);
  assert.doesNotMatch(out, /Result B/);
});
