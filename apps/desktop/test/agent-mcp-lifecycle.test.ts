import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveCommandInvocation, unknownCommandMessage, UnauthorizedError } from "@deyin/agent-core";
import { McpCatalogService } from "../src/main/mcp-catalog.js";
import {
  createMcpAuthBridge,
  isMcpUnauthorized,
  resolveMcpModuleId,
} from "../src/main/mcp-auth-bridge.js";
import { McpModuleService } from "../src/main/mcp-modules.js";

function tempHome(): string {
  const dir = join("/tmp", `deyin-mcp-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Same resolution path as apps/desktop/src/main/agent.ts before a run starts. */
function resolveDesktopPrompt(
  prompt: string,
  caps: { commands: { name: string; body: string }[]; skills: { name: string; path: string }[] },
): { prompt: string } | { aborted: true; message: string } {
  const resolved = resolveCommandInvocation(prompt, caps);
  if (resolved.kind === "unknown") {
    return { aborted: true, message: unknownCommandMessage(resolved.name, resolved.suggestions) };
  }
  if (resolved.kind === "none") return { prompt };
  return { prompt: resolved.prompt };
}

test("resolveMcpModuleId: module source yields id, other sources do not", () => {
  assert.equal(
    resolveMcpModuleId({
      name: "cloudflare-docs",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
      source: "module:cloudflare-docs",
    }),
    "cloudflare-docs",
  );
  assert.equal(
    resolveMcpModuleId({
      name: "stdio-local",
      transport: "stdio",
      command: "node",
      enabled: true,
      source: "workspace",
    }),
    undefined,
  );
  assert.equal(
    resolveMcpModuleId({
      name: "plugin-server",
      transport: "stdio",
      command: "node",
      enabled: true,
      source: "plugin:toolkit",
    }),
    undefined,
  );
});

test("isMcpUnauthorized gates MCP connect retry on auth-needed flow", () => {
  assert.equal(isMcpUnauthorized(new UnauthorizedError("token expired")), true);
  assert.equal(isMcpUnauthorized(new Error("ECONNREFUSED")), false);
});

test("createMcpAuthBridge resolves oauth target via resolveMcpModuleId source", () => {
  const home = tempHome();
  try {
    const modules = new McpModuleService(home);
    const catalog = new McpCatalogService(modules);
    catalog.install({ entryId: "cloudflare-docs", useOAuth: true });
    const bridge = createMcpAuthBridge(modules, {
      getProvider: (id: string) => ({ moduleId: id }) as never,
      isAuthenticated: () => false,
    } as never);

    const def = {
      name: "cloudflare-docs",
      transport: "http" as const,
      url: "https://docs.mcp.cloudflare.com/mcp",
      enabled: true,
      source: "module:cloudflare-docs",
    };
    assert.equal(resolveMcpModuleId(def), "cloudflare-docs");
    const target = bridge.oauthTargetFor(def);
    assert.ok(target);
    assert.equal(target.moduleId, "cloudflare-docs");
    assert.equal(bridge.isAuthenticated("cloudflare-docs"), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("desktop host: unknown slash command aborts before MCP connect", () => {
  const caps = { commands: [{ name: "commit", body: "Commit $ARGUMENTS" }], skills: [] };
  const outcome = resolveDesktopPrompt("/not-a-command", caps);
  assert.ok("aborted" in outcome);
  if (!("aborted" in outcome)) return;
  assert.match(outcome.message, /Unknown command/);
});
