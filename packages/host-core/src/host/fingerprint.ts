import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Workspace fingerprint: a stable, pseudonymous id for one workspace on one
 * workstation. Derived from the OS machine id plus the workspace root, hashed so
 * neither the path nor the machine id is exposed. Used by the Identity page,
 * identity sync and diagnostics — the same device must always produce the same
 * fingerprint for the same workspace.
 */
export function workspaceFingerprint(machineId: string, workspaceRoot: string | null): string {
  return createHash("sha256")
    .update(`deyin-ws:v1:${machineId}:${workspaceRoot ?? ""}`)
    .digest("hex");
}

/** Truncate a fingerprint for display: "d4e9…c731". */
export function truncateFingerprint(fingerprint: string): string {
  if (fingerprint.length <= 9) return fingerprint;
  return `${fingerprint.slice(0, 4)}…${fingerprint.slice(-4)}`;
}

let cachedMachineId: string | null = null;

/**
 * Best-effort OS machine id, cached for the process. Falls back to the hostname
 * when no platform source is readable (containers, locked-down Windows), so the
 * fingerprint is still stable if not hardware-bound.
 */
export async function machineId(): Promise<string> {
  if (cachedMachineId) return cachedMachineId;
  cachedMachineId = (await readMachineId()) ?? hostname();
  return cachedMachineId;
}

async function readMachineId(): Promise<string | null> {
  switch (platform()) {
    case "linux":
      return readFirst(["/etc/machine-id", "/var/lib/dbus/machine-id"]);
    case "darwin": {
      const out = await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
      const match = out?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      return match?.[1]?.trim() ?? null;
    }
    case "win32": {
      const out = await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
      const match = out?.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      return match?.[1]?.trim() ?? null;
    }
    default:
      return null;
  }
}

function readFirst(paths: string[]): string | null {
  for (const path of paths) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function run(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000, windowsHide: true });
    return stdout;
  } catch {
    return null;
  }
}
