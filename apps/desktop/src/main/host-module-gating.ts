import { discoverPlugins, type InstalledPlugin } from "@deyin/agent-core";

/** Gate over an already-scanned plugin list (preferred on hot paths). */
export function isHostModuleEnabledFor(
  plugins: InstalledPlugin[],
  hostModule: string,
  disabledCaps: Set<string>,
): boolean {
  const plugin = plugins.find((p) => p.hostModule === hostModule && p.bundled === true);
  if (!plugin) return hostModule === "browser";
  if (plugin.platform === "windows" && process.platform !== "win32") return false;
  return !disabledCaps.has(`plugin:${plugin.name}`);
}

/** Check whether a bundled host module plugin is installed and enabled. */
export async function isHostModuleEnabled(
  dir: string,
  hostModule: string,
  disabledCaps: Set<string>,
): Promise<boolean> {
  return isHostModuleEnabledFor(await discoverPlugins(dir), hostModule, disabledCaps);
}
