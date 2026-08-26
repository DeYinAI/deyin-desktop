import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { McpConnectionPool, connectMcpServers, normalizeMcpSchema, qualifyMcpToolName } from "../src/mcp.js";
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

test("qualified MCP tool names stay inside the provider's function-name rules", () => {
  // A server name from user config can hold anything; one bad name makes the
  // provider reject the whole request, so every tool call fails at once.
  const spaced = qualifyMcpToolName("GitHub MCP", "create.issue");
  assert.match(spaced, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.ok(spaced.startsWith("mcp__GitHub_MCP__create_issue"));

  const long = qualifyMcpToolName("a".repeat(40), "b".repeat(40));
  assert.match(long, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(long.length, 64);

  // Names that only differ past the truncation point must not collide.
  const taken = new Set<string>();
  const first = qualifyMcpToolName("s".repeat(40), `${"t".repeat(40)}_one`, taken);
  taken.add(first);
  const second = qualifyMcpToolName("s".repeat(40), `${"t".repeat(40)}_two`, taken);
  assert.notEqual(first, second);
  assert.match(second, /^[a-zA-Z0-9_-]{1,64}$/);
});

test("MCP input schemas without an explicit object type keep their parameters", () => {
  // Servers commonly publish { properties, required } with no "type".
  const schema = normalizeMcpSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    properties: { path: { type: "string" } },
    required: ["path"],
  });
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.properties, { path: { type: "string" } });
  assert.deepEqual(schema.required, ["path"]);
  // $schema is dropped: strict function-schema validators reject it.
  assert.equal("$schema" in schema, false);

  // Genuinely unusable schemas still fall back to an empty object schema.
  assert.deepEqual(normalizeMcpSchema({ type: "string" }), { type: "object", properties: {} });
  assert.deepEqual(normalizeMcpSchema(undefined), { type: "object", properties: {} });
});

test("the pool keeps one connection alive across runs and drops disabled servers", async () => {
  const pool = new McpConnectionPool();
  const def = {
    name: "echo",
    transport: "stdio" as const,
    command: process.execPath,
    args: [SERVER_PATH],
    enabled: true,
    source: "config",
  };
  try {
    // Two runs, two fresh registries — but only one server process.
    const first = new ToolRegistry();
    const a = await pool.acquire([def], first);
    assert.deepEqual(a.map((c) => c.name), ["echo"]);
    assert.ok(first.get("mcp__echo__ping"), "run 1 sees the tool");

    const second = new ToolRegistry();
    await pool.acquire([def], second);
    assert.deepEqual(pool.connectedServers(), ["echo"]);
    const tool = second.get("mcp__echo__ping");
    assert.ok(tool, "run 2 sees the tool without reconnecting");
    assert.equal(await tool!.execute({}, { cwd: process.cwd(), todos: [] }), "pong");

    // A run's `close()` must not tear down a pooled server the next run needs.
    await Promise.all(a.map((c) => c.close()));
    assert.deepEqual(pool.connectedServers(), ["echo"]);

    // Disabling it drops the process.
    const third = new ToolRegistry();
    await pool.acquire([{ ...def, enabled: false }], third);
    assert.deepEqual(pool.connectedServers(), []);
    assert.equal(third.get("mcp__echo__ping"), undefined);
  } finally {
    await pool.dispose();
  }
});

test("the pool reconnects when a server definition changes", async () => {
  const pool = new McpConnectionPool();
  const def = {
    name: "echo",
    transport: "stdio" as const,
    command: process.execPath,
    args: [SERVER_PATH],
    enabled: true,
    source: "config",
  };
  try {
    await pool.acquire([def], new ToolRegistry());
    assert.deepEqual(pool.connectedServers(), ["echo"]);

    // Same name, different command line: the old process must not be reused.
    const errors: string[] = [];
    await pool.acquire([{ ...def, args: [SERVER_PATH, "--changed"] }], new ToolRegistry(), {
      onError: (name) => errors.push(name),
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(pool.connectedServers(), ["echo"]);
  } finally {
    await pool.dispose();
  }
});

test("a server that cannot start is reported and retried, never fatal", async () => {
  const pool = new McpConnectionPool();
  const errors: string[] = [];
  try {
    const registry = new ToolRegistry();
    const conns = await pool.acquire(
      [{ name: "broken", transport: "stdio", command: "/nonexistent/definitely-not-a-binary", enabled: true, source: "config" }],
      registry,
      { onError: (name) => errors.push(name) },
    );
    assert.deepEqual(conns, []);
    assert.deepEqual(errors, ["broken"]);
    assert.deepEqual(pool.connectedServers(), []);
    assert.equal(registry.list().length, 0);
  } finally {
    await pool.dispose();
  }
});
