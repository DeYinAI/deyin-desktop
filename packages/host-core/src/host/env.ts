import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { arch, hostname, platform, release } from "node:os";
import { promisify } from "node:util";
import type { EnvInfo, ShellInfo } from "../types.js";

const execFileAsync = promisify(execFile);

/** True when this process runs inside a WSL2 distro (Linux kernel built by Microsoft). */
export function insideWsl(): boolean {
  if (platform() !== "linux") return false;
  if (/microsoft/i.test(release())) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/** On a Windows host, list installed WSL distros (empty when WSL is absent). */
async function listWslDistros(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("wsl.exe", ["-l", "-q"], {
      encoding: "buffer",
      timeout: 10_000,
    });
    // wsl.exe prints UTF-16LE.
    return stdout
      .toString("utf16le")
      .split(/\r?\n/)
      .map((line) => line.replace(/\0/g, "").trim())
      .filter((line) => line.length > 0 && !line.startsWith("docker-desktop"));
  } catch {
    return [];
  }
}

const POSIX_CANDIDATES = ["/bin/bash", "/usr/bin/zsh", "/bin/zsh", "/usr/bin/fish"];

/**
 * PowerShell 7. Worth preferring over Windows PowerShell 5.1, which has no `&&`
 * operator and so chokes on ordinary agent-generated command lines.
 */
export function findPwsh(): string | null {
  if (platform() !== "win32") return null;
  const candidates = [
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\PowerShell\\7\\pwsh.exe`,
    process.env["ProgramFiles(x86)"] && `${process.env["ProgramFiles(x86)"]}\\PowerShell\\7\\pwsh.exe`,
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\pwsh.exe`,
  ];
  for (const path of candidates) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

function posixShells(): ShellInfo[] {
  const shells: ShellInfo[] = [];
  const userShell = process.env.SHELL ?? "/bin/bash";
  const seen = new Set<string>();
  for (const path of [userShell, ...POSIX_CANDIDATES]) {
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    const name = path.split("/").pop() ?? path;
    shells.push({ id: name, label: name, path, kind: "posix" });
  }
  return shells;
}

let cached: EnvInfo | undefined;
/** When an empty win32 detection was cached; retried after this so a cold-boot
 * distro (first wsl.exe call boots the VM, up to tens of seconds) eventually
 * surfaces instead of pinning the PowerShell fallback for the whole session. */
let emptyWin32CachedAt = 0;
const DETECT_RETRY_MS = 60_000;


/** Detect the local execution environment: platform, WSL2 availability, usable shells. */
export async function detectEnv(): Promise<EnvInfo> {
  if (
 cached &&
 (platform() !== "win32" ||
 cached.wslDistros.length > 0 ||
 Date.now() - emptyWin32CachedAt < DETECT_RETRY_MS)
) {
 return cached;
}

  const os = platform();
  const shells: ShellInfo[] = [];
  let wslDistros: string[] = [];
  let wsl2: boolean;

  if (os === "win32") {
    wslDistros = await listWslDistros();
    wsl2 = wslDistros.length > 0;
    for (const distro of wslDistros) {
      shells.push({
        id: `wsl:${distro}`,
        label: `WSL2 · ${distro}`,
        path: "wsl.exe",
        args: ["-d", distro],
        kind: "wsl",
      });
    }
    const pwsh = findPwsh();
    if (pwsh) shells.push({ id: "pwsh", label: "PowerShell 7", path: pwsh, kind: "windows" });
    shells.push({ id: "powershell", label: "Windows PowerShell", path: "powershell.exe", kind: "windows" });
    shells.push({ id: "cmd", label: "Command Prompt", path: process.env.COMSPEC ?? "cmd.exe", kind: "windows" });
  } else {
    wsl2 = insideWsl();
    shells.push(...posixShells());
  }

  cached = {
    platform: os,
    arch: arch(),
    wsl2,
    wslDistros,
    shells,
    // Prefer the WSL2 distro shell on Windows; otherwise the first (user) shell.
    defaultShell: shells[0]?.id ?? "bash",
    hostname: hostname(),
  };
  // Remember when an empty Windows detection happened so it can be re-probed.
 if (os === "win32" && wslDistros.length === 0) emptyWin32CachedAt = Date.now();
 return cached;
}

/**
 * Resolve a shell id to its full descriptor. Callers that need to adapt their
 * behaviour to the shell (marker syntax, path translation) must use this rather
 * than `resolveShell`, which discards `kind`.
 */
export async function resolveShellInfo(shellId?: string): Promise<ShellInfo> {
  const env = await detectEnv();
  const pick = shellId
    ? env.shells.find((s) => s.id === shellId)
    : env.shells.find((s) => s.id === env.defaultShell);
  if (pick) return pick;

  const windows = platform() === "win32";
  // Not a known id: treat it as a literal executable path.
  if (shellId) {
    return { id: shellId, label: shellId, path: shellId, kind: windows ? "windows" : "posix" };
  }
  const path = windows
    ? (process.env.COMSPEC ?? "powershell.exe")
    : (process.env.SHELL ?? "/bin/bash");
  return { id: path, label: path, path, kind: windows ? "windows" : "posix" };
}

/** Resolve a TerminalCreateOptions.shell value to an executable + args. */
export async function resolveShell(shellId?: string): Promise<{ path: string; args: string[] }> {
  const info = await resolveShellInfo(shellId);
  return { path: info.path, args: info.args ?? [] };
}
