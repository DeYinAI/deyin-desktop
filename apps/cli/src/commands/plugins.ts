import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  discoverPlugins,
  installPluginFromGitHub,
  parseGitHubSource,
  uninstallPlugin,
} from "@deyin/agent-core";
import type { CliContext } from "../context.js";
import { bold, dim, green, red } from "../output.js";

function pluginsDir(ctx: CliContext): string {
  return join(ctx.dataDir, "plugins");
}

export async function pluginsListCommand(ctx: CliContext): Promise<number> {
  const plugins = await discoverPlugins(pluginsDir(ctx));
  if (plugins.length === 0) {
    console.log("No plugins installed. Install one with `deyin plugin install owner/repo`.");
    return 0;
  }
  for (const plugin of plugins) {
    const parts = [plugin.version ? `v${plugin.version}` : "", plugin.hostModule ? `host:${plugin.hostModule}` : "", plugin.source]
      .filter(Boolean)
      .join("  ");
    console.log(`${bold(plugin.name.padEnd(22))} ${(plugin.description ?? "").slice(0, 70)}  ${dim(parts)}`);
  }
  console.log(dim(`\n${plugins.length} plugin(s). Capabilities load on the next run.`));
  return 0;
}

export async function pluginInstallCommand(ctx: CliContext, sourceInput?: string): Promise<number> {
  const source = sourceInput?.trim();
  if (!source) {
    console.error(`${red("error:")} usage: deyin plugin install <owner/repo[@ref][/subdir]>`);
    return 1;
  }
  const parsed = parseGitHubSource(source);
  if (!parsed) {
    console.error(`${red("error:")} invalid GitHub plugin source: ${source}`);
    return 1;
  }
  try {
    await mkdir(pluginsDir(ctx), { recursive: true, mode: 0o700 });
    const result = await installPluginFromGitHub(parsed, pluginsDir(ctx));
    if (!result.ok || !result.plugin) {
      console.error(`${red("error:")} ${result.message ?? "plugin installation failed"}`);
      return 1;
    }
    console.log(`${green("installed")} ${result.plugin.name} → ${result.plugin.dir}`);
    return 0;
  } catch (err) {
    console.error(`${red("error:")} ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export async function pluginUninstallCommand(ctx: CliContext, nameInput?: string, confirm = false): Promise<number> {
  const name = nameInput?.trim().toLowerCase();
  if (!name) {
    console.error(`${red("error:")} usage: deyin plugin uninstall <name> --yes`);
    return 1;
  }
  if (!confirm) {
    console.error(`${red("refusing:")} pass --yes to uninstall ${name}.`);
    return 1;
  }
  try {
    await uninstallPlugin(pluginsDir(ctx), name);
    console.log(`${green("uninstalled")} ${name}`);
    return 0;
  } catch (err) {
    console.error(`${red("error:")} ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
