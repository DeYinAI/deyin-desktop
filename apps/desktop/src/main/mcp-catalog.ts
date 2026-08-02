import type { McpCatalogEntry, McpCatalogInstallInput } from "../shared/types.js";
import { loadBundledCatalog } from "./mcp-catalog-loader.js";
import type { McpModuleService } from "./mcp-modules.js";

const BUNDLED: McpCatalogEntry[] = loadBundledCatalog();

/** Curated MCP server catalog for one-click install from Settings. */
export class McpCatalogService {
  constructor(private readonly modules: McpModuleService) {}

  list(): McpCatalogEntry[] {
    return BUNDLED;
  }

  get(id: string): McpCatalogEntry | undefined {
    return BUNDLED.find((e) => e.id === id);
  }

  install(input: McpCatalogInstallInput): string {
    const entry = this.get(input.entryId);
    if (!entry) throw new Error(`Unknown catalog entry "${input.entryId}".`);
    return this.modules.installFromCatalog(entry, input.secrets ?? {}, Boolean(input.useOAuth));
  }
}
