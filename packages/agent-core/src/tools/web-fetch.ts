import type { ToolDefinition } from "../types.js";
import { asOptionalNumber, asString } from "./util.js";
import { deyinUserAgent } from "@deyin/host-core";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 80_000;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description: "Fetch a URL and return its content as plain text or markdown-friendly text.",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "HTTP or HTTPS URL to fetch." },
      timeout_ms: { type: "number", description: "Request timeout in milliseconds (default 30000)." },
    },
    required: ["url"],
  },
  summarize: (args) => String(args.url ?? ""),
  async execute(args, ctx): Promise<string> {
    const url = asString(args.url, "url");
    const timeoutMs = asOptionalNumber(args.timeout_ms) ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (ctx.signal) {
      const onAbort = () => controller.abort();
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": deyinUserAgent(), Accept: "text/html,application/json,text/plain,*/*" },
      });
      if (!res.ok) return `HTTP ${res.status} ${res.statusText} for ${url}`;
      const contentType = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      let body = raw;
      if (contentType.includes("text/html")) body = stripHtml(raw);
      if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}\n... [truncated]`;
      return `URL: ${url}\nContent-Type: ${contentType || "unknown"}\n\n${body}`;
    } catch (err) {
      if (controller.signal.aborted) return `Request timed out after ${timeoutMs}ms: ${url}`;
      return `ERROR fetching ${url}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      clearTimeout(timer);
    }
  },
};
