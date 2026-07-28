import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentsStore, Storage } from "@deyin/host-core";
import {
  discoverPlugins,
  installPluginFromGitHub,
  parseGitHubSource,
  uninstallPlugin,
  type InstalledPlugin,
} from "@deyin/agent-core";
import type { PluginCatalogEntry, PluginInfo } from "../shared/types.js";
import type { CapabilityService } from "./capabilities.js";

const CATALOG_URL = "https://raw.githubusercontent.com/DeYinAI/registry/main/registry.json";
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** Shown when the official registry is unreachable and nothing is cached. */
const FALLBACK_CATALOG: PluginCatalogEntry[] = [
  {
    name: "starter-pack",
    description: "Curated starter skills: conventional commits and README writing.",
    repo: "DeYinAI/registry/plugins/starter-pack",
    kind: "plugin",
  },
];

interface CatalogCacheFile {
  entries: PluginCatalogEntry[];
  fetchedAt: number;
}

/** Installs, lists and uninstalls plugins under `<userData>/plugins/`. */
export class PluginService {
  constructor(
    private readonly pluginsDir: string,
    private readonly storage: Storage,
    private readonly agents: AgentsStore,
    private readonly capabilities: CapabilityService,
  ) {}

  async list(): Promise<PluginInfo[]> {
    const plugins = await discoverPlugins(this.pluginsDir);
    const disabled = this.agents.disabledCaps();
    return Promise.all(
      plugins.map(async (plugin) => ({
        name: plugin.name,
        description: plugin.description,
        version: plugin.version,
        source: plugin.source,
        enabled: !disabled.has(`plugin:${plugin.name}`),
        installedAt: plugin.installedAt,
        components: await countComponents(plugin),
        variables: plugin.variables.length > 0 ? plugin.variables : undefined,
      })),
    );
  }

  /** Official DeYinAI registry catalog, cached for a day, with an offline fallback. */
  async catalog(force = false): Promise<PluginCatalogEntry[]> {
    const cached = this.storage.readJson<CatalogCacheFile>("plugin-catalog.json", { entries: [], fetchedAt: 0 });
    if (!force && cached.entries.length > 0 && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
      return cached.entries;
    }
    try {
      const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "deyin" } });
      if (res.ok) {
        const body = (await res.json()) as { plugins?: PluginCatalogEntry[] } | PluginCatalogEntry[];
        const entries = Array.isArray(body) ? body : (body.plugins ?? []);
        const valid = entries.filter((e) => e && typeof e.name === "string" && typeof e.repo === "string");
        if (valid.length > 0) {
          this.storage.writeJson("plugin-catalog.json", { entries: valid, fetchedAt: Date.now() } satisfies CatalogCacheFile);
          return valid;
        }
      }
    } catch {
      // fall through to cache/fallback
    }
    return cached.entries.length > 0 ? cached.entries : FALLBACK_CATALOG;
  }

  /** Install from "owner/repo", "owner/repo@ref" or a github.com URL. */
  async install(source: string): Promise<{ ok: boolean; message?: string; plugin?: PluginInfo }> {
    const parsed = parseGitHubSource(source);
    if (!parsed) return { ok: false, message: "Enter a GitHub repo as owner/repo or a github.com URL." };
    const result = await installPluginFromGitHub(parsed, this.pluginsDir);
    if (!result.ok || !result.plugin) return { ok: false, message: result.message };
    this.capabilities.invalidate();
    const [info] = await Promise.all([this.toInfo(result.plugin)]);
    return { ok: true, plugin: info };
  }

  async uninstall(name: string): Promise<void> {
    await uninstallPlugin(this.pluginsDir, name);
    this.agents.removePluginSecrets(name);
    this.capabilities.invalidate();
  }

  setVariable(plugin: string, name: string, value: string): void {
    this.agents.setPluginSecret(plugin, name, value);
  }

  /** Variable names with a boolean "is set" flag (values never leave main). */
  variableState(plugin: string, names: string[]): Record<string, boolean> {
    const secrets = this.agents.getPluginSecrets(plugin);
    return Object.fromEntries(names.map((n) => [n, n in secrets]));
  }

  private async toInfo(plugin: InstalledPlugin): Promise<PluginInfo> {
    return {
      name: plugin.name,
      description: plugin.description,
      version: plugin.version,
      source: plugin.source,
      enabled: !this.agents.disabledCaps().has(`plugin:${plugin.name}`),
      installedAt: plugin.installedAt,
      components: await countComponents(plugin),
      variables: plugin.variables.length > 0 ? plugin.variables : undefined,
    };
  }
}

async function countComponents(plugin: InstalledPlugin): Promise<PluginInfo["components"]> {
  const [skills, commands, subagents, mcpServers, hooks] = await Promise.all([
    plugin.skillsDir ? countSkillFiles(plugin.skillsDir) : Promise.resolve(plugin.rootSkill ? 1 : 0),
    plugin.commandsDir ? countFiles(plugin.commandsDir, [".md", ".mdc", ".markdown", ".txt"]) : Promise.resolve(0),
    plugin.agentsDir ? countFiles(plugin.agentsDir, [".md"]) : Promise.resolve(0),
    plugin.mcpFile ? countMcpServers(plugin.mcpFile) : Promise.resolve(0),
    plugin.hooksFile ? countHooks(plugin.hooksFile) : Promise.resolve(0),
  ]);
  return { skills, commands, subagents, mcpServers, hooks };
}

async function countSkillFiles(dir: string, depth = 0): Promise<number> {
  if (depth > 4) return 0;
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "SKILL.md") total += 1;
    else if (entry.isDirectory()) total += await countSkillFiles(join(dir, entry.name), depth + 1);
  }
  return total;
}

async function countFiles(dir: string, extensions: string[]): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && extensions.some((ext) => e.name.endsWith(ext))).length;
  } catch {
    return 0;
  }
}

async function countMcpServers(file: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { mcpServers?: Record<string, unknown> };
    return Object.keys(parsed.mcpServers ?? {}).length;
  } catch {
    return 0;
  }
}

function countHooks(file: string): number {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { hooks?: Record<string, unknown[]> };
    return Object.values(parsed.hooks ?? {}).reduce((sum, defs) => sum + (Array.isArray(defs) ? defs.length : 0), 0);
  } catch {
    return 0;
  }
}
