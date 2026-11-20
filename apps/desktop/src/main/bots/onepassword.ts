import { execFile } from "node:child_process";
import {
  isOnePasswordId,
  parseOnePasswordCredential,
  parseOnePasswordLogins,
  type OnePasswordField,
  type OnePasswordLogin,
} from "@deyin/host-core/shared";

/**
 * 1Password through its own command-line tool, `op`, so nothing of the person's 1Password is copied: the app asks
 * `op` for what it needs at the moment it is filled, and `op` asks the person (a fingerprint, or the app's unlock)
 * the way it does for any program. It is never run through a shell, and the item id is checked before it is passed.
 */

export interface OpResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `op` with these arguments. Rejects with an `OnePasswordError` when it cannot be started or does not finish. */
export type OpRun = (args: readonly string[]) => Promise<OpResult>;

/** A refusal in words a person can act on. Never carries anything `op` printed except its own one-line error. */
export class OnePasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnePasswordError";
  }
}

/** Long enough for a person to unlock 1Password when asked; short enough that an unattended run does not hang. */
export const OP_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 8 * 1024 * 1024;

export const NOT_INSTALLED = "1Password's command-line tool (op) is not installed. Install it, then in the 1Password app turn on Settings → Developer → Integrate with 1Password CLI.";
export const LOCKED = "1Password is locked or not signed in. Unlock the 1Password app, and check that Settings → Developer → Integrate with 1Password CLI is on.";
export const TIMED_OUT = "1Password did not answer in time. It may be waiting for you to unlock it or approve this.";
export const NO_SUCH_LOGIN = "1Password has no login with that id. Call onepassword_list to see what is there.";

/** The real thing: `op` found on PATH (or at `command`), started directly with no shell. */
export function runOp(command = "op", timeoutMs = OP_TIMEOUT_MS): OpRun {
  return (args) =>
    new Promise<OpResult>((resolve, reject) => {
      execFile(command, [...args], { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        if (failure.code === "ENOENT") return reject(new OnePasswordError(NOT_INSTALLED));
        if (failure.killed || failure.signal) return reject(new OnePasswordError(TIMED_OUT));
        // A number is the program's own exit code: it ran and said no. Anything else is the system failing to run it.
        if (typeof failure.code === "number") return resolve({ code: failure.code, stdout, stderr });
        return reject(new OnePasswordError(`1Password's command-line tool could not be run: ${String(failure.code ?? failure.message).slice(0, 120)}`));
      });
    });
}

/** `op` prints `[ERROR] 2026/01/01 12:00:00 message`; the message is what a person needs. */
function oneLine(stderr: string): string {
  const first = stderr.split("\n").find((line) => line.trim() !== "") ?? "";
  return first.replace(/^\[\w+\]\s*\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s*/, "").trim().slice(0, 200);
}

/** What a failed `op` run means. */
export function opFailure(result: OpResult): OnePasswordError {
  const said = result.stderr.toLowerCase();
  if (/not (currently )?signed in|no accounts? configured|sign in|authori[sz]|unlock|locked|session|biometric|cancel/.test(said)) return new OnePasswordError(LOCKED);
  if (/isn't an item|not found|no item|could not find/.test(said)) return new OnePasswordError(NO_SUCH_LOGIN);
  const message = oneLine(result.stderr);
  return new OnePasswordError(message ? `1Password said: ${message}` : `1Password's command-line tool stopped with code ${result.code}.`);
}

/** What the tools need from 1Password. */
export interface OnePasswordPort {
  /** The logins in the person's 1Password, without any secret. */
  logins(): Promise<OnePasswordLogin[]>;
  /** What a login fills, read at the moment it is needed. */
  credential(id: string): Promise<Record<OnePasswordField, string | null>>;
}

export function createOnePassword(run: OpRun): OnePasswordPort {
  const ok = async (args: readonly string[]): Promise<string> => {
    const result = await run(args);
    if (result.code !== 0) throw opFailure(result);
    return result.stdout;
  };
  const need = (id: string): string => {
    if (!isOnePasswordId(id)) throw new OnePasswordError(NO_SUCH_LOGIN);
    return id;
  };
  return {
    logins: async () => parseOnePasswordLogins(await ok(["item", "list", "--categories", "Login", "--format", "json"])),
    credential: async (id) => parseOnePasswordCredential(await ok(["item", "get", need(id), "--format", "json"])),
  };
}

let shared: OnePasswordPort | undefined;

/** The person's 1Password if they have turned it on, else nothing: a Bot then has only the Vault. */
export function onePasswordIf(enabled: boolean): OnePasswordPort | undefined {
  if (!enabled) return undefined;
  shared ??= createOnePassword(runOp());
  return shared;
}
