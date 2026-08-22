/**
 * Path translation across the Windows/WSL2 boundary.
 *
 * A workspace opened from Windows lives at a UNC path (`\\wsl.localhost\<distro>\home\me\p`)
 * while the same directory inside the distro is `/home/me/p`. Commands sent to a
 * `wsl.exe` PTY must use the Linux form; `wsl.exe` itself is a Windows process and
 * must be launched from a Windows working directory.
 */

/** `\\wsl$\<distro>\...` (legacy) and `\\wsl.localhost\<distro>\...` (Win 11). */
const WSL_UNC_RE = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)(?:\\(.*))?$/i;
const WIN_DRIVE_RE = /^([A-Za-z]):[\\/](.*)$/;

/** Distro name when `p` is a WSL UNC path, else null. */
export function wslUncDistro(p: string): string | null {
  return WSL_UNC_RE.exec(p)?.[1] ?? null;
}

/** Convert a host path to the form bash sees inside a WSL2 distro. */
export function toWslPath(p: string): string {
  if (!p) return p;
  // Already POSIX (host is Linux, or the caller pre-translated).
  if (p.startsWith("/")) return p;

  const unc = WSL_UNC_RE.exec(p);
  if (unc) {
    const rest = unc[2] ?? "";
    return `/${rest.replace(/\\/g, "/")}`.replace(/\/+$/, "") || "/";
  }

  const [, letter, remainder] = WIN_DRIVE_RE.exec(p) ?? [];
  if (letter !== undefined) {
    const tail = (remainder ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    return `/mnt/${letter.toLowerCase()}${tail ? `/${tail}` : ""}`;
  }

  return p.replace(/\\/g, "/");
}

/**
 * Working directory to hand node-pty when spawning `wsl.exe`. CreateProcess
 * rejects UNC and POSIX directories, so those fall back to the user profile;
 * the shell is then moved to the real directory with a `cd`.
 */
export function windowsSpawnCwd(p: string): string {
  if (!p || p.startsWith("/") || WSL_UNC_RE.test(p)) {
    return process.env.USERPROFILE ?? process.env.SystemRoot ?? "C:\\";
  }
  return p;
}

/** Resolved cwd for spawning `wsl.exe` via node-pty on Windows. */
export interface WslTerminalSpawn {
  /** Directory handed to CreateProcess (must be a real Windows path). */
  spawnCwd: string;
  /** Distro-local path to `cd` into after the shell starts, or null when unnecessary. */
  initialCd: string | null;
}

/**
 * node-pty cannot use WSL UNC or POSIX working directories (CreateProcess error
 * 267). Launch from a Windows directory and optionally cd inside the distro.
 */
export function wslTerminalSpawn(rawCwd: string): WslTerminalSpawn {
  const spawnCwd = windowsSpawnCwd(rawCwd);
  const linuxPath = toWslPath(rawCwd);
  const initialCd = linuxPath !== spawnCwd ? linuxPath : null;
  return { spawnCwd, initialCd };
}

/** Escape a path for a single-quoted bash `cd` argument. */
export function bashSingleQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
