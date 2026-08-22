import type { Automation } from "@deyin/host-core";
import type { SshHostsStore } from "@deyin/host-core";
import type { AgentUiEvent } from "@deyin/contract";
import { buildRemoteRunCommand, buildRemoteStdin, parseCliLine } from "./cli-invocation.js";
import { connectSsh, execStreaming } from "./ssh-client.js";

export interface RemoteRunOptions {
  automation: Automation;
  /** Payload already resolved to text (see payload.ts). */
  prompt: string;
  hosts: SshHostsStore;
  hostId: string;
  workspacePath: string;
  token: string;
  onEvent: (event: AgentUiEvent) => void;
  signal?: AbortSignal;
}

export interface RemoteRunResult {
  reason: "completed" | "max-steps" | "aborted";
  finalText: string;
}

export async function runRemoteAutomation(opts: RemoteRunOptions): Promise<RemoteRunResult> {
  const { automation, prompt, hosts, hostId, workspacePath, token, onEvent, signal } = opts;
  const session = await connectSsh({ hostId, hosts });
  const client = session.client;

  const abortListener = (): void => {
    // Closing the SSH channel triggers remote bash HUP → trap kills deyin.
    client.end();
  };
  signal?.addEventListener("abort", abortListener, { once: true });

  try {
    const command = buildRemoteRunCommand({ workspacePath, model: automation.model });
    // Token and prompt travel over stdin so they never appear in the remote argv.
    const stdin = buildRemoteStdin({ token, prompt });

    let finalText = "";
    let reason: RemoteRunResult["reason"] = "completed";
    let stderrBuf = "";

    const exitCode = await execStreaming(
      client,
      command,
      (line) => {
        const mapped = parseCliLine(line);
        if (mapped) {
          onEvent(mapped);
          if (mapped.type === "done") {
            finalText = mapped.finalText;
            reason = mapped.reason;
          }
        }
      },
      (chunk) => {
        stderrBuf += chunk;
        const trimmed = chunk.trim();
        if (trimmed) onEvent({ type: "error", message: trimmed.slice(0, 2000) });
      },
      stdin,
    );

    if (signal?.aborted) {
      return { reason: "aborted", finalText };
    }
    if (exitCode !== 0 && reason === "completed") {
      const detail = stderrBuf.trim().slice(0, 500);
      onEvent({
        type: "error",
        message: detail || `Remote command exited with code ${exitCode}`,
      });
      return { reason: "max-steps", finalText };
    }
    if (!finalText) {
      onEvent({ type: "done", reason, finalText: "" });
    }
    return { reason, finalText };
  } finally {
    signal?.removeEventListener("abort", abortListener);
    client.end();
  }
}
