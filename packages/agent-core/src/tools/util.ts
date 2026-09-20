import { platform } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fromWslPath, isPathInsideRoot, mapPosixOntoWslUnc, toWslPath, wslUncDistro } from "@deyin/host-core";

/** Cap tool output so one command cannot blow the context window. */
export const MAX_TOOL_OUTPUT = 30_000;

export function truncate(text: string, max = MAX_TOOL_OUTPUT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [output truncated: ${text.length - max} more characters]`;
}

/** Resolve a tool path argument against the run's cwd, with Windows/WSL2 cross-boundary translation. */
export function resolvePath(cwd: string, path: string): string {
  if (!path) return cwd;

  // 1. If cwd is a WSL UNC path (e.g. \\wsl.localhost\<distro>\... or //wsl.localhost/...)
  const distro = wslUncDistro(cwd);
  if (distro) {
    if (path.startsWith("/")) {
      const mapped = mapPosixOntoWslUnc(cwd, path);
      if (mapped) return mapped;
      // Absolute POSIX path outside cwd: map onto distro root
      const uncPrefix = cwd.startsWith("//") ? `//wsl.localhost/${distro}` : `\\\\wsl.localhost\\${distro}`;
      const sep = cwd.includes("/") && !cwd.includes("\\") ? "/" : "\\";
      const tail = path.replace(/^\/+/, "").replace(/\//g, sep);
      return `${uncPrefix}${sep}${tail}`;
    }
  }

  // 2. If cwd is a Windows drive path (e.g. C:\...) and path is a /mnt/<drive>/... path:
  if (/^[a-zA-Z]:[\\/]/.test(cwd) && path.startsWith("/mnt/")) {
    const fromWsl = fromWslPath(path);
    if (fromWsl !== path) {
      return fromWsl;
    }
  }

  // 3. If host is Linux/WSL and path is a Windows drive path (C:\...)
  if (platform() !== "win32" && /^[a-zA-Z]:[\\/]/.test(path)) {
    return toWslPath(path);
  }

  // 4. Windows drive paths or UNC paths: resolve relative paths preserving format
  if (/^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\") || cwd.startsWith("//")) {
    if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(path)) {
      return path;
    }
    const sep = cwd.includes("/") && !cwd.includes("\\") ? "/" : "\\";
    const cleanCwd = cwd.replace(/[\\/]+$/, "");
    const cleanPath = path.replace(/^[\\/]+/, "").replace(/\//g, sep);
    return `${cleanCwd}${sep}${cleanPath}`;
  }

  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Resolve a path and reject escapes outside the workspace root (cwd). */
export function resolvePathInWorkspace(cwd: string, path: string): string {
  const distro = wslUncDistro(cwd);
  if (distro) {
    if (path.startsWith("/")) {
      const mapped = mapPosixOntoWslUnc(cwd, path);
      if (!mapped) {
        throw new Error(`Path escapes workspace: ${path}`);
      }
      return mapped;
    }
  }

  const resolved = resolvePath(cwd, path);
  if (!isPathInsideRoot(cwd, resolved)) {
    throw new Error(`Path escapes workspace: ${path}`);
  }
  return resolved;
}

export function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string parameter "${name}".`);
  }
  return value;
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Missing required string array parameter "${name}".`);
  }
  return value.map((v, i) => {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`Invalid string at "${name}[${i}]".`);
    }
    return v;
  });
}

/** Directories never walked by grep/glob/ls fallbacks. */
export const IGNORED_DIRS = new Set([".git", "node_modules", ".DS_Store", "dist", "out", ".cache", ".next", "coverage"]);
