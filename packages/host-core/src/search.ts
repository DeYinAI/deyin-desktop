import type { SearchResult } from "./types.js";
import { deyinUserAgent } from "./user-agent.js";

/**
 * Built-in free web search (no API key, no quota): DuckDuckGo's HTML endpoint,
 * with Bing as a fallback. Used by the Search overlay, the web host-server, and the
 * agent's websearch tool.
 *
 * Why two engines: DuckDuckGo answers automated clients with an HTTP 202
 * "anomaly" challenge page once an IP has made a handful of queries — and an
 * agent researching a task issues exactly that kind of burst. That page has no
 * results, so the old single-engine search parsed it as "zero results" and the
 * model concluded the answer did not exist. A challenged engine is now treated
 * as a failure (not an empty answer), the next engine is tried, and a blocked
 * engine is left alone for a while so the block is not prolonged by hammering it.
 * Google is not an option: plain HTTP gets a JavaScript-required interstitial.
 */

/** A browser-shaped UA, for engines that refuse or degrade for unknown agents. */
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 10_000;
/** How long an engine that served a bot challenge is skipped. */
const CHALLENGE_COOLDOWN_MS = 5 * 60_000;
/** How long an engine that errored (network, 5xx, unparsable) is skipped. */
const ERROR_COOLDOWN_MS = 60_000;

type BackendName = "DuckDuckGo" | "Bing";

type BackendOutcome =
  | { ok: true; results: SearchResult[] }
  | { ok: false; reason: string; cooldownMs: number };

type FetchLike = typeof fetch;

/** Every engine failed (blocked, unreachable, or unparsable) — distinct from "no results". */
export class SearchUnavailableError extends Error {
  readonly failures: readonly string[];
  constructor(failures: readonly string[]) {
    super(`Web search is unavailable right now (${failures.join("; ")}).`);
    this.name = "SearchUnavailableError";
    this.failures = failures;
  }
}

export interface WebSearchOptions {
  /** fetch implementation; tests inject a fake. Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Clock in ms; tests inject a fake to step through cooldowns. */
  now?: () => number;
}

/** Engines skipped until the given epoch ms; process-wide, like the IP reputation it protects. */
const cooldownUntil = new Map<BackendName, number>();

/** Forget which engines are cooling down (tests, and an explicit "retry search now"). */
export function resetSearchBackends(): void {
  cooldownUntil.clear();
}

/**
 * Some sites block non-browser agents; if the honest Deyin UA is refused, retry
 * once with a browser-shaped UA so the built-in search keeps working. Normal
 * responses (200 or any other status) are returned untouched.
 */
async function fetchDdgHtml(q: string, doFetch: FetchLike): Promise<Response> {
 const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
 const honest = await doFetch(url, {
 headers: { "user-agent": deyinUserAgent(), accept: "text/html" },
 signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
 });
 if (honest.status !== 403 && honest.status !== 429) return honest;
 return doFetch(url, {
 headers: { "user-agent": BROWSER_UA, accept: "text/html" },
 signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
 });
}

/** DuckDuckGo's bot-check page: served with HTTP 202 and carries no results. */
export function isDuckDuckGoChallenge(status: number, body: string): boolean {
  return status === 202 || /anomaly-modal|bots use DuckDuckGo too/i.test(body);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

async function searchDuckDuckGo(q: string, limit: number, doFetch: FetchLike): Promise<BackendOutcome> {
  let res: Response;
  try {
    res = await fetchDdgHtml(q, doFetch);
  } catch (err) {
    return { ok: false, reason: describeError(err), cooldownMs: ERROR_COOLDOWN_MS };
  }
  if (res.status === 202) {
    return { ok: false, reason: "bot challenge (HTTP 202)", cooldownMs: CHALLENGE_COOLDOWN_MS };
  }
  if (!res.ok) {
    const blocked = res.status === 403 || res.status === 429;
    return {
      ok: false,
      reason: `HTTP ${res.status}`,
      cooldownMs: blocked ? CHALLENGE_COOLDOWN_MS : ERROR_COOLDOWN_MS,
    };
  }
  let body: string;
  try {
    body = await res.text();
  } catch (err) {
    return { ok: false, reason: describeError(err), cooldownMs: ERROR_COOLDOWN_MS };
  }
  if (isDuckDuckGoChallenge(res.status, body)) {
    return { ok: false, reason: "bot challenge", cooldownMs: CHALLENGE_COOLDOWN_MS };
  }
  return { ok: true, results: parseDuckDuckGoHtml(body, limit) };
}

async function searchBing(q: string, limit: number, doFetch: FetchLike): Promise<BackendOutcome> {
  // Plain `/search?q=` only. Bing answers requests carrying `cc=`, `setlang=`,
  // `mkt=` or `count=` from a cookie-less client with decoy results that have
  // nothing to do with the query (measured: 10/10 relevant without them, 0/7 with).
  const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: {
        "user-agent": BROWSER_UA,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: describeError(err), cooldownMs: ERROR_COOLDOWN_MS };
  }
  if (!res.ok) {
    const blocked = res.status === 403 || res.status === 429;
    return {
      ok: false,
      reason: `HTTP ${res.status}`,
      cooldownMs: blocked ? CHALLENGE_COOLDOWN_MS : ERROR_COOLDOWN_MS,
    };
  }
  let body: string;
  try {
    body = await res.text();
  } catch (err) {
    return { ok: false, reason: describeError(err), cooldownMs: ERROR_COOLDOWN_MS };
  }
  const results = parseBingHtml(body, limit);
  if (results.length === 0 && /id="b_captcha"|\bcaptcha\b/i.test(body)) {
    return { ok: false, reason: "bot challenge", cooldownMs: CHALLENGE_COOLDOWN_MS };
  }
  return { ok: true, results };
}

const BACKENDS: ReadonlyArray<{
  name: BackendName;
  search: (q: string, limit: number, doFetch: FetchLike) => Promise<BackendOutcome>;
}> = [
  { name: "DuckDuckGo", search: searchDuckDuckGo },
  { name: "Bing", search: searchBing },
];

/**
 * Search the web. Resolves with results from the first engine that has any;
 * `[]` when an engine answered properly but found nothing; and throws
 * {@link SearchUnavailableError} when no engine could answer at all — so a
 * caller can tell "nothing exists" apart from "could not look".
 */
export async function webSearch(query: string, limit = 8, opts: WebSearchOptions = {}): Promise<SearchResult[]> {
 const q = query.trim();
 if (!q) return [];

 const doFetch = opts.fetch ?? fetch;
 const now = opts.now ?? Date.now;
 const failures: string[] = [];
 let answered = false;
 for (const backend of BACKENDS) {
  if ((cooldownUntil.get(backend.name) ?? 0) > now()) {
   failures.push(`${backend.name}: skipped, recently blocked`);
   continue;
  }
  const outcome = await backend.search(q, limit, doFetch);
  if (outcome.ok) {
   if (outcome.results.length > 0) return outcome.results;
   answered = true;
   continue;
  }
  cooldownUntil.set(backend.name, now() + outcome.cooldownMs);
  failures.push(`${backend.name}: ${outcome.reason}`);
 }
 if (answered) return [];
 throw new SearchUnavailableError(failures);
}

/**
 * Extract title/url/snippet triples from a Bing results page.
 *
 * Each organic result is an `<li class="b_algo">`; ads use other classes and are
 * skipped. Titles link through `bing.com/ck/a?...&u=a1<base64url target>`
 * tracking redirects, which are unwrapped to the real URL.
 */
export function parseBingHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  if (limit <= 0) return results;
  // Split rather than match to `</li>`: sitelinks nest further <li>s inside a result.
  const blocks = html.split(/<li\b[^>]*\bclass="[^"]*\bb_algo\b[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    const title = /<h2\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(block);
    if (!title) continue;
    const url = resolveBingRedirect(decodeEntities(attrValue(title[1] ?? "", "href") ?? ""));
    const text = decodeEntities(stripTags(title[2] ?? ""));
    if (!url || !text) continue;
    const snippet = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    results.push({ title: text, url, snippet: snippet ? decodeEntities(stripTags(snippet[1] ?? "")) : "" });
    if (results.length >= limit) break;
  }
  return results;
}

/** Bing links results through /ck/a?u=a1<base64url target>; unwrap to the real URL. */
function resolveBingRedirect(href: string): string {
  try {
    const url = new URL(href, "https://www.bing.com");
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!/(^|\.)bing\.com$/i.test(url.hostname) || !url.pathname.startsWith("/ck/a")) return url.toString();
    const encoded = url.searchParams.get("u");
    if (!encoded || !encoded.startsWith("a1")) return "";
    const b64 = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const target = new URL(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
    return target.protocol === "http:" || target.protocol === "https:" ? target.toString() : "";
  } catch {
    return "";
  }
}

/**
 * Extract title/url/snippet triples from the DDG html results page.
 *
 * Anchors are processed in document order: a `result__a` anchor starts a new
 * result and the next `result__snippet` anchor attaches to it. Results without
 * a snippet keep an empty snippet instead of shifting every later snippet onto
 * the wrong result (the old parallel-arrays approach).
 */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
 const results: SearchResult[] = [];
 if (limit <= 0) return results;

 const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
 let current: SearchResult | null = null;
 const flush = () => {
 if (current && current.title && current.url) results.push(current);
 current = null;
 };

 for (const m of html.matchAll(anchorRe)) {
 const attrs = m[1] ?? "";
 const cls = attrValue(attrs, "class") ?? "";
 const isTitle = /(?:^|\s)result__a(?:\s|$)/.test(cls);
 const isSnippet = /(?:^|\s)result__snippet(?:\s|$)/.test(cls);
 if (!isTitle && !isSnippet) continue;

 const text = decodeEntities(stripTags(m[2] ?? ""));
 if (isTitle) {
 flush();
 const url = resolveDdgRedirect(decodeEntities(attrValue(attrs, "href") ?? ""));
 if (url && text) current = { title: text, url, snippet: "" };
 } else if (current && !current.snippet && text) {
 current.snippet = text;
 }
 if (results.length >= limit) break;
 }
 if (results.length < limit) flush();
 return results;
}

/** DDG links results through /l/?uddg=<encoded target>; unwrap to the real URL. */
function resolveDdgRedirect(href: string): string {
 try {
 const url = new URL(href, "https://duckduckgo.com");
 const target = url.searchParams.get("uddg");
 if (target) return decodeURIComponent(target);
 if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
 return "";
 } catch {
 return "";
 }
}

function stripTags(s: string): string {
 return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Named entities seen in DDG result markup. This is deliberately a curated
 * subset (the old hand-rolled map plus common punctuation/accents), not the
 * full HTML5 table; unknown names stay literal, matching browser behavior for
 * text that isn't a valid reference.
 */
const NAMED_ENTITIES: Record<string, string> = {
 amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
 hellip: "…", mdash: "—", ndash: "–", middot: "·", bull: "•",
 lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
 laquo: "«", raquo: "»", deg: "°", micro: "µ", para: "¶", sect: "§",
 plusmn: "±", times: "×", divide: "÷", frac12: "½", frac14: "¼", frac34: "¾",
 sup1: "¹", sup2: "²", sup3: "³",
 copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥", cent: "¢",
 eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", uuml: "ü", ouml: "ö",
 auml: "ä", szlig: "ß", ntilde: "ñ",
};

/**
 * Decode HTML character references in one pass. Unlike string-chained replaces,
 * decoded output is never re-scanned, so "&amp;amp;" correctly yields "&amp;"
 * (same as a browser). Handles decimal/hex numeric refs for the full Unicode
 * range; invalid refs are left as literal text.
 */
export function decodeEntities(s: string): string {
 return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (raw, body: string) => {
 if (body.startsWith("#")) {
 const code = body[1] === "x" || body[1] === "X"
 ? Number.parseInt(body.slice(2), 16)
 : Number.parseInt(body.slice(1), 10);
 if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
 return raw;
 }
 return String.fromCodePoint(code);
 }
 return NAMED_ENTITIES[body] ?? raw;
 });
}

/** Read an attribute value out of an anchor's attribute blob (quote style agnostic). */
function attrValue(attrs: string, name: string): string | undefined {
 const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
 if (!m) return undefined;
 return m[2] ?? m[3] ?? "";
}
