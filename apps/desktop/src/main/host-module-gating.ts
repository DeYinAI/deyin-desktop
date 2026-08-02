import { discoverPlugins } from "@deyin/agent-core";

/** Check whether a bundled host module plugin is installed and enabled. */
export async function isHostModuleEnabled(
  dir: string,
  hostModule: string,
  disabledCaps: Set<string>,
): Promise<boolean> {
  const plugins = await discoverPlugins(dir);
  const plugin = plugins.find((p) => p.hostModule === hostModule && p.bundled === true);
  if (!plugin) return hostModule === "browser";
  if (plugin.platform === "windows" && process.platform !== "win32") return false;
  return !disabledCaps.has(`plugin:${plugin.name}`);
}
