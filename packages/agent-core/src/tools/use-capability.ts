import type { ToolDefinition } from "../types.js";
import type { ToolContext } from "../types.js";
import { asString } from "./util.js";

export interface UseCapabilityOptions {
  /** Resolve MCP tool by server and tool name. */
  invokeMcp: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;
  /** Known MCP servers for the capability ledger. */
  listServers?: () => string[];
}

const capabilityLedger = new WeakMap<ToolContext, Set<string>>();

function ledgerKey(server: string, tool: string): string {
  return `${server}::${tool}`;
}

/**
 * MCP proxy tool: delegates to MCP without exposing full schemas to the planner.
 * Preserves planner prefix cache stability.
 */
export function createUseCapabilityTool(opts: UseCapabilityOptions): ToolDefinition {
  return {
    name: "use_capability",
    description:
      "Invoke an MCP capability by server and tool name without loading full MCP schemas into context. " +
      "Use for targeted research (docs lookup, issue search, etc.). Read-only from the planner's perspective.",
    tier: "read",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server name." },
        tool: { type: "string", description: "Tool name on that server (without mcp__ prefix)." },
        arguments: {
          type: "object",
          description: "JSON arguments for the MCP tool.",
          additionalProperties: true,
        },
      },
      required: ["server", "tool"],
    },
    summarize: (args) => `use_capability ${String(args.server ?? "?")}/${String(args.tool ?? "?")}`,
    async execute(args, ctx): Promise<string> {
      const server = asString(args.server, "server");
      const tool = asString(args.tool, "tool");
      const invokeArgs =
        typeof args.arguments === "object" && args.arguments !== null && !Array.isArray(args.arguments)
          ? (args.arguments as Record<string, unknown>)
          : {};

      let ledger = capabilityLedger.get(ctx);
      if (!ledger) {
        ledger = new Set();
        capabilityLedger.set(ctx, ledger);
      }
      const key = ledgerKey(server, tool);
      if (ledger.has(key)) {
        return `Capability ${server}/${tool} was already invoked this turn; reuse prior results from the transcript.`;
      }
      ledger.add(key);

      try {
        const result = await opts.invokeMcp(server, tool, invokeArgs);
        return result;
      } catch (err) {
        return `ERROR: MCP capability ${server}/${tool} failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
