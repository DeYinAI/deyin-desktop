import { SearchUnavailableError, webSearch, type SearchResult } from "@deyin/host-core";
import type { ToolDefinition } from "../types.js";
import { asOptionalNumber, asString } from "./util.js";

export const websearchTool: ToolDefinition = {
  name: "websearch",
  description:
    "Search the web for current information (DuckDuckGo, with Bing as a fallback). Returns titles, URLs and snippets. Follow up with webfetch to read a result page.",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
      limit: { type: "number", description: "Maximum results (default 8)." },
    },
    required: ["query"],
  },
  summarize: (args) => String(args.query ?? ""),
  async execute(args): Promise<string> {
    const query = asString(args.query, "query");
    const limit = asOptionalNumber(args.limit) ?? 8;
    let results: SearchResult[];
    try {
      results = await webSearch(query, limit);
    } catch (err) {
      if (err instanceof SearchUnavailableError) {
        // Never fold this into "No results.": a model told nothing was found
        // stops looking, when in truth the search simply could not run.
        return `ERROR: ${err.message} This does not mean there are no results — the search could not run. Do not conclude the information does not exist: use webfetch on a URL you already know (official docs, the GitHub repo, the package registry page), or tell the user web search is unavailable.`;
      }
      throw err;
    }
    if (results.length === 0) return "No results.";
    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
      .join("\n");
  },
};
