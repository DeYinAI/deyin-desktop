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

/** Extract title/url/snippet triples from the DDG html results page. */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const snippets: string[] = [];
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
    snippets.push(decodeEntities(stripTags(m[1] ?? "")));
  }

  let i = 0;
  for (let m = anchorRe.exec(html); m && results.length < limit; m = anchorRe.exec(html), i++) {
    const url = resolveDdgRedirect(m[1] ?? "");
    const title = decodeEntities(stripTags(m[2] ?? ""));
    if (!url || !title) continue;
    results.push({ title, url, snippet: snippets[i] ?? "" });
  }
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

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
