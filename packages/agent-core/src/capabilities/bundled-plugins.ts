import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginManifest } from "./plugins.js";

interface InstallMeta {
  source: string;
  installedAt: string;
  version?: string;
}

function readManifest(dir: string): PluginManifest | null {
  const candidates = [
    join(dir, ".deyin-plugin", "plugin.json"),
    join(dir, ".codex-plugin", "plugin.json"),
    join(dir, "plugin.json"),
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as PluginManifest;
    } catch {
      // try next
    }
  }
  return null;
}

function versionGte(a: string | undefined, b: string | undefined): boolean {
  if (!b) return true;
  if (!a) return false;
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return true;
    if (da < db) return false;
  }
  return true;
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else cpSync(from, to);
  }
}

/**
 * Materialize first-party bundled plugins from the app bundle into
 * `<pluginsDir>/bundled-<name>/`. Re-copies when the bundled version bumps.
 */
export function materializeBundledPlugins(bundledSrcDir: string, pluginsDir: string): number {
  if (!existsSync(bundledSrcDir)) return 0;
  mkdirSync(pluginsDir, { recursive: true });
  let updated = 0;
  for (const entry of readdirSync(bundledSrcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = join(bundledSrcDir, entry.name);
    const manifest = readManifest(src);
    if (!manifest) continue;
    const name = manifest.name ?? entry.name;
    const dest = join(pluginsDir, `bundled-${name}`);
    const metaPath = join(dest, ".deyin-install.json");
    let existing: InstallMeta | null = null;
    try {
      existing = JSON.parse(readFileSync(metaPath, "utf8")) as InstallMeta;
    } catch {
      existing = null;
    }
    const bundledVersion = manifest.version ?? "0.0.0";
    if (existsSync(dest) && versionGte(existing?.version, bundledVersion)) continue;
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    copyDir(src, dest);
    const meta: InstallMeta = {
      source: "bundled",
      installedAt: new Date().toISOString(),
      version: bundledVersion,
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    updated += 1;
  }
  return updated;
}

/** Resolve path to bundled-plugins source (dev vs packaged). */
export function resolveBundledPluginsDir(appRoot: string, isPackaged: boolean, resourcesPath?: string): string {
  const candidates = isPackaged
    ? [join(appRoot, "bundled-plugins"), ...(resourcesPath ? [join(resourcesPath, "bundled-plugins")] : [])]
    : [join(appRoot, "bundled-plugins"), join(appRoot, "..", "bundled-plugins")];
  for (const dir of candidates) {
    if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
  }
  return candidates[0]!;
}
