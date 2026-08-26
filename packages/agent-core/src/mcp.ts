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

/** Hard cap on establishing a server connection + listing tools. */
const MCP_CONNECT_TIMEOUT_MS = 20_000;
/** Default per-call timeout for MCP tool invocations (progress resets it). */
const MCP_CALL_TIMEOUT_MS = 120_000;
/** Strictest provider limit for function names (OpenAI). */
const MAX_TOOL_NAME_LENGTH = 64;

/** Race a promise against a timer; run `onTimeout` before rejecting. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Normalize an MCP `inputSchema` into the object schema providers expect.
 *
 * Many servers publish a schema without an explicit `"type": "object"` (just
 * `properties` / `required`). Treating those as "no schema" silently stripped
 * every parameter, so the model called the tool with an empty argument object.
 * Anything object-shaped is accepted and the missing `type` is filled in;
 * `$schema` is dropped because strict function-schema validators reject it.
 */
export function normalizeMcpSchema(inputSchema: unknown): ToolSchema {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return { type: "object", properties: {} };
  }
  const raw = inputSchema as Record<string, unknown>;
  // A non-object schema (string/array/…) has no place in a function signature.
  if (raw.type !== undefined && raw.type !== "object") return { type: "object", properties: {} };
  const { $schema: _schema, ...rest } = raw;
  const properties =
    rest.properties && typeof rest.properties === "object" && !Array.isArray(rest.properties)
      ? (rest.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(rest.required) ? rest.required.filter((r): r is string => typeof r === "string") : undefined;
  return {
    ...rest,
    type: "object",
    properties,
    ...(required ? { required } : {}),
  };
}

/**
 * Function names on the wire must match `^[a-zA-Z0-9_-]{1,64}$` (OpenAI's rule,
 * the strictest of the providers we speak to). MCP server names come from user
 * config and tool names from third-party servers, so `mcp__<server>__<tool>` can
 * easily contain spaces/dots or run past 64 characters — and one bad name makes
 * the provider reject the *whole* request, which reads as "tools don't work at
 * all". Sanitize the qualified name, and keep it unique with a short digest when
 * truncation or substitution could collide.
 */
export function qualifyMcpToolName(serverName: string, toolName: string, taken?: Set<string>): string {
  const raw = `mcp__${serverName}__${toolName}`;
  let name = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (name.length > MAX_TOOL_NAME_LENGTH || name !== raw) {
    const digest = shortDigest(raw);
    if (name.length > MAX_TOOL_NAME_LENGTH) {
      name = `${name.slice(0, MAX_TOOL_NAME_LENGTH - digest.length - 1)}_${digest}`;
    } else if (taken?.has(name)) {
      name = `${name.slice(0, MAX_TOOL_NAME_LENGTH - digest.length - 1)}_${digest}`;
    }
  }
  // Last resort: a name that collides anyway still has to be unique.
  let unique = name;
  let n = 2;
  while (taken?.has(unique)) {
    const suffix = `_${n++}`;
    unique = `${name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
  }
  return unique;
}

/** Stable 6-char digest used to disambiguate sanitized/truncated tool names. */
function shortDigest(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, "0").slice(0, 6);
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
  // A stdio server that spawns but never answers must not hang agent startup.
  await withTimeout(client.connect(transport), MCP_CONNECT_TIMEOUT_MS, () => void client.close().catch(() => undefined));
  const { tools } = await withTimeout(
    client.listTools(),
    MCP_CONNECT_TIMEOUT_MS,
    () => void client.close().catch(() => undefined),
  );
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
  const taken = new Set(registry.names());
  for (const tool of tools) {
    const qualified = qualifyMcpToolName(serverName, tool.name, taken);
    taken.add(qualified);
    names.push(qualified);
    const def: ToolDefinition = {
      name: qualified,
      description: tool.description ?? `${tool.name} (MCP tool from ${serverName})`,
      parameters: normalizeMcpSchema(tool.inputSchema),
      tier: "execute",
      summarize: () => qualified,
      async execute(args, ctx): Promise<string> {
        const result = await client.callTool({ name: tool.name, arguments: args }, {
          timeout: MCP_CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
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

/* MCP connection pool ------------------------------------------------------- */

/** Identity of a server definition: any change here forces a reconnect. */
function definitionFingerprint(def: McpServerDefinition): string {
  return JSON.stringify([
    def.transport,
    def.command ?? null,
    def.args ?? [],
    def.env ?? null,
    def.url ?? null,
    def.headers ?? null,
  ]);
}

interface PooledServer {
  fingerprint: string;
  client: Client;
  tools: { name: string; description?: string; inputSchema?: unknown }[];
  /** Set once the transport reports it is gone; the next acquire reconnects. */
  closed: boolean;
}

/**
 * Long-lived MCP connections shared by every run in a host.
 *
 * Connecting per message respawned every stdio server (and redid OAuth discovery
 * for HTTP ones) on each turn, which showed up as a multi-second stall before the
 * model saw any tool. The pool keeps a server alive until its definition changes,
 * it drops off the enabled list, or its transport closes; a dead child is noticed
 * through `client.onclose` and reconnected on the next acquire.
 *
 * Servers that fail to connect are reported through `onError` and skipped — they
 * never break a run — and are retried on the next acquire.
 */
export class McpConnectionPool {
  private readonly servers = new Map<string, PooledServer>();
  /** In-flight connects, so two concurrent runs never spawn one server twice. */
  private readonly pending = new Map<string, Promise<PooledServer | null>>();
  private disposed = false;

  /**
   * Ensure every enabled definition is connected, drop the ones that are gone,
   * and register the live tool set into `registry`.
   */
  async acquire(
    defs: McpServerDefinition[],
    registry: ToolRegistry,
    opts: {
      onError?: (server: string, error: unknown) => void;
      getAuthProvider?: (serverName: string) => OAuthClientProvider | undefined;
    } = {},
  ): Promise<McpConnection[]> {
    if (this.disposed) throw new Error("McpConnectionPool has been disposed.");
    const wanted = defs.filter((def) => def.enabled);
    const wantedNames = new Set(wanted.map((d) => d.name));

    // Servers no longer enabled (or removed from config) stop costing a process.
    for (const [name, server] of [...this.servers]) {
      if (!wantedNames.has(name)) {
        this.servers.delete(name);
        void server.client.close().catch(() => undefined);
      }
    }

    const connections: McpConnection[] = [];
    for (const def of wanted) {
      const server = await this.ensure(def, opts);
      if (!server) continue;
      const toolNames = registerServerTools(registry, def.name, server.client, server.tools);
      connections.push({
        name: def.name,
        toolCount: server.tools.length,
        toolNames,
        // Pooled connections outlive the run: closing is the pool's job.
        close: async () => undefined,
      });
    }
    return connections;
  }

  private async ensure(
    def: McpServerDefinition,
    opts: {
      onError?: (server: string, error: unknown) => void;
      getAuthProvider?: (serverName: string) => OAuthClientProvider | undefined;
    },
  ): Promise<PooledServer | null> {
    const fingerprint = definitionFingerprint(def);
    const live = this.servers.get(def.name);
    if (live && !live.closed && live.fingerprint === fingerprint) return live;
    if (live) {
      this.servers.delete(def.name);
      void live.client.close().catch(() => undefined);
    }

    const inFlight = this.pending.get(def.name);
    if (inFlight) return inFlight;

    const attempt = (async (): Promise<PooledServer | null> => {
      try {
        const { client, tools } = await connectMcpServer(def, {
          authProvider: opts.getAuthProvider?.(def.name),
        });
        const server: PooledServer = { fingerprint, client, tools, closed: false };
        // A crashed stdio child or a dropped socket must not look connected.
        client.onclose = () => {
          server.closed = true;
          if (this.servers.get(def.name) === server) this.servers.delete(def.name);
        };
        if (this.disposed) {
          void client.close().catch(() => undefined);
          return null;
        }
        this.servers.set(def.name, server);
        return server;
      } catch (err) {
        opts.onError?.(def.name, err);
        return null;
      } finally {
        this.pending.delete(def.name);
      }
    })();
    this.pending.set(def.name, attempt);
    return attempt;
  }

  /** Names of the servers currently connected (diagnostics/tests). */
  connectedServers(): string[] {
    return [...this.servers.keys()];
  }

  /** Drop one server so the next acquire reconnects it (e.g. after re-auth). */
  async invalidate(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) return;
    this.servers.delete(name);
    await server.client.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    const servers = [...this.servers.values()];
    this.servers.clear();
    await Promise.allSettled(servers.map((s) => s.client.close()));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.closeAll();
  }
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
