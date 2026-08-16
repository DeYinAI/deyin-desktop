import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { mcpConfigFiles } from "./paths.js";

/**
 * MCP server configuration discovery. Cursor-compatible mcp.json:
 *
 * {
 *   "mcpServers": {
 *     "files":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"] },
 *     "remote": { "url": "https://mcp.example.com/sse", "headers": { "authorization": "Bearer ${env:TOKEN}" } }
 *   }
 * }
 *
 * `${env:NAME}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${userHome}`
 * and `${/}` are interpolated in command/args/env/url/headers.
 */

export interface McpServerDefinition {
  name: string;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  source: string;
  path?: string;
}

interface RawServer {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

interface McpFile {
  mcpServers?: Record<string, RawServer>;
}

export interface InterpolationContext {
  workspaceFolder?: string | null;
  env?: Record<string, string>;
  userHome?: string;
  pluginDir?: string;
  /**
   * The user explicitly trusted this workspace (VS Code-style). Untrusted
   * workspace mcp.json files interpolate only allowlisted env vars, so a
   * cloned repo cannot exfiltrate tokens via ${env:...} in commands/headers.
   */
  trustedWorkspace?: boolean;
}

export function interpolate(value: string, ctx: InterpolationContext): string {
  const home = ctx.userHome ?? homedir();
  const env = ctx.env ?? process.env;
  return value
    .replaceAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "")
    .replaceAll("${workspaceFolder}", ctx.workspaceFolder ?? "")
    .replaceAll("${workspaceFolderBasename}", (ctx.workspaceFolder ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "")
    .replaceAll("${userHome}", home)
    .replaceAll("${pluginDir}", ctx.pluginDir ?? "")
    .replaceAll("${pathSeparator}", process.platform === "win32" ? "\\" : "/")
    .replaceAll("${/}", process.platform === "win32" ? "\\" : "/");
}

/**
 * Env vars a workspace (cloned-repo) mcp.json may interpolate. Anything else —
 * tokens, cloud creds — stays invisible to untrusted config files; user-level
 * and module configs keep full access.
 */
const WORKSPACE_ENV_ALLOWLIST =
  /^(PATH|HOME|USER|USERNAME|USERPROFILE|SHELL|LANG|LC_[A-Z_]+|TMPDIR|TEMP|TMP|APPDATA|LOCALAPPDATA|ProgramFiles|ProgramFiles\(x86\)|ProgramData|SystemRoot|COMSPEC|PROCESSOR_ARCHITECTURE)$/;

function interpolationEnv(source: string, ctx: InterpolationContext): Record<string, string> {
  const explicit = ctx.env ?? {};
  if (source !== "workspace" || ctx.trustedWorkspace === true) {
    const full: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) full[key] = value;
    }
    return { ...full, ...explicit };
  }
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (WORKSPACE_ENV_ALLOWLIST.test(key) || key.startsWith("DEYIN_") || key.startsWith("MCP_")) {
      safe[key] = value;
    }
  }
  return { ...safe, ...explicit };
}

function normalizeServer(name: string, raw: RawServer, source: string, path: string, ctx: InterpolationContext): McpServerDefinition | null {
  // Both branches interpolate with a source-scoped env (workspace configs see
  // the allowlist only). Values the file itself declares in `env` are their own
  // strings — they apply AFTER interpolation of their ${...} references.
  const scoped: InterpolationContext = { ...ctx, env: interpolationEnv(source, ctx) };
  const apply = (v: string) => interpolate(v, scoped);
  // Remote configs may interpolate vars the file itself declares in `env`.
  const remoteCtx: InterpolationContext = { ...scoped, env: { ...scoped.env, ...(raw.env ?? {}) } };
  const applyRecord = (record?: Record<string, string>) =>
    record ? Object.fromEntries(Object.entries(record).map(([k, v]) => [k, apply(v)])) : undefined;

  if (raw.url) {
    const transport = raw.type === "sse" || raw.url.endsWith("/sse") ? "sse" : "http";
    const localCtx: InterpolationContext = remoteCtx;
    const applyRemote = (v: string) => interpolate(v, localCtx);
    const applyRemoteRecord = (record?: Record<string, string>) =>
      record ? Object.fromEntries(Object.entries(record).map(([k, v]) => [k, applyRemote(v)])) : undefined;
    return {
      name,
      transport,
      url: applyRemote(raw.url),
      headers: applyRemoteRecord(raw.headers),
      enabled: raw.enabled !== false,
      source,
      path,
    };
  }
  if (raw.command) {
    return {
      name,
      transport: "stdio",
      command: apply(raw.command),
      args: (raw.args ?? []).map(apply),
      env: applyRecord(raw.env),
      enabled: raw.enabled !== false,
      source,
      path,
    };
  }
  return null;
}

/** Load and merge every mcp.json; first definition of a name wins (workspace > user). */
export async function loadMcpServers(cwd: string | null, ctx: InterpolationContext = {}, userDir?: string): Promise<McpServerDefinition[]> {
  const context: InterpolationContext = { workspaceFolder: cwd, ...ctx };
  const byName = new Map<string, McpServerDefinition>();
  for (const file of mcpConfigFiles(cwd, userDir)) {
    let raw: string;
    try {
      raw = await readFile(file.path, "utf8");
    } catch {
      continue;
    }
    let parsed: McpFile;
    try {
      parsed = JSON.parse(raw) as McpFile;
    } catch {
      continue;
    }
    for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
      if (byName.has(name)) continue;
      const normalized = normalizeServer(name, server ?? {}, file.source, file.path, context);
      if (normalized) byName.set(name, normalized);
    }
  }
  return [...byName.values()];
}
