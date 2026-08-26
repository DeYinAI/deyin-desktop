import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { UnauthorizedError } from "@deyin/agent-core";
import { McpCatalogService } from "../src/main/mcp-catalog.js";
import {
  createMcpAuthBridge,
  createMcpAuthenticateTool,
  isMcpUnauthorized,
  resolveMcpModuleId,
} from "../src/main/mcp-auth-bridge.js";
import { McpModuleService } from "../src/main/mcp-modules.js";

function tempHome(): string {
  const dir = join("/tmp", `deyin-mcp-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mockOAuth(authenticated = new Set<string>()) {
  return {
    getProvider: (id: string) => ({ moduleId: id }) as never,
    isAuthenticated: (id: string) => authenticated.has(id),
  };
}

test("createMcpAuthBridge resolves oauth module targets and findModule aliases", () => {
  const home = tempHome();
  try {
    const modules = new McpModuleService(home);
    const catalog = new McpCatalogService(modules);
    catalog.install({ entryId: "cloudflare-observability", useOAuth: true });

    const bridge = createMcpAuthBridge(modules, mockOAuth() as never);
    const target = bridge.oauthTargetFor({
      name: "cloudflare-observability",
      transport: "http",
      url: "https://observability.mcp.cloudflare.com/mcp",
      enabled: true,
      source: "module:cloudflare-observability",
    });
    assert.ok(target);
    assert.equal(target.moduleId, "cloudflare-observability");
    assert.equal(target.displayName, "Cloudflare Observability");
    assert.equal(bridge.isAuthenticated("cloudflare-observability"), false);

    const byName = bridge.findModule("Cloudflare Observability");
    assert.ok(byName);
    assert.equal(byName.moduleId, "cloudflare-observability");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("createMcpAuthenticateTool emits auth-needed target for unauthenticated module", async () => {
  const home = tempHome();
  try {
    const modules = new McpModuleService(home);
    const catalog = new McpCatalogService(modules);
    catalog.install({ entryId: "cloudflare-docs", useOAuth: true });
    const bridge = createMcpAuthBridge(modules, mockOAuth() as never);

    let needed: string | null = null;
    const tool = createMcpAuthenticateTool(bridge, (target) => {
      needed = target.moduleId;
    });
    const result = await tool.execute({ server: "cloudflare-docs" }, { cwd: home });
    assert.equal(needed, "cloudflare-docs");
    assert.match(result, /Authenticate in the chat card/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveMcpModuleId extracts module id from def.source", () => {
  assert.equal(
    resolveMcpModuleId({
      name: "cloudflare-observability",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
      source: "module:cloudflare-observability",
    }),
    "cloudflare-observability",
  );
  assert.equal(
    resolveMcpModuleId({
      name: "local",
      transport: "stdio",
      command: "node",
      enabled: true,
      source: "config",
    }),
    undefined,
  );
});

test("isMcpUnauthorized detects UnauthorizedError", () => {
  assert.equal(isMcpUnauthorized(new UnauthorizedError("auth required")), true);
  assert.equal(isMcpUnauthorized(new Error("network")), false);
});
