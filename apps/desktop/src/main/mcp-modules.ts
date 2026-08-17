import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mcpModulesRoot, userDeyinDir } from "@deyin/agent-core";
import type { McpCatalogEntry, McpModuleManifest, McpServerInput } from "@deyin/contract";

export function normalizeMcpName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

export function assertModuleId(id: string): string {
  if (/[/\\]|\.\./.test(id)) {
    throw new Error(`Invalid module id: ${id}`);
  }
  const normalized = normalizeMcpName(id);
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error(`Invalid module id: ${id}`);
  }
  return normalized;
}

function serverConfigFromInput(input: McpServerInput): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (input.transport === "stdio") {
    if (!input.command?.trim()) throw new Error("A command is required for stdio servers.");
    entry.command = input.command.trim();
    if (input.args?.length) entry.args = input.args;
    if (input.env && Object.keys(input.env).length > 0) entry.env = input.env;
  } else {
    if (!input.url?.trim()) throw new Error("A URL is required for remote servers.");
    entry.url = input.url.trim();
    entry.type = input.transport;
    if (input.headers && Object.keys(input.headers).length > 0) entry.headers = input.headers;
    if (input.env && Object.keys(input.env).length > 0) entry.env = input.env;
  }
  return entry;
}

function rawServerToInput(name: string, raw: Record<string, unknown>): McpServerInput | null {
  if (typeof raw.url === "string" && raw.url.trim()) {
    const transport =
      raw.type === "sse" || raw.url.endsWith("/sse") ? ("sse" as const) : ("http" as const);
    return {
      name,
      transport,
      url: raw.url,
      headers:
        raw.headers && typeof raw.headers === "object"
          ? (raw.headers as Record<string, string>)
          : undefined,
      env: raw.env && typeof raw.env === "object" ? (raw.env as Record<string, string>) : undefined,
    };
  }
  if (typeof raw.command === "string" && raw.command.trim()) {
    return {
      name,
      transport: "stdio",
      command: raw.command,
      args: Array.isArray(raw.args) ? (raw.args as string[]) : undefined,
      env: raw.env && typeof raw.env === "object" ? (raw.env as Record<string, string>) : undefined,
    };
  }
  return null;
}

/** Manages per-server MCP modules under ~/.deyin/mcp-modules/<id>/. */
export class McpModuleService {
  constructor(
    private readonly userDir = homedir(),
    private readonly onChanged?: () => void,
  ) {}

  private root(): string {
    return mcpModulesRoot(this.userDir);
  }

  private assertInsideRoot(resolved: string): string {
    const root = resolve(this.root());
    const abs = resolve(resolved);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error("Module path escapes root");
    }
    return abs;
  }

  moduleDir(id: string): string {
    const safe = assertModuleId(id);
    return this.assertInsideRoot(join(this.root(), safe));
  }

  list(): McpModuleManifest[] {
    const root = this.root();
    if (!existsSync(root)) return [];
    const out: McpModuleManifest[] = [];
    for (const id of readdirSync(root)) {
      const manifestPath = join(root, id, "module.json");
      if (!existsSync(manifestPath)) continue;
      try {
        out.push(JSON.parse(readFileSync(manifestPath, "utf8")) as McpModuleManifest);
      } catch {
        // skip malformed module
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): McpModuleManifest | undefined {
    const dir = this.moduleDir(id);
    const manifestPath = join(dir, "module.json");
    if (!existsSync(manifestPath)) return undefined;
    try {
      return JSON.parse(readFileSync(manifestPath, "utf8")) as McpModuleManifest;
    } catch {
      return undefined;
    }
  }

  has(id: string): boolean {
    const dir = this.moduleDir(id);
    return existsSync(join(dir, "module.json"));
  }

  install(
    input: McpServerInput,
    meta: {
      name: string;
      source: McpModuleManifest["source"];
      vendor?: string;
      category?: McpModuleManifest["category"];
      catalogEntryId?: string;
      authMode?: McpModuleManifest["authMode"];
      usesNativeOAuth?: boolean;
      docsUrl?: string;
    },
  ): string {
    const id = assertModuleId(input.name);
    const dir = this.moduleDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const manifest: McpModuleManifest = {
      id,
      name: meta.name,
      vendor: meta.vendor,
      category: meta.category,
      version: 1,
      installedAt: new Date().toISOString(),
      source: meta.source,
      catalogEntryId: meta.catalogEntryId,
      authMode: meta.authMode,
      usesNativeOAuth: meta.usesNativeOAuth,
      docsUrl: meta.docsUrl,
    };
    writeFileSync(join(dir, "module.json"), JSON.stringify(manifest, null, 2), { encoding: "utf8", mode: 0o600 });
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: { [id]: serverConfigFromInput({ ...input, name: id }) } }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
    this.onChanged?.();
    return id;
  }

  installCustom(input: McpServerInput): string {
    return this.install(input, { name: input.name, source: "custom" });
  }

  installFromCatalog(entry: McpCatalogEntry, secrets: Record<string, string>, useOAuth: boolean): string {
    const oauthInstall = entry.auth === "oauth" || (entry.auth === "token-or-oauth" && useOAuth);

    if (!oauthInstall) {
      for (const spec of entry.secrets ?? []) {
        if (spec.required && !secrets[spec.envKey]?.trim()) {
          throw new Error(`${spec.label} is required.`);
        }
      }
    }

    const env = !oauthInstall && Object.keys(secrets).length > 0 ? secrets : undefined;

    if (entry.transport === "stdio" || (!entry.url && entry.command)) {
      return this.install(
        {
          name: entry.id,
          transport: "stdio",
          command: entry.command,
          args: entry.args,
          env,
        },
        {
          name: entry.name,
          source: "catalog",
          vendor: entry.vendor,
          category: entry.category,
          catalogEntryId: entry.id,
          authMode: entry.auth,
          usesNativeOAuth: oauthInstall,
          docsUrl: entry.docsUrl,
        },
      );
    }

    if (!entry.url?.trim()) throw new Error(`No URL configured for ${entry.name}.`);

    return this.install(
      {
        name: entry.id,
        transport: entry.transport,
        url: entry.url,
        headers: oauthInstall ? undefined : entry.headers,
        env,
      },
      {
        name: entry.name,
        source: "catalog",
        vendor: entry.vendor,
        category: entry.category,
        catalogEntryId: entry.id,
        authMode: entry.auth,
        usesNativeOAuth: oauthInstall,
        docsUrl: entry.docsUrl,
      },
    );
  }

  uninstall(id: string): boolean {
    const dir = this.moduleDir(assertModuleId(id));
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    this.onChanged?.();
    return true;
  }

  /** Move legacy ~/.deyin/mcp.json entries into per-module dirs (once). */
  migrateFlatMcp(): number {
    const flatFile = join(userDeyinDir(this.userDir), "mcp.json");
    if (!existsSync(flatFile)) return 0;
    let parsed: { mcpServers?: Record<string, Record<string, unknown>> };
    try {
      parsed = JSON.parse(readFileSync(flatFile, "utf8")) as typeof parsed;
    } catch {
      return 0;
    }
    const servers = parsed.mcpServers ?? {};
    const names = Object.keys(servers);
    if (names.length === 0) return 0;

    let migrated = 0;
    for (const [name, raw] of Object.entries(servers)) {
      const input = rawServerToInput(name, raw);
      if (!input) continue;
      let id: string;
      try {
        id = assertModuleId(name);
      } catch {
        continue;
      }
      if (this.has(id)) continue;
      this.install(input, { name, source: "custom" });
      migrated += 1;
    }

    if (migrated > 0) {
      try {
        renameSync(flatFile, `${flatFile}.bak`);
      } catch {
        writeFileSync(flatFile, JSON.stringify({ mcpServers: {} }, null, 2), { encoding: "utf8", mode: 0o600 });
      }
    }
    return migrated;
  }

}
