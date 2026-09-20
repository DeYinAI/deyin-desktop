/**
 * Path translation across the Windows/WSL2 boundary.
 *
 * A workspace opened from Windows lives at a UNC path (`\\wsl.localhost\<distro>\home\me\p`)
 * while the same directory inside the distro is `/home/me/p`. Commands sent to a
 * `wsl.exe` PTY must use the Linux form; `wsl.exe` itself is a Windows process and
 * must be launched from a Windows working directory.
 */

/** `\\wsl$\<distro>\...` (legacy) and `\\wsl.localhost\<distro>\...` (Win 11), accepting both backslashes and forward slashes. */
export const WSL_UNC_RE = /^(?:\\\\|\/\/)wsl(?:\$|\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/i;
const WIN_DRIVE_RE = /^([A-Za-z]):[\\/](.*)$/;
const MNT_DRIVE_RE = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/;

/** Distro name when `p` is a WSL UNC path, else null. */
export function wslUncDistro(p: string): string | null {
  return WSL_UNC_RE.exec(p)?.[1] ?? null;
}

function normalizePosix(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

/**
 * When the workspace root is a WSL UNC path, map a POSIX twin onto it.
 * Returns null when `posixPath` is not under the distro-local root.
 */
export function mapPosixOntoWslUnc(wslUncRoot: string, posixPath: string): string | null {
  if (!posixPath.startsWith("/") || !wslUncDistro(wslUncRoot)) return null;
  const rawLinuxRoot = toWslPath(wslUncRoot).replace(/\/+$/, "");
  const linuxRoot = normalizePosix(rawLinuxRoot || "/");
  const posix = normalizePosix(posixPath);
  const isUnder =
    linuxRoot === "/"
      ? posix.startsWith("/")
      : posix === linuxRoot || posix.startsWith(`${linuxRoot}/`);
  if (!isUnder) return null;
  const rel =
    linuxRoot === "/"
      ? (posix === "/" ? "" : posix.slice(1))
      : (posix === linuxRoot ? "" : posix.slice(linuxRoot.length + 1));
  const rootTrimmed = wslUncRoot.replace(/[\\/]+$/, "");
  if (!rel) return rootTrimmed;
  const sep = rootTrimmed.includes("\\") ? "\\" : "/";
  return `${rootTrimmed}${sep}${rel.replace(/\//g, sep)}`;
}

/** Convert a host path to the form bash sees inside a WSL2 distro. */
export function toWslPath(p: string): string {
  if (!p) return p;

  // Check WSL UNC first so forward-slash UNC paths (e.g. //wsl.localhost/...) are
  // converted to distro-local paths instead of mistakenly treated as POSIX.
  const unc = WSL_UNC_RE.exec(p);
  if (unc) {
    const rest = unc[2] ?? "";
    return `/${rest.replace(/\\/g, "/")}`.replace(/\/+$/, "") || "/";
  }

  // Already POSIX (host is Linux, or the caller pre-translated).
  if (p.startsWith("/")) return p;

  const [, letter, remainder] = WIN_DRIVE_RE.exec(p) ?? [];
  if (letter !== undefined) {
    const tail = (remainder ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    return `/mnt/${letter.toLowerCase()}${tail ? `/${tail}` : ""}`;
  }

  return p.replace(/\\/g, "/");
}

/** Convert a WSL/Linux path (/mnt/c/... or /home/...) to a Windows host path. */
export function fromWslPath(p: string, defaultDistro?: string): string {
  if (!p) return p;
  const mnt = MNT_DRIVE_RE.exec(p);
  if (mnt) {
    const drive = mnt[1]!.toUpperCase();
    const tail = (mnt[2] ?? "").replace(/\//g, "\\");
    return `${drive}:\\${tail}`;
  }
  if (p.startsWith("/") && defaultDistro) {
    const tail = p.replace(/^\/+/, "").replace(/\//g, "\\");
    return `\\\\wsl.localhost\\${defaultDistro}\\${tail}`;
  }
  return p;
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
 *
 * Prefer `wslLaunchArgs` (wsl.exe --cd) for new call sites: the shell then
 * starts inside the directory instead of relying on a post-spawn cd write,
 * which can race shell startup on a cold distro.
 */
export function wslTerminalSpawn(rawCwd: string): WslTerminalSpawn {
  const spawnCwd = windowsSpawnCwd(rawCwd);
  const linuxPath = toWslPath(rawCwd);
  const initialCd = linuxPath !== spawnCwd ? linuxPath : null;
  return { spawnCwd, initialCd };
}

/**
 * Extra wsl.exe arguments that start the shell inside `linuxPath` directly
 * (Cursor/zcode-style --cd), so the first prompt is already in the project.
 * Appended to the shell descriptor's own args. An empty/root path keeps the
 * distro default (--cd ~) instead of landing in C:\Windows\System32.
 */
export function wslLaunchArgs(distro: string, linuxPath: string | null, includeDistro = true): string[] {
  const distroArgs = includeDistro && distro ? ["-d", distro] : [];
  if (!linuxPath || linuxPath === "/") return [...distroArgs, "--cd", "~"];
  return [...distroArgs, "--cd", linuxPath];
}

/**
 * Distro whose workspace the cwd points at, when the shell list can serve it.
 * A wsl.localhost/wsl$ UNC cwd should get a WSL shell even when detection or
 * settings picked a Windows one; returns null when the cwd is not a WSL UNC
 * path or that distro is missing from `shells`.
 */
export function preferWslShellForCwd(
shells: readonly { id: string; kind: string }[],
cwd: string | null | undefined,
): string | null {
const distro = cwd ? wslUncDistro(cwd) : null;
if (!distro) return null;
const wanted = `wsl:${distro}`.toLowerCase();
const match = shells.find((s) => s.kind === "wsl" && s.id.toLowerCase() === wanted);
return match ? match.id : null;
}

/** Escape a path for a single-quoted bash `cd` argument. */
export function bashSingleQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
