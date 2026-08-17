import type { PkcePair } from "./types.js";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toBase64Url(new Uint8Array(digest));
}

/** Generate an RFC 7636 PKCE pair (S256). */
export async function generatePkce(): Promise<PkcePair> {
  const verifier = randomString(32);
  const challenge = await sha256Base64Url(verifier);
  return { verifier, challenge, method: "S256" };
}

/** CSRF state value for the authorization request. */
export function generateState(): string {
  return randomString(16);
}
