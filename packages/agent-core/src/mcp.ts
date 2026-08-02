import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import type { McpServerDefinition } from "./capabilities/mcp-config.js";
import type { McpServerConfig } from "./config.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { ToolDefinition, ToolSchema } from "./types.js";

export type { OAuthClientProvider };
export { UnauthorizedError } from "@modelcontextprotocol/client";

export interface McpConnection {
  name: string;
  toolCount: number;
  toolNames: string[];
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

function transportFor(def: McpServerDefinition, authProvider?: OAuthClientProvider) {
  if (def.transport === "stdio") {
    if (!def.command) throw new Error(`MCP server ${def.name} has no command.`);
    return new StdioClientTransport({
      command: def.command,
      args: def.args ?? [],
      env: { ...getDefaultEnvironment(), ...(def.env ?? {}) },
      stderr: "ignore",
    });
  }
  if (!def.url) throw new Error(`MCP server ${def.name} has no url.`);
  const url = new URL(def.url);
  const requestInit = def.headers ? { headers: def.headers } : undefined;
  if (def.transport === "sse") return new SSEClientTransport(url, { requestInit, authProvider });
  return new StreamableHTTPClientTransport(url, { requestInit, authProvider });
}

/** Connect one MCP server and return the live client plus its tool list. */
export async function connectMcpServer(
  def: McpServerDefinition,
  opts: { authProvider?: OAuthClientProvider } = {},
): Promise<{
  client: Client;
  tools: { name: string; description?: string; inputSchema?: unknown }[];
  close(): Promise<void>;
}> {
  const transport = transportFor(def, opts.authProvider);
  const client = new Client({ name: "deyin", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, tools, close: () => client.close() };
}

/** Register the tools of a connected MCP server as `mcp__<server>__<tool>`. */
function registerServerTools(
  registry: ToolRegistry,
  serverName: string,
  client: Client,
  tools: { name: string; description?: string; inputSchema?: unknown }[],
): string[] {
  const names: string[] = [];
  for (const tool of tools) {
    const qualified = `mcp__${serverName}__${tool.name}`;
    names.push(qualified);
    const def: ToolDefinition = {
      name: qualified,
      description: tool.description ?? `${tool.name} (MCP tool from ${serverName})`,
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
  return names;
}

/**
 * Connect a set of MCP server definitions (stdio, SSE or Streamable HTTP) and
 * register their tools into the shared registry as `mcp__<server>__<tool>`
 * (execute tier, so they go through permissions). Servers that fail to start
 * are skipped with a warning; they never break the run.
 */
export async function connectMcpDefinitions(
  defs: McpServerDefinition[],
  registry: ToolRegistry,
  opts: {
    onError?: (server: string, error: unknown) => void;
    getAuthProvider?: (serverName: string) => OAuthClientProvider | undefined;
  } = {},
): Promise<McpConnection[]> {
  const connections: McpConnection[] = [];
  for (const def of defs) {
    if (!def.enabled) continue;
    try {
      const { client, tools, close } = await connectMcpServer(def, {
        authProvider: opts.getAuthProvider?.(def.name),
      });
      const toolNames = registerServerTools(registry, def.name, client, tools);
      connections.push({ name: def.name, toolCount: tools.length, toolNames, close });
    } catch (err) {
      opts.onError?.(def.name, err);
    }
  }
  return connections;
}

/**
 * Back-compat entry point for the CLI config format (`mcpServers` in
 * deyin.json / ~/.deyin/config.json — stdio only).
 */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  registry: ToolRegistry,
  opts: { onError?: (server: string, error: unknown) => void } = {},
): Promise<McpConnection[]> {
  const defs: McpServerDefinition[] = Object.entries(servers).map(([name, cfg]) => ({
    name,
    transport: "stdio",
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
    enabled: cfg.enabled !== false && Boolean(cfg.command),
    source: "config",
  }));
  return connectMcpDefinitions(defs, registry, opts);
}
