import {
  UnauthorizedError,
  type McpServerDefinition,
  type OAuthClientProvider,
  type ToolDefinition,
} from "@deyin/agent-core";
import type { McpModuleManifest } from "@deyin/contract";
import type { McpModuleService } from "./mcp-modules.js";
import type { McpOAuthService } from "./mcp-oauth.js";

export interface McpOAuthTarget {
  moduleId: string;
  serverName: string;
  displayName: string;
}

export interface McpAuthBridge {
  getProvider(serverName: string): OAuthClientProvider | undefined;
  oauthTargetFor(def: McpServerDefinition): McpOAuthTarget | null;
  findModule(server: string): McpOAuthTarget | null;
  isAuthenticated(moduleId: string): boolean;
  listModules(): McpModuleManifest[];
}

function moduleUsesOAuth(mod: McpModuleManifest): boolean {
  return mod.authMode === "oauth" || mod.usesNativeOAuth === true;
}

export function createMcpAuthBridge(modules: McpModuleService, oauth: McpOAuthService): McpAuthBridge {
  return {
    getProvider: (name) => oauth.getProvider(name),
    oauthTargetFor(def) {
      if (!def.source.startsWith("module:")) return null;
      const moduleId = def.source.slice("module:".length);
      const mod = modules.get(moduleId);
      if (!mod || !moduleUsesOAuth(mod)) return null;
      return { moduleId, serverName: def.name, displayName: mod.name || def.name };
    },
    findModule(server) {
      const q = server.trim().toLowerCase();
      if (!q) return null;
      for (const mod of modules.list()) {
        if (!moduleUsesOAuth(mod)) continue;
        if (mod.id.toLowerCase() === q || mod.name.toLowerCase() === q) {
          return { moduleId: mod.id, serverName: mod.id, displayName: mod.name };
        }
      }
      return null;
    },
    isAuthenticated: (id) => oauth.isAuthenticated(id),
    listModules: () => modules.list(),
  };
}

/** Module id for OAuth-backed MCP defs (`source: "module:<id>"`); undefined otherwise. */
export function resolveMcpModuleId(def: McpServerDefinition): string | undefined {
  if (!def.source.startsWith("module:")) return undefined;
  return def.source.slice("module:".length);
}

export function isMcpUnauthorized(err: unknown): boolean {
  return err instanceof UnauthorizedError;
}

export function createMcpAuthenticateTool(
  bridge: McpAuthBridge,
  onNeeded: (target: McpOAuthTarget) => void,
): ToolDefinition {
  return {
    name: "mcp_authenticate",
    description:
      "Request OAuth sign-in for an installed MCP integration (e.g. stripe, cloudflare-observability). Shows an Authenticate button in chat.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Module id or display name of the MCP integration." },
      },
      required: ["server"],
    },
    tier: "read",
    summarize: (args) => `authenticate MCP ${String(args.server ?? "")}`,
    async execute(args): Promise<string> {
      const server = String(args.server ?? "").trim();
      if (!server) return "ERROR: server is required.";
      const target = bridge.findModule(server);
      if (!target) {
        return `ERROR: No OAuth MCP module matching "${server}" is installed. Install it from Settings → MCP → Catalog.`;
      }
      if (bridge.isAuthenticated(target.moduleId)) {
        return `${target.displayName} is already connected.`;
      }
      onNeeded(target);
      return `Showing sign-in for ${target.displayName}. Click Authenticate in the chat card to open your browser and approve access.`;
    },
  };
}
