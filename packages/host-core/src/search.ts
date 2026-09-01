import type { SearchResult } from "./types.js";

/**
 * Built-in free web search: queries DuckDuckGo's HTML endpoint (no API key, no quota)
 * and parses the result list. Used by the Search overlay, the web host-server, and the
 * agent's websearch tool.
 */
export async function webSearch(query: string, limit = 8): Promise<SearchResult[]> {
 const q = query.trim();
 if (!q) return [];

 const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
 headers: {
 "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Deyin/0.1",
 accept: "text/html",
 },
 signal: AbortSignal.timeout(10_000),
 });
 if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
 return parseDuckDuckGoHtml(await res.text(), limit);
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
