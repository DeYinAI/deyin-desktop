/**
 * Portable crypto helpers built on the Web Crypto API (`globalThis.crypto`),
 * so the provider runs unchanged on Node 20+, Cloudflare Workers, Bun, and Deno.
 */

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** URL-safe random token of `byteLength` bytes. */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** Human-friendly device user_code like `WDJB-MJHT` (Crockford-ish, no ambiguity). */
export function randomUserCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => BASE58[b % BASE58.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`.toUpperCase();
}

/** SHA-256 of a UTF-8 string, base64url-encoded. Used to verify PKCE S256. */
export async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toBase64Url(new Uint8Array(digest));
}

/** Constant-time-ish string comparison to avoid trivial timing leaks. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * Verify an RFC 7636 PKCE challenge. Only S256 is accepted; `plain` is rejected
 * as recommended by OAuth 2.1 for public clients.
 */
export async function verifyPkce(
  verifier: string,
  challenge: string,
  method: string,
): Promise<boolean> {
  if (method !== "S256") return false;
  const computed = await sha256Base64Url(verifier);
  return timingSafeEqual(computed, challenge);
}
