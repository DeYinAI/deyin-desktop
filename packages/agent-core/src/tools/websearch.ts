import { webSearch } from "@deyin/host-core";
import type { ToolDefinition } from "../types.js";
import { asOptionalNumber, asString } from "./util.js";

export const websearchTool: ToolDefinition = {
  name: "websearch",
  description: "Search the web (DuckDuckGo) for current information. Returns titles, URLs and snippets.",
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
    const results = await webSearch(query, limit);
    if (results.length === 0) return "No results.";
    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
      .join("\n");
  },
};
