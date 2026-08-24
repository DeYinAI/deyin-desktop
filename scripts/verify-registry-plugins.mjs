#!/usr/bin/env node
/**
 * Smoke-test every plugin listed in DeYinAI/registry by copying into a temp
 * plugins dir and running the same discovery path Deyin uses at runtime.
 *
 * Usage (from deyin-desktop root, after packages are built):
 *   node scripts/verify-registry-plugins.mjs
 *   REGISTRY_ROOT=/path/to/registry node scripts/verify-registry-plugins.mjs
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPlugins } from "../packages/agent-core/dist/capabilities/plugins.js";
import { scanCapabilities } from "../packages/agent-core/dist/capabilities/registry.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(scriptDir, "..");
const defaultRegistry = join(desktopRoot, "..", "registry");
const registryRoot = resolve(process.env.REGISTRY_ROOT ?? defaultRegistry);

async function main() {
  const registry = JSON.parse(await readFile(join(registryRoot, "registry.json"), "utf8"));
  const plugins = registry.plugins ?? [];
  if (plugins.length === 0) {
    console.error("registry.json has no plugins");
    process.exit(1);
  }

  const tempBase = await mkdtemp(join(tmpdir(), "deyin-registry-verify-"));
  const pluginsDir = join(tempBase, "plugins");
  const workspace = join(tempBase, "ws");
  const userDir = join(tempBase, "home");

  let failed = 0;
  try {
    for (const entry of plugins) {
      const src = join(registryRoot, "plugins", entry.name);
      const dest = join(pluginsDir, entry.name);
      await cp(src, dest, { recursive: true });
      await writeFile(
        join(dest, ".deyin-install.json"),
        JSON.stringify(
          { source: `local:registry/${entry.name}`, ref: "main", installedAt: new Date().toISOString() },
          null,
          2,
        ),
      );

      const discovered = await discoverPlugins(pluginsDir);
      const plugin = discovered.find((p) => p.name === entry.name);
      if (!plugin) {
        console.error(`FAIL ${entry.name}: discoverPlugins did not load plugin`);
        failed += 1;
        continue;
      }

      const snap = await scanCapabilities({ cwd: workspace, userDir, pluginsDir });
      const pluginSkills = snap.skills.filter((s) => s.source === `plugin:${entry.name}`);
      const pluginMcp = snap.mcpServers.filter((s) => s.source === `plugin:${entry.name}`);

      const manifestPath = join(src, ".deyin-plugin", "plugin.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const expectsMcp = Boolean(manifest.variables?.length || (await fileExists(join(src, "mcp.json"))));

      if (pluginSkills.length === 0) {
        console.error(`FAIL ${entry.name}: no skills discovered`);
        failed += 1;
        continue;
      }
      if (expectsMcp && pluginMcp.length === 0) {
        console.error(`FAIL ${entry.name}: expected MCP servers but none discovered`);
        failed += 1;
        continue;
      }

      console.log(
        `OK ${entry.name}: ${pluginSkills.length} skill(s), ${pluginMcp.length} MCP server(s)`,
      );
    }
  } finally {
    await rm(tempBase, { recursive: true, force: true });
  }

  if (failed > 0) {
    console.error(`\n${failed} plugin(s) failed verification.`);
    process.exit(1);
  }
  console.log(`\nAll ${plugins.length} registry plugins verified.`);
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
