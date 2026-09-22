import { exec } from "node:child_process";
import { platform } from "node:os";

/**
 * Cleanly terminate a process tree (including child and grandchild processes)
 * to avoid leaving orphaned compiler or runner processes.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid || pid <= 0) return;

  if (platform() === "win32") {
    exec(`taskkill /pid ${pid} /T /F`, { windowsHide: true }, () => {});
    return;
  }

  try {
    // Attempt process group kill first (if spawned with detached / setpgid)
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }

  // Backup force kill after 1 second if still alive
  if (signal === "SIGTERM") {
    setTimeout(() => {
      try {
        if (platform() === "win32") {
          exec(`taskkill /pid ${pid} /T /F`, { windowsHide: true }, () => {});
        } else {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            process.kill(pid, "SIGKILL");
          }
        }
      } catch {}
    }, 1000);
  }
}
