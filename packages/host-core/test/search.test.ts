import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  SearchUnavailableError,
  isDuckDuckGoChallenge,
  parseBingHtml,
  parseDuckDuckGoHtml,
  resetSearchBackends,
  webSearch,
} from "../src/search.js";

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

/* -------------------------------------------------------------------------- */
/* Bing parsing + multi-engine fallback                                       */
/* -------------------------------------------------------------------------- */

/** Bing wraps result links as /ck/a?...&u=a1<base64url of the target>. */
function bingRedirect(target: string): string {
  return `https://www.bing.com/ck/a?!&amp;&amp;p=abc123&amp;u=a1${Buffer.from(target).toString("base64url")}&amp;ntb=1`;
}

const BING_FIXTURE = `
<ol id="b_results">
 <li class="b_ad"><h2><a href="https://ads.example/x">Sponsored result</a></h2><p>Buy now</p></li>
 <li class="b_algo" data-id="">
  <h2><a href="${bingRedirect("https://example.com/docs?x=1&y=é")}">Example <strong>Docs</strong></a></h2>
  <div class="b_caption"><p class="b_lineclamp2">Jan 1, 2026 · The &quot;official&quot; docs &amp; guides.</p></div>
  <ul class="b_vList"><li><a href="https://example.com/sitelink">Sitelink</a></li></ul>
 </li>
 <li class="b_algo b_algoBorder">
  <h2><a href="https://direct.example.org/page">Direct link</a></h2>
  <div class="b_caption"><p>Second snippet</p></div>
 </li>
 <li class="b_algo"><h2><a href="javascript:void(0)">Bad scheme</a></h2><p>ignored</p></li>
 <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=b2notbase64">Undecodable redirect</a></h2></li>
 <li class="b_algo"><h2><a href="https://nosnippet.example/n">No snippet</a></h2></li>
</ol>`;

test("parseBingHtml unwraps ck/a redirects, decodes entities and skips ads", () => {
  const results = parseBingHtml(BING_FIXTURE, 8);
  assert.deepEqual(results, [
    {
      title: "Example Docs",
      url: "https://example.com/docs?x=1&y=%C3%A9",
      snippet: 'Jan 1, 2026 · The "official" docs & guides.',
    },
    { title: "Direct link", url: "https://direct.example.org/page", snippet: "Second snippet" },
    { title: "No snippet", url: "https://nosnippet.example/n", snippet: "" },
  ]);
});

test("parseBingHtml honors the limit and tolerates garbage", () => {
  assert.equal(parseBingHtml(BING_FIXTURE, 1).length, 1);
  assert.deepEqual(parseBingHtml(BING_FIXTURE, 0), []);
  assert.deepEqual(parseBingHtml("<html>nothing here</html>", 5), []);
});

test("isDuckDuckGoChallenge recognises the 202 anomaly page, not a normal results page", () => {
  assert.equal(isDuckDuckGoChallenge(202, ""), true, "HTTP 202 alone is the challenge");
  assert.equal(isDuckDuckGoChallenge(200, '<div class="anomaly-modal__modal">Select all squares</div>'), true);
  assert.equal(isDuckDuckGoChallenge(200, "Unfortunately, bots use DuckDuckGo too."), true);
  assert.equal(isDuckDuckGoChallenge(200, FIXTURE), false, "a real results page is not a challenge");
});

const DDG_OK = `<a class="result__a" href="https://ddg.example/hit">DDG hit</a><a class="result__snippet" href="/l/">ddg snippet</a>`;
const DDG_CHALLENGE = '<div class="anomaly-modal__modal">Unfortunately, bots use DuckDuckGo too.</div>';
const BING_OK = `<li class="b_algo"><h2><a href="https://bing.example/hit">Bing hit</a></h2><p>bing snippet</p></li>`;

interface Route {
  status?: number;
  body?: string;
  throws?: Error;
}

/** A fetch that routes by hostname and records every URL it was asked for. */
function fakeFetch(routes: { ddg?: Route; bing?: Route }): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    const route = url.includes("duckduckgo.com") ? routes.ddg : url.includes("bing.com") ? routes.bing : undefined;
    if (!route) throw new Error(`unexpected request: ${url}`);
    if (route.throws) throw route.throws;
    return new Response(route.body ?? "", { status: route.status ?? 200 });
  };
  return { fetch: impl as typeof fetch, urls };
}

beforeEach(() => resetSearchBackends());

test("webSearch answers from DuckDuckGo and never touches Bing when DDG has results", async () => {
  const f = fakeFetch({ ddg: { body: DDG_OK }, bing: { body: BING_OK } });
  const results = await webSearch("anything", 8, { fetch: f.fetch });
  assert.deepEqual(results.map((r) => r.title), ["DDG hit"]);
  assert.ok(f.urls.every((u) => u.includes("duckduckgo.com")), "Bing must not be queried");
});

test("webSearch falls back to Bing when DuckDuckGo serves the HTTP 202 bot challenge", async () => {
  // Regression: the challenge page has no results, so the old single-engine
  // search parsed it as "zero results" and the model concluded nothing existed.
  const f = fakeFetch({ ddg: { status: 202, body: DDG_CHALLENGE }, bing: { body: BING_OK } });
  const results = await webSearch("anything", 8, { fetch: f.fetch });
  assert.deepEqual(results.map((r) => r.title), ["Bing hit"]);
});

test("webSearch also treats a 200 page carrying the challenge marker as blocked", async () => {
  const f = fakeFetch({ ddg: { status: 200, body: DDG_CHALLENGE }, bing: { body: BING_OK } });
  assert.deepEqual((await webSearch("q", 8, { fetch: f.fetch })).map((r) => r.title), ["Bing hit"]);
});

test("a challenged engine is left alone for a while, then retried", async () => {
  let clock = 1_000_000;
  const now = () => clock;
  const f = fakeFetch({ ddg: { status: 202, body: DDG_CHALLENGE }, bing: { body: BING_OK } });

  await webSearch("first", 8, { fetch: f.fetch, now });
  const ddgAfterFirst = f.urls.filter((u) => u.includes("duckduckgo.com")).length;
  assert.equal(ddgAfterFirst, 1);

  // Within the cooldown DDG is not hammered again — that would only prolong the block.
  clock += 60_000;
  await webSearch("second", 8, { fetch: f.fetch, now });
  assert.equal(f.urls.filter((u) => u.includes("duckduckgo.com")).length, ddgAfterFirst, "DDG skipped in cooldown");

  // After the cooldown it gets another chance.
  clock += 10 * 60_000;
  await webSearch("third", 8, { fetch: f.fetch, now });
  assert.equal(f.urls.filter((u) => u.includes("duckduckgo.com")).length, ddgAfterFirst + 1, "DDG retried after cooldown");
});

test("webSearch never sends the parameters that make Bing return decoy results", async () => {
  const f = fakeFetch({ ddg: { status: 202, body: DDG_CHALLENGE }, bing: { body: BING_OK } });
  await webSearch("typescript exhaustive switch", 8, { fetch: f.fetch });
  const bingUrl = f.urls.find((u) => u.includes("bing.com"));
  assert.ok(bingUrl, "Bing was queried");
  const params = new URL(bingUrl).searchParams;
  assert.deepEqual([...params.keys()], ["q"], "plain /search?q= only (cc/setlang/mkt/count trigger decoys)");
  assert.equal(params.get("q"), "typescript exhaustive switch");
});

test("webSearch throws SearchUnavailableError — not an empty list — when every engine fails", async () => {
  const f = fakeFetch({
    ddg: { status: 202, body: DDG_CHALLENGE },
    bing: { status: 503, body: "unavailable" },
  });
  await assert.rejects(
    () => webSearch("q", 8, { fetch: f.fetch }),
    (err: unknown) => {
      assert.ok(err instanceof SearchUnavailableError);
      assert.match(err.message, /DuckDuckGo: bot challenge/);
      assert.match(err.message, /Bing: HTTP 503/);
      assert.equal(err.failures.length, 2);
      return true;
    },
  );
});

test("network errors count as an engine failure and fall through to the next engine", async () => {
  const f = fakeFetch({ ddg: { throws: new TypeError("fetch failed") }, bing: { body: BING_OK } });
  assert.deepEqual((await webSearch("q", 8, { fetch: f.fetch })).map((r) => r.title), ["Bing hit"]);
});

test("webSearch returns [] only when an engine answered properly with no results", async () => {
  // A blocked DDG plus an answering-but-empty Bing is a genuine "no results".
  const f = fakeFetch({
    ddg: { status: 202, body: DDG_CHALLENGE },
    bing: { body: '<html><body id="b_results">No results found</body></html>' },
  });
  assert.deepEqual(await webSearch("qzxwv nonsense", 8, { fetch: f.fetch }), []);
});

test("a Bing captcha page is a failure, not an empty answer", async () => {
  const f = fakeFetch({
    ddg: { status: 202, body: DDG_CHALLENGE },
    bing: { body: '<div id="b_captcha">Please solve the captcha</div>' },
  });
  await assert.rejects(() => webSearch("q", 8, { fetch: f.fetch }), SearchUnavailableError);
});

test("webSearch on a blank query does no network I/O", async () => {
  const f = fakeFetch({});
  assert.deepEqual(await webSearch("   ", 8, { fetch: f.fetch }), []);
  assert.equal(f.urls.length, 0);
});

test("the honest Deyin UA being refused with 403 is retried once with a browser UA", async () => {
  const seen: string[] = [];
  let calls = 0;
  const impl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls += 1;
    seen.push(String((init?.headers as Record<string, string> | undefined)?.["user-agent"] ?? ""));
    return calls === 1 ? new Response("forbidden", { status: 403 }) : new Response(DDG_OK, { status: 200 });
  };
  const results = await webSearch("q", 8, { fetch: impl as typeof fetch });
  assert.deepEqual(results.map((r) => r.title), ["DDG hit"]);
  assert.equal(calls, 2);
  assert.match(seen[1] ?? "", /Mozilla\/5\.0/, "the retry used a browser-shaped UA");
});
