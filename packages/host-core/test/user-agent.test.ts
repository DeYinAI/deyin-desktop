import assert from "node:assert/strict";
import { test } from "node:test";
import {
 buildDeyinUserAgent,
 deyinUserAgent,
 fetchWithUserAgent,
 initUserAgent,
 resetUserAgentForTest,
 withUserAgent,
} from "../src/user-agent.js";
import { fetchWithTransientRetry } from "../src/openference.js";

test("initUserAgent stores the UA and deyinUserAgent returns it", () => {
 const ua = initUserAgent("desktop", "1.2.3");
 assert.equal(ua, deyinUserAgent());
 assert.match(ua, /^Deyin\/1\.2\.3 \(desktop; /);
});

test("re-initialization overwrites the stored UA", () => {
 initUserAgent("cli", "0.1.0");
 assert.match(deyinUserAgent(), /^Deyin\/0\.1\.0 \(cli; /);
 initUserAgent("web-server", "0.2.0");
 assert.match(deyinUserAgent(), /^Deyin\/0\.2\.0 \(web-server; /);
});

test("uninitialized calls produce a well-formed, stable fallback", () => {
 resetUserAgentForTest();
 const ua = deyinUserAgent();
 assert.match(ua, /^Deyin\/0\.0\.0 \(unknown; (Windows|macOS|Linux|browser); (node\/\d+\.\d+|browser)\)$/);
 assert.equal(deyinUserAgent(), ua);
});

test("format is product/version (surface; platform; runtime)", () => {
 const ua = buildDeyinUserAgent("cli", "0.1.1");
 assert.match(ua, /^Deyin\/0\.1\.1 \(cli; (Windows|macOS|Linux); node\/\d+\.\d+\)$/);
});

/* Default User-Agent on fetch paths that never set one --------------------- */

/** Run `run` with a fetch stub that records every request's headers. */
async function recordHeaders(run: () => Promise<unknown>, status = 200): Promise<Headers[]> {
  const original = globalThis.fetch;
  const seen: Headers[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return new Response("{}", { status });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return seen;
}

test("withUserAgent adds the UA when the caller sent no headers", () => {
  initUserAgent("cli", "3.2.1");
  const init = withUserAgent({ method: "POST", body: "x" });
  assert.equal(init.method, "POST");
  assert.equal(init.body, "x");
  assert.deepEqual(init.headers, { "user-agent": deyinUserAgent() });
});

test("withUserAgent keeps plain-object headers plain and leaves other headers alone", () => {
  initUserAgent("cli", "3.2.1");
  const init = withUserAgent({ headers: { authorization: "Bearer t" } });
  assert.deepEqual(init.headers, { authorization: "Bearer t", "user-agent": deyinUserAgent() });
});

test("withUserAgent never overrides a caller-set UA, whatever the casing or header shape", () => {
  initUserAgent("cli", "3.2.1");
  const record = withUserAgent({ headers: { "User-Agent": "custom/1" } });
  assert.deepEqual(record.headers, { "User-Agent": "custom/1" });

  const instance = withUserAgent({ headers: new Headers({ "user-agent": "custom/2" }) });
  assert.equal(new Headers(instance.headers).get("user-agent"), "custom/2");

  const tuples = withUserAgent({ headers: [["USER-AGENT", "custom/3"]] });
  assert.equal(new Headers(tuples.headers).get("user-agent"), "custom/3");
});

test("withUserAgent fills the UA into Headers and tuple-array inputs", () => {
  initUserAgent("cli", "3.2.1");
  for (const headers of [new Headers({ accept: "text/plain" }), [["accept", "text/plain"]] as [string, string][]]) {
    const merged = new Headers(withUserAgent({ headers }).headers);
    assert.equal(merged.get("user-agent"), deyinUserAgent());
    assert.equal(merged.get("accept"), "text/plain");
  }
});

test("fetchWithUserAgent identifies as Deyin and keeps a Request's own headers", async () => {
  initUserAgent("desktop", "4.5.6");
  const [plain] = await recordHeaders(() => fetchWithUserAgent("https://example.test/a"));
  assert.equal(plain?.get("user-agent"), deyinUserAgent());

  const request = new Request("https://example.test/b", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const [fromRequest] = await recordHeaders(() => fetchWithUserAgent(request, { headers: { "x-extra": "1" } }));
  assert.equal(fromRequest?.get("user-agent"), deyinUserAgent());
  assert.equal(fromRequest?.get("content-type"), "application/json");
  assert.equal(fromRequest?.get("x-extra"), "1");
});

test("fetchWithTransientRetry defaults the UA on the first attempt and on every retry", async () => {
  initUserAgent("desktop", "4.5.6");
  const original = globalThis.fetch;
  const seen: (string | null)[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("user-agent"));
    return new Response("{}", { status: seen.length === 1 ? 503 : 200 });
  }) as typeof fetch;
  try {
    const res = await fetchWithTransientRetry("https://example.test/chat", { method: "POST" });
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(seen, [deyinUserAgent(), deyinUserAgent()]);
});

test("fetchWithTransientRetry leaves a caller-set UA untouched", async () => {
  initUserAgent("desktop", "4.5.6");
  const [explicit] = await recordHeaders(() =>
    fetchWithTransientRetry("https://example.test/chat", { method: "POST", headers: { "user-agent": "mine/1" } }),
  );
  assert.equal(explicit?.get("user-agent"), "mine/1");
});
