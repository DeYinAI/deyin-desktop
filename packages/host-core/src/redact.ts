/**
 * Secret scrubbing for anything that leaves the machine (diagnostics uploads).
 * Two layers: structured redaction for objects with sensitive keys, and text
 * redaction for log lines that may contain tokens from URLs or headers.
 */

/** Key names whose values must never leave the device. */
const SECRET_KEY_PATTERN = /(api[-_]?key|secret|token|password|credential|authorization|cookie|session[-_]?id)/i;

const REDACTED = "[redacted]";

/** True when a property name looks like it holds secret material. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Deep-copy an object with secret-looking values replaced. Strings that look
 * like tokens (long runs of token characters) are scrubbed even under innocent
 * keys; short ordinary values pass through untouched.
 */
export function redactObject<T>(value: T, keyHint = ""): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return (isSecretKey(keyHint) ? REDACTED : redactText(value)) as T;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactObject(item, keyHint)) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? REDACTED : redactObject(v, k);
    }
    return out as T;
  }
  return value;
}

/** Scrub tokens that commonly leak into log lines (OAuth callbacks, headers). */
export function redactText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted]")
    .replace(/\b(code|access_token|refresh_token|id_token|api_key|apikey|key|token|secret)=([^\s&"']+)/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-[redacted]")
    .replace(/(authorization"?\s*[:=]\s*")([^"]+)"/gi, "$1[redacted]\"");
}
