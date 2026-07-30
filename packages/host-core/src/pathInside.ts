/**
 * Pure (no filesystem / no Node `path`) helpers for "is this path under root?"
 * Safe to import from browser/renderer via `@deyin/host-core/shared`.
 */

function isAbsolutePath(p: string): boolean {
  if (p.startsWith("/") || p.startsWith("\\")) return true;
  // Windows drive: C:\ or C:/
  return /^[a-zA-Z]:[\\/]/.test(p);
}

/** Collapse `.` / `..` and normalize separators to `/` (drive letter preserved). */
export function logicalResolve(base: string, path?: string): string {
  const target =
    path === undefined ? base : isAbsolutePath(path) ? path : joinLogical(base, path);

  const winDrive = /^([a-zA-Z]:)[\\/]/.exec(target);
  const unc = target.startsWith("\\\\") || target.startsWith("//");
  let rest = target.replace(/\\/g, "/");

  let prefix = "";
  if (winDrive) {
    prefix = winDrive[1]!.toLowerCase() + "/";
    rest = rest.slice(winDrive[0].length);
  } else if (unc) {
    prefix = "//";
    rest = rest.replace(/^\/+/, "");
  } else if (rest.startsWith("/")) {
    prefix = "/";
    rest = rest.slice(1);
  }

  const parts: string[] = [];
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(seg);
  }

  if (!prefix && path === undefined && !isAbsolutePath(base)) {
    // Relative-only normalize (rare for workspace roots).
    return parts.join("/") || ".";
  }
  return prefix + parts.join("/");
}

function joinLogical(base: string, path: string): string {
  const b = base.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${b}/${p}`;
}

/**
 * True when `path` resolves inside `root` (same rules as host `assertInsideRoot`
 * prefix check, without touching the filesystem or `process.cwd()`).
 */
export function isPathInsideRoot(root: string, path: string): boolean {
  const r = logicalResolve(root);
  const abs = logicalResolve(r, path);
  if (abs === r) return true;
  // Match both separators so Windows-style roots still work after `/` normalize.
  return abs.startsWith(r + "/") || abs.startsWith(r + "\\");
}
