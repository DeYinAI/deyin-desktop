/** True when a string looks like a full HTML page (not a tiny snippet). */
export function isFullHtmlDocument(html: string): boolean {
  const trimmed = html.trim();
  if (trimmed.length < 80) return false;
  if (/^<!DOCTYPE\s+html/i.test(trimmed)) return true;
  if (/^<html[\s>]/i.test(trimmed)) return true;
  return /<head[\s>]/i.test(trimmed) && /<body[\s>]/i.test(trimmed);
}

export function encodeSrcdoc(html: string): string {
  return html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Extract the first ```html fence that contains a full HTML document. */
export function extractHtmlPageFromMarkdown(text: string): string | null {
  const fence = /```(?:html|htm)\s*\n([\s\S]*?)(?:```|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    const body = (match[1] ?? "").trim();
    if (isFullHtmlDocument(body)) return body;
  }
  return null;
}

/** Prefer html/html fences; fall back to the largest fenced block that is a full document. */
export function extractHtmlPageFromMarkdownLoose(text: string): string | null {
  const tagged = extractHtmlPageFromMarkdown(text);
  if (tagged) return tagged;

  const anyFence = /```[^\n`]*\n([\s\S]*?)(?:```|$)/g;
  let best: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = anyFence.exec(text)) !== null) {
    const body = (match[1] ?? "").trim();
    if (isFullHtmlDocument(body) && (!best || body.length > best.length)) best = body;
  }
  return best;
}

export function titleFromHtml(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = m?.[1]?.replace(/\s+/g, " ").trim();
  return title || undefined;
}
