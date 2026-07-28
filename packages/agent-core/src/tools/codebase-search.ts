import type { ToolDefinition } from "../types.js";
import { asString } from "./util.js";

export interface CodebaseSearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  preview: string;
}

/**
 * Semantic codebase search backed by the host's local index. Injected as a
 * factory because the index lives with the host (desktop main process), not
 * the agent runtime.
 */
export function createCodebaseSearchTool(
  search: (query: string, topK: number) => Promise<CodebaseSearchHit[]>,
): ToolDefinition {
  return {
    name: "codebase_search",
    description:
      "Semantic search over the indexed workspace: finds code by meaning, not exact text. Use for \"where is X handled?\" style questions; use grep for exact strings.",
    tier: "read",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language description of what to find." },
        top_k: { type: "number", description: "Number of results (default 8, max 20)." },
      },
      required: ["query"],
    },
    summarize: (args) => String(args.query ?? "").slice(0, 100),
    async execute(args): Promise<string> {
      const query = asString(args.query, "query");
      const topK = Math.min(Math.max(1, Number(args.top_k) || 8), 20);
      const hits = await search(query, topK);
      if (hits.length === 0) return "No results. The index may still be building — try grep for exact strings.";
      return hits
        .map(
          (hit, i) =>
            `${i + 1}. ${hit.path}:${hit.startLine}-${hit.endLine} (score ${hit.score.toFixed(3)})\n${hit.preview}`,
        )
        .join("\n\n");
    },
  };
}
