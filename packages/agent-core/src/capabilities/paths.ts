import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where capability definitions live: the project's `.deyin/` folder and the
 * user-level `~/.deyin/`. Deyin deliberately scans only its own directories —
 * no foreign tool layouts — so what runs is always explicit. Precedence when
 * names collide: workspace > user > plugin (handled by scan order in the
 * registry — later sources never override earlier ones of the same name).
 */

export interface CapabilityRoot {
  dir: string;
  /** "workspace" | "user" | "plugin:<name>" | "built-in" */
  source: string;
}

export function skillRoots(cwd: string | null, userDir = homedir()): CapabilityRoot[] {
  const roots: CapabilityRoot[] = [];
  if (cwd) roots.push({ dir: join(cwd, ".deyin", "skills"), source: "workspace" });
  roots.push({ dir: join(userDir, ".deyin", "skills"), source: "user" });
  return roots;
}

export function commandRoots(cwd: string | null, userDir = homedir()): CapabilityRoot[] {
  const roots: CapabilityRoot[] = [];
  if (cwd) roots.push({ dir: join(cwd, ".deyin", "commands"), source: "workspace" });
  roots.push({ dir: join(userDir, ".deyin", "commands"), source: "user" });
  return roots;
}

export function subagentRoots(cwd: string | null, userDir = homedir()): CapabilityRoot[] {
  const roots: CapabilityRoot[] = [];
  if (cwd) roots.push({ dir: join(cwd, ".deyin", "agents"), source: "workspace" });
  roots.push({ dir: join(userDir, ".deyin", "agents"), source: "user" });
  return roots;
}

export function hooksFiles(cwd: string | null, userDir = homedir()): { path: string; source: string }[] {
  const files: { path: string; source: string }[] = [];
  if (cwd) files.push({ path: join(cwd, ".deyin", "hooks.json"), source: "workspace" });
  files.push({ path: join(userDir, ".deyin", "hooks.json"), source: "user" });
  return files;
}

export function mcpConfigFiles(cwd: string | null, userDir = homedir()): { path: string; source: string }[] {
  const files: { path: string; source: string }[] = [];
  if (cwd) files.push({ path: join(cwd, ".deyin", "mcp.json"), source: "workspace" });
  files.push({ path: join(userDir, ".deyin", "mcp.json"), source: "user" });
  return files;
}

/** The user-level directory Deyin itself writes (custom MCP servers, created skills). */
export function userDeyinDir(userDir = homedir()): string {
  return join(userDir, ".deyin");
}
