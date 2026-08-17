import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpCatalogEntry } from "@deyin/contract";

const CATALOG_DIR = join(dirname(fileURLToPath(import.meta.url)), "mcp-catalog");

/** Load bundled catalog entries from per-MCP JSON files in mcp-catalog/. */
export function loadBundledCatalog(): McpCatalogEntry[] {
  return readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(CATALOG_DIR, f), "utf8")) as McpCatalogEntry)
    .sort((a, b) => a.name.localeCompare(b.name));
}
