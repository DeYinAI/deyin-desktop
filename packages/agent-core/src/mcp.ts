import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "./config.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { ToolDefinition, ToolSchema } from "./types.js";

export interface McpConnection {
  name: string;
  toolCount: number;
  close(): Promise<void>;
}

function toSchema(inputSchema: unknown): ToolSchema {
  if (inputSchema && typeof inputSchema === "object" && (inputSchema as { type?: string }).type === "object") {
    return inputSchema as ToolSchema;
  }
  return { type: "object", properties: {} };
}

function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content);
  return content
    .map((part) => {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        return (part as { text?: string }).text ?? "";
      }
      return JSON.stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Connect the configured MCP stdio servers and register their tools into the shared
 * registry as `mcp__<server>__<tool>` (execute tier, so they go through permissions).
 * Servers that fail to start are skipped with a warning; they never break the run.
 */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  registry: ToolRegistry,
  opts: { onError?: (server: string, error: unknown) => void } = {},
): Promise<McpConnection[]> {
  const connections: McpConnection[] = [];

  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.enabled === false || !cfg.command) continue;
    try {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
        stderr: "ignore",
      });
      const client = new Client({ name: "deyin-cli", version: "0.1.0" }, { capabilities: {} });
      await client.connect(transport);

      const { tools } = await client.listTools();
      for (const tool of tools) {
        const qualified = `mcp__${name}__${tool.name}`;
        const def: ToolDefinition = {
          name: qualified,
          description: tool.description ?? `${tool.name} (MCP tool from ${name})`,
          parameters: toSchema(tool.inputSchema),
          tier: "execute",
          summarize: () => qualified,
          async execute(args): Promise<string> {
            const result = await client.callTool({ name: tool.name, arguments: args });
            const text = contentToText(result.content);
            return result.isError ? `ERROR: ${text || "MCP tool reported an error."}` : text || "(no output)";
          },
        };
        registry.register(def);
      }

      connections.push({
        name,
        toolCount: tools.length,
        close: () => client.close(),
      });
    } catch (err) {
      opts.onError?.(name, err);
    }
  }

  return connections;
}
