// Minimal MCP stdio server used by mcp.test.ts (spawned as a child process).
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new McpServer({ name: "echo", version: "1.0.0" });

server.registerTool("ping", { description: "Replies with pong" }, async () => ({
  content: [{ type: "text", text: "pong" }],
}));

await server.connect(new StdioServerTransport());
