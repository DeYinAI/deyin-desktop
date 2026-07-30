import type { Automation } from "@deyin/host-core";
import type { SshHostsStore } from "@deyin/host-core";
import type { AgentEvent } from "@deyin/agent-core";
import type { AgentUiEvent } from "../../shared/types.js";
import { buildRemoteRunCommand, buildRemoteStdin, connectSsh, execStreaming } from "./ssh-client.js";

export interface RemoteRunOptions {
  automation: Automation;
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

function mapCliEvent(raw: AgentEvent | { type: "result"; finalText?: string; reason?: string }): AgentUiEvent | null {
  switch (raw.type) {
    case "text-delta":
      return { type: "text-delta", delta: raw.delta };
    case "reasoning-delta":
      return { type: "reasoning-delta", delta: raw.delta };
    case "tool-start":
      return { type: "tool-start", callId: raw.call.id, name: raw.call.name, summary: raw.summary };
    case "tool-end":
      return {
        type: "tool-end",
        callId: raw.call.id,
        name: raw.call.name,
        summary: "",
        result: raw.result.length > 8_000 ? `${raw.result.slice(0, 8_000)}\n… (truncated)` : raw.result,
        ok: raw.ok,
        denied: raw.denied,
      };
    case "file-change":
      return { type: "file-change", path: raw.change.path, before: raw.change.before, after: raw.change.after };
    case "todos":
      return { type: "todos", todos: raw.todos };
    case "usage":
      return { type: "usage", totalTokens: raw.usage.totalTokens };
    case "result":
      return {
        type: "done",
        reason: raw.reason === "completed" ? "completed" : raw.reason === "aborted" ? "aborted" : "max-steps",
        finalText: raw.finalText ?? "",
      };
    default:
      return null;
  }
}

export async function runRemoteAutomation(opts: RemoteRunOptions): Promise<RemoteRunResult> {
  const { automation, hosts, hostId, workspacePath, token, onEvent, signal } = opts;
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
    const stdin = buildRemoteStdin({ token, prompt: automation.prompt });

    let finalText = "";
    let reason: RemoteRunResult["reason"] = "completed";
    let stderrBuf = "";

    const exitCode = await execStreaming(
      client,
      command,
      (line) => {
        try {
          const parsed = JSON.parse(line) as AgentEvent | { type: "result"; finalText?: string; reason?: string };
          const mapped = mapCliEvent(parsed);
          if (mapped) {
            onEvent(mapped);
            if (mapped.type === "done") {
              finalText = mapped.finalText;
              reason = mapped.reason;
            }
          }
        } catch {
          // ignore non-JSON lines
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
