import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Whether two secrets are equal, compared without leaking how much of them matched or how long they are. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/** A key this app makes for a sender to use: long, random, and safe to put in a header. */
export function generateSurfaceKey(bytes: number = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hmacSha256Hex(secret: string, payload: string | Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** The value of a header from a request's headers, whatever the case of its name and whether it came once or many times. */
export function headerOf(headers: Readonly<Record<string, string | string[] | undefined>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/** The key a webhook sender presented: `Authorization: Bearer <key>` or `X-Deyin-Key: <key>`. */
export function presentedKey(headers: Readonly<Record<string, string | string[] | undefined>>): string | undefined {
  const authorization = headerOf(headers, "authorization");
  if (authorization !== undefined) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (match?.[1]) return match[1];
  }
  const own = headerOf(headers, "x-deyin-key");
  return own?.trim() ? own.trim() : undefined;
}

/** Whether the body was signed with the shared secret: `X-Deyin-Signature: sha256=<hex of HMAC-SHA256(secret, body)>`. */
export function verifyBodySignature(secret: string, body: string | Buffer, header: string | undefined): boolean {
  if (header === undefined) return false;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!match?.[1]) return false;
  return safeEqual(hmacSha256Hex(secret, body), match[1].toLowerCase());
}
