import type { ToolDefinition } from "@deyin/agent-core";

/** The names of environment variables that hold a credential: `GH_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `OPENAI_API_KEY`, `SSH_AUTH_SOCK`, ... */
const SECRET_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH|COOKIES?|PAT)(_|$)/i;

export const isSecretName = (name: string): boolean => SECRET_NAME.test(name);

/** Shorter values are not worth hiding: they would also match ordinary words in a command's output. */
const MIN_SECRET_LENGTH = 8;

export const REDACTED = "[REDACTED]";

/**
 * What a worker's shell starts with, as changes over the desktop's own environment: the credentials the desktop was started with are
 * removed (a worker needs the agent account's token, not the user's), then the worker's own variables are set. A name screen, so
 * best effort: a credential held under an unremarkable name still reaches the shell.
 */
export function workerEnvironment(own: Readonly<Record<string, string>>, host: Readonly<Record<string, string | undefined>>): Record<string, string | null> {
  const env: Record<string, string | null> = {};
  for (const name of Object.keys(host)) if (isSecretName(name)) env[name] = null;
  return { ...env, ...own };
}

/** The values in `env` that are credentials, in the forms they may be echoed in (as is, URL-encoded, Base64), longest first. */
export function secretValues(env: Readonly<Record<string, string>>): string[] {
  const found = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!isSecretName(name) || value.length < MIN_SECRET_LENGTH) continue;
    found.add(value);
    found.add(encodeURIComponent(value));
    found.add(Buffer.from(value).toString("base64"));
  }
  return [...found].filter((value) => value.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

/** A cut-off piece of a secret this short is not worth hiding either: a few characters of a long token help nobody. */
const MIN_PARTIAL = 6;

/** Where a tool's output may have been cut in two: the end, and the markers the tools leave where they cut or switch streams. */
const CUT_MARKER = /\n\.\.\. \[output truncated|\n\[stderr\]\n/g;

/** `text` with the longest piece of `secret` that it ends with before `end` replaced (a secret whose rest a cut then took), or `undefined`. */
function redactPartialBefore(text: string, end: number, secret: string): string | undefined {
  for (let length = Math.min(secret.length - 1, end); length >= MIN_PARTIAL; length--) {
    if (text.startsWith(secret.slice(0, length), end - length)) return `${text.slice(0, end - length)}${REDACTED}${text.slice(end)}`;
  }
  return undefined;
}

/**
 * `text` with every secret replaced, so a command that prints its environment shows the model nothing it can leak. Output is cut
 * to a limit, and the cut can fall inside a secret, so the piece of a secret before a cut (and after the start of the text) goes too.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) if (result.includes(secret)) result = result.split(secret).join(REDACTED);
  const cuts = [...result.matchAll(CUT_MARKER)].map((match) => match.index);
  for (const end of [result.length, ...cuts].sort((a, b) => b - a)) {
    for (const secret of secrets) {
      const redacted = redactPartialBefore(result, end, secret);
      if (redacted !== undefined) {
        result = redacted;
        break;
      }
    }
  }
  for (const secret of secrets) {
    for (let length = Math.min(secret.length - 1, result.length); length >= MIN_PARTIAL; length--) {
      if (result.startsWith(secret.slice(-length))) {
        result = `${REDACTED}${result.slice(length)}`;
        break;
      }
    }
  }
  return result;
}

/** A tool whose results and errors have the secrets removed before they go to the model or into the stored conversation. */
export function redactingTool(tool: ToolDefinition, secrets: readonly string[]): ToolDefinition {
  if (secrets.length === 0) return tool;
  return {
    ...tool,
    async execute(args, ctx) {
      try {
        return redact(await tool.execute(args, ctx), secrets);
      } catch (error) {
        if (error instanceof Error) {
          // Only when it holds a secret: some errors (an abort) have a read-only message, and the loop recognizes them by type.
          const message = redact(error.message, secrets);
          // eslint-disable-next-line preserve-caught-error -- the original is what holds the secret, so it must not travel as a cause
          if (message !== error.message) throw new Error(message);
        }
        throw error;
      }
    },
  };
}
