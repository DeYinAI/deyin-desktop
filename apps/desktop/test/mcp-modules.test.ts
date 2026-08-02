import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { McpCatalogService } from "../src/main/mcp-catalog.js";
import { McpModuleService } from "../src/main/mcp-modules.js";

function tempHome(): string {
  const dir = join("/tmp", `deyin-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("McpModuleService installs catalog entry as isolated module dir", () => {
  const home = tempHome();
  try {
    const modules = new McpModuleService(home);
    const catalog = new McpCatalogService(modules);
    const stripe = catalog.get("stripe");
    assert.ok(stripe);

    const id = catalog.install({
      entryId: "stripe",
      secrets: { STRIPE_SECRET_KEY: "rk_test_123" },
      useOAuth: false,
    });
    assert.equal(id, "stripe");

    const dir = join(home, ".deyin", "mcp-modules", "stripe");
    assert.ok(existsSync(join(dir, "module.json")));
    assert.ok(existsSync(join(dir, "mcp.json")));

    const manifest = JSON.parse(readFileSync(join(dir, "module.json"), "utf8")) as {
      source: string;
      catalogEntryId: string;
      usesNativeOAuth?: boolean;
    };
    assert.equal(manifest.source, "catalog");
    assert.equal(manifest.catalogEntryId, "stripe");
    assert.equal(manifest.usesNativeOAuth, false);

    const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")) as {
      mcpServers: { stripe: { url: string; env: Record<string, string> } };
    };
    assert.equal(mcp.mcpServers.stripe.url, "https://mcp.stripe.com");
    assert.equal(mcp.mcpServers.stripe.env.STRIPE_SECRET_KEY, "rk_test_123");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("McpModuleService installs oauth catalog entry as direct HTTP module", () => {
  const home = tempHome();
  try {
    const modules = new McpModuleService(home);
    const catalog = new McpCatalogService(modules);
    catalog.install({ entryId: "cloudflare-docs", useOAuth: true });

    const dir = join(home, ".deyin", "mcp-modules", "cloudflare-docs");
    const manifest = JSON.parse(readFileSync(join(dir, "module.json"), "utf8")) as {
      usesNativeOAuth?: boolean;
      authMode?: string;
    };
    assert.equal(manifest.authMode, "oauth");
    assert.equal(manifest.usesNativeOAuth, true);

    const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")) as {
      mcpServers: { "cloudflare-docs": { url: string; command?: string } };
    };
    assert.equal(mcp.mcpServers["cloudflare-docs"].url, "https://docs.mcp.cloudflare.com/mcp");
    assert.equal(mcp.mcpServers["cloudflare-docs"].command, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("McpModuleService migrates flat mcp.json into module dirs", () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, ".deyin"), { recursive: true });
    writeFileSync(
      join(home, ".deyin", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "my-server": { command: "npx", args: ["-y", "server-git"] },
        },
      }),
    );

    const modules = new McpModuleService(home);
    const migrated = modules.migrateFlatMcp();
    assert.equal(migrated, 1);
    assert.ok(existsSync(join(home, ".deyin", "mcp-modules", "my-server", "mcp.json")));
    assert.ok(existsSync(join(home, ".deyin", "mcp.json.bak")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("McpCatalogService rejects missing required secrets", () => {
  const home = tempHome();
  try {
    const modules = new McpModuleService(home);
    const catalog = new McpCatalogService(modules);
    assert.throws(() => catalog.install({ entryId: "stripe", useOAuth: false }), /Restricted API key/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadBundledCatalog returns all per-entry JSON files without oauthFallback", async () => {
  const { loadBundledCatalog } = await import("../src/main/mcp-catalog-loader.js");
  const entries = loadBundledCatalog();
  assert.ok(entries.length >= 26);
  assert.ok(entries.some((e) => e.id === "stripe"));
  assert.ok(entries.some((e) => e.id === "playwright"));
  for (const entry of entries) {
    assert.equal("oauthFallback" in entry, false, `${entry.id} should not have oauthFallback`);
  }
});
