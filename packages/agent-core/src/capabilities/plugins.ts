import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Installed-plugin discovery. A plugin is a directory (unpacked from a GitHub
 * repo) with an optional manifest at .deyin-plugin/plugin.json (or the Cursor
 * compat .cursor-plugin/plugin.json / root plugin.json) and auto-discovered
 * component folders: skills/, commands/, agents/, hooks/hooks.json, mcp.json,
 * plus a root SKILL.md as the single-skill fallback.
 */

export interface PluginManifest {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  keywords?: string[];
  /** Secret variable names (array) or a JSON-schema-ish { properties } object. */
  variables?: string[] | { properties?: Record<string, unknown> };
}

export interface InstalledPlugin {
  name: string;
  dir: string;
  description?: string;
  version?: string;
  /** From .deyin-install.json, e.g. "github:owner/repo" or "local". */
  source: string;
  installedAt?: string;
  variables: string[];
  /** Component roots that exist on disk. */
  skillsDir?: string;
  commandsDir?: string;
  agentsDir?: string;
  hooksFile?: string;
  mcpFile?: string;
  rootSkill?: string;
}

interface InstallMeta {
  source?: string;
  installedAt?: string;
  ref?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function loadPlugin(dir: string, fallbackName: string): Promise<InstalledPlugin | null> {
  if (!(await exists(dir))) return null;
  const manifest =
    (await readJson<PluginManifest>(join(dir, ".deyin-plugin", "plugin.json"))) ??
    (await readJson<PluginManifest>(join(dir, ".cursor-plugin", "plugin.json"))) ??
    (await readJson<PluginManifest>(join(dir, "plugin.json"))) ??
    {};
  const meta = (await readJson<InstallMeta>(join(dir, ".deyin-install.json"))) ?? {};

  const variables = Array.isArray(manifest.variables)
    ? manifest.variables
    : Object.keys(manifest.variables?.properties ?? {});

  const plugin: InstalledPlugin = {
    name: manifest.name ?? fallbackName,
    dir,
    description: manifest.description,
    version: manifest.version,
    source: meta.source ?? "local",
    installedAt: meta.installedAt,
    variables,
  };
  const skillsDir = join(dir, "skills");
  const commandsDir = join(dir, "commands");
  const agentsDir = join(dir, "agents");
  const hooksFile = join(dir, "hooks", "hooks.json");
  const mcpFile = join(dir, "mcp.json");
  const rootSkill = join(dir, "SKILL.md");
  if (await exists(skillsDir)) plugin.skillsDir = skillsDir;
  if (await exists(commandsDir)) plugin.commandsDir = commandsDir;
  if (await exists(agentsDir)) plugin.agentsDir = agentsDir;
  if (await exists(hooksFile)) plugin.hooksFile = hooksFile;
  if (await exists(mcpFile)) plugin.mcpFile = mcpFile;
  if (!plugin.skillsDir && (await exists(rootSkill))) plugin.rootSkill = rootSkill;
  return plugin;
}

/** All plugins unpacked under `<pluginsDir>/<name>/`. */
export async function discoverPlugins(pluginsDir: string): Promise<InstalledPlugin[]> {
  let entries;
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const plugins: InstalledPlugin[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const plugin = await loadPlugin(join(pluginsDir, entry.name), entry.name);
    if (plugin) plugins.push(plugin);
  }
  return plugins;
}
