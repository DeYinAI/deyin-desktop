import type { Client, ClientChannel } from "ssh2";
import { BotError } from "@deyin/host-core";
import { shellQuote } from "../../automations/cli-invocation.js";
import type { RemoteRunOptions, RemoteRunResult, RemoteShell } from "./installer.js";

/** The most output kept from one script; the installer only ever reads the end of it. */
const KEEP_CHARS = 256 * 1024;

function keep(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > KEEP_CHARS ? next.slice(next.length - KEEP_CHARS) : next;
}

/**
 * A `RemoteShell` over an SSH connection. Each script runs as `bash -lc`, so the server's own PATH applies (that is
 * where `~/.local/bin` is added), and its standard input is closed once `stdin` is written, so nothing waits on it.
 */
export function sshShell(client: Pick<Client, "exec">): RemoteShell {
  return {
    run(script: string, options: RemoteRunOptions = {}): Promise<RemoteRunResult> {
      return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new BotError("conflict", "Stopped."));
          return;
        }
        const started = (error: Error | undefined, stream: ClientChannel): void => {
          if (error) {
            reject(new BotError("conflict", `The server would not run the command: ${error.message}`));
            return;
          }
          let stdout = "";
          let stderr = "";
          const onAbort = (): void => {
            stream.close();
          };
          options.signal?.addEventListener("abort", onAbort, { once: true });
          stream.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            stdout = keep(stdout, text);
            options.onOutput?.(text);
          });
          stream.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            stderr = keep(stderr, text);
            options.onOutput?.(text);
          });
          stream.on("close", (code: number | null | undefined) => {
            options.signal?.removeEventListener("abort", onAbort);
            if (options.signal?.aborted) {
              reject(new BotError("conflict", "Stopped."));
            } else if (typeof code !== "number") {
              reject(new BotError("conflict", "The connection to the server dropped before the command finished."));
            } else {
              resolve({ code, stdout, stderr });
            }
          });
          stream.end(options.stdin ?? "");
        };
        try {
          client.exec(`bash -lc ${shellQuote(script)}`, started);
        } catch (error) {
          // ssh2 throws, rather than calling back, when the connection is already closed.
          reject(new BotError("conflict", `The server would not run the command: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    },
  };
}
