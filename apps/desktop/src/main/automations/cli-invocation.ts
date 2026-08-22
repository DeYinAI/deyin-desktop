import type { AgentEvent } from "@deyin/agent-core";
import type { AgentUiEvent } from "@deyin/contract";

/**
 * Shared plumbing for the two out-of-process targets (SSH and WSL2). Both drive
 * `deyin run --json` in a login shell and read NDJSON back, so the command
 * wrapper, the stdin payload and the event mapping live here rather than being
 * duplicated per transport.
 */

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap the remote agent in a process group so a dropped connection (HUP/EXIT)
 * kills the deyin child instead of leaving orphans.
 *
 * Neither the access token nor the prompt appears in the command string: both are
 * streamed over stdin (see `buildRemoteStdin`). The shell reads the token from the
 * first line into a non-exported variable and passes it to `deyin` as a per-command
 * environment entry, so the secret never reaches `/proc/<pid>/cmdline` and never
 * lands in the long-lived login shell's environment. It only lives in the deyin
 * child's environ, which the CLI requires.
 */
export function buildRemoteRunCommand(opts: { workspacePath: string; model: string }): string {
  const inner = [
    `cd ${shellQuote(opts.workspacePath)}`,
    // Line 1 of stdin: base64 token. `read` on a pipe consumes exactly one line,
    // leaving the rest of the stream (the base64 prompt) for the pipeline below.
    `IFS= read -r __tok_b64`,
    // printf is a bash builtin, so the base64 token is never in an argv either.
    `__tok=$(printf %s "$__tok_b64" | base64 -d)`,
    `base64 -d | DEYIN_TOKEN="$__tok" deyin run --json -y -C ${shellQuote(opts.workspacePath)} -m ${shellQuote(opts.model)}`,
  ].join(" && ");
  // Job-control shell: trap EXIT/HUP and kill the whole process group.
  return `bash -lc ${shellQuote(`set -m; trap 'kill -TERM -$$ 2>/dev/null' EXIT HUP INT TERM; ${inner}`)}`;
}

/**
 * stdin payload for `buildRemoteRunCommand`: base64 token on the first line,
 * followed by the base64 prompt as the remainder of the stream.
 */
export function buildRemoteStdin(opts: { token: string; prompt: string }): string {
  const tokenB64 = Buffer.from(opts.token, "utf8").toString("base64");
  const promptB64 = Buffer.from(opts.prompt, "utf8").toString("base64");
  return `${tokenB64}\n${promptB64}`;
}

/** Cap tool results so one noisy call cannot blow up the persisted run. */
const MAX_RESULT_CHARS = 8_000;

export type CliResultEvent = { type: "result"; finalText?: string; reason?: string };

/** NDJSON line from `deyin run --json` → the UI event shape run history stores. */
export function mapCliEvent(raw: AgentEvent | CliResultEvent): AgentUiEvent | null {
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
        result: raw.result.length > MAX_RESULT_CHARS ? `${raw.result.slice(0, MAX_RESULT_CHARS)}\n… (truncated)` : raw.result,
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

/** Parse one NDJSON line, ignoring the CLI's non-JSON chatter. */
export function parseCliLine(line: string): AgentUiEvent | null {
  try {
    return mapCliEvent(JSON.parse(line) as AgentEvent | CliResultEvent);
  } catch {
    return null;
  }
}
