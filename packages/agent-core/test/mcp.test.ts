import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { connectMcpServers } from "../src/mcp.js";
import { ToolRegistry } from "../src/tools/registry.js";

const SERVER_PATH = fileURLToPath(new URL("./helpers/mcp-echo-server.mjs", import.meta.url));

test("connects a stdio MCP server and exposes its tools through the registry", async () => {
  const registry = new ToolRegistry();
  const connections = await connectMcpServers(
    { echo: { command: process.execPath, args: [SERVER_PATH] } },
    registry,
  );
  try {
    assert.equal(connections.length, 1);
    assert.equal(connections[0]?.name, "echo");
    assert.equal(connections[0]?.toolCount, 1);

    const tool = registry.get("mcp__echo__ping");
    assert.ok(tool, "MCP tool must be registered under the qualified name");
    assert.equal(tool!.tier, "execute");
    const result = await tool!.execute({}, { cwd: process.cwd(), todos: [] });
    assert.equal(result, "pong");
  } finally {
    await Promise.allSettled(connections.map((c) => c.close()));
  }
});

test("broken servers are skipped without failing the run", async () => {
  const registry = new ToolRegistry();
  const errors: string[] = [];
  const connections = await connectMcpServers(
    { broken: { command: "/nonexistent/definitely-not-a-binary" } },
    registry,
    { onError: (server) => errors.push(server) },
  );
  assert.equal(connections.length, 0);
  assert.deepEqual(errors, ["broken"]);
  assert.equal(registry.list().length, 0);
});

test("disabled servers are ignored", async () => {
  const registry = new ToolRegistry();
  const connections = await connectMcpServers({ off: { command: "whatever", enabled: false } }, registry);
  assert.equal(connections.length, 0);
});
