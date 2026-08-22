import { spawn } from "node:child_process";
import { toWslPath, windowsSpawnCwd } from "@deyin/host-core";
import type { Automation } from "@deyin/host-core";
import type { AgentUiEvent } from "@deyin/contract";
import { buildRemoteRunCommand, buildRemoteStdin, parseCliLine } from "./cli-invocation.js";

/**
 * Run an automation inside a WSL2 distro.
 *
 * Same contract as the SSH executor — `deyin run --json` in a login shell, token
 * and prompt over stdin, NDJSON back — but the transport is `wsl.exe` rather than
 * an ssh2 channel. Killing the child sends the process-group trap in
 * `buildRemoteRunCommand`, so no orphaned `deyin` survives inside the distro.
 */

export interface WslRunOptions {
  automation: Automation;
  /** Payload already resolved to text (see payload.ts). */
  prompt: string;
  /** Distro name as listed by `EnvInfo.wslDistros`. */
  distro: string;
  /** Workspace path in either Windows or Linux form; translated here. */
  workspacePath: string;
  token: string;
  onEvent: (event: AgentUiEvent) => void;
  signal?: AbortSignal;
}

export interface WslRunResult {
  reason: "completed" | "max-steps" | "aborted";
  finalText: string;
}

/**
 * A cold distro takes several seconds to boot on first spawn (`vmIdleTimeout`
 * defaults to 60s, so an idle distro is usually down). Preflight gets a generous
 * budget for that reason; the run itself is not time-boxed here.
 */
const PREFLIGHT_TIMEOUT_MS = 60_000;

export interface WslPreflightResult {
  ok: boolean;
  message: string;
  nodeVersion?: string;
  deyinVersion?: string;
}

function runWsl(
  distro: string,
  command: string,
  opts: { stdin?: string; signal?: AbortSignal; timeoutMs?: number; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("wsl.exe", ["-d", distro, "--", "bash", "-lc", command], {
      // CreateProcess rejects UNC and POSIX working directories; wsl.exe is a
      // Windows process, so it must start from a Windows-valid cwd.
      cwd: windowsSpawnCwd(process.cwd()),
      windowsHide: true,
    });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`WSL command timed out after ${Math.round(opts.timeoutMs! / 1000)}s.`));
        }, opts.timeoutMs)
      : null;

    const onAbort = (): void => {
      // SIGTERM reaches the bash wrapper, whose trap kills the process group.
      child.kill("SIGTERM");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    if (opts.onStdout) child.stdout.on("data", opts.onStdout);
    if (opts.onStderr) child.stderr.on("data", opts.onStderr);

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error("wsl.exe not found. WSL2 targets are only available on Windows hosts.")
          : err,
      );
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(code ?? 0);
    });

    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

/** Mirrors testSshHost: confirm Node 20+ and the deyin CLI exist in the distro. */
export async function testWslDistro(distro: string): Promise<WslPreflightResult> {
  let stdout = "";
  try {
    const code = await runWsl(
      distro,
      "node -v 2>/dev/null || echo ''; command -v deyin >/dev/null 2>&1 && deyin --version 2>/dev/null || echo ''",
      { timeoutMs: PREFLIGHT_TIMEOUT_MS, onStdout: (c) => (stdout += c) },
    );
    if (code !== 0 && !stdout.trim()) {
      return { ok: false, message: `Could not start distro "${distro}".` };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const [nodeVersion = "", deyinVersion = ""] = stdout.split(/\r?\n/).map((l) => l.trim());
  const nodeMajor = Number.parseInt(nodeVersion.replace(/^v/, ""), 10);
  if (!nodeVersion || !Number.isFinite(nodeMajor) || nodeMajor < 20) {
    return { ok: false, message: "Node.js 20+ is required inside the distro.", nodeVersion: nodeVersion || undefined };
  }
  if (!deyinVersion) {
    return { ok: false, message: "deyin CLI not found in the distro. Install with: npm install -g @deyin/cli", nodeVersion };
  }
  return { ok: true, message: "Distro ready.", nodeVersion, deyinVersion };
}

export async function runWslAutomation(opts: WslRunOptions): Promise<WslRunResult> {
  const { automation, prompt, distro, token, onEvent, signal } = opts;
  // A workspace opened from Windows is a UNC path; bash inside the distro needs
  // the Linux form.
  const workspacePath = toWslPath(opts.workspacePath);

  const command = buildRemoteRunCommand({ workspacePath, model: automation.model });
  const stdin = buildRemoteStdin({ token, prompt });

  let finalText = "";
  let reason: WslRunResult["reason"] = "completed";
  let stderrBuf = "";
  let pending = "";

  const onStdout = (chunk: string): void => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const mapped = parseCliLine(line);
      if (!mapped) continue;
      onEvent(mapped);
      if (mapped.type === "done") {
        finalText = mapped.finalText;
        reason = mapped.reason;
      }
    }
  };

  const exitCode = await runWsl(distro, command, {
    stdin,
    signal,
    onStdout,
    onStderr: (chunk) => {
      stderrBuf += chunk;
      const trimmed = chunk.trim();
      if (trimmed) onEvent({ type: "error", message: trimmed.slice(0, 2000) });
    },
  });

  // Flush a final line that arrived without a trailing newline.
  if (pending.trim()) {
    const mapped = parseCliLine(pending);
    if (mapped) {
      onEvent(mapped);
      if (mapped.type === "done") {
        finalText = mapped.finalText;
        reason = mapped.reason;
      }
    }
  }

  if (signal?.aborted) return { reason: "aborted", finalText };
  if (exitCode !== 0 && reason === "completed") {
    const detail = stderrBuf.trim().slice(0, 500);
    onEvent({ type: "error", message: detail || `WSL command exited with code ${exitCode}` });
    return { reason: "max-steps", finalText };
  }
  if (!finalText) onEvent({ type: "done", reason, finalText: "" });
  return { reason, finalText };
}
