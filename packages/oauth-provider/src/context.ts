import type { ProviderConfig } from "./config.js";
import type { Keystore } from "./jwt.js";
import type { OAuthStorage } from "./storage/types.js";

/** Everything the route handlers need, assembled once at startup. */
export interface ProviderContext {
  config: ProviderConfig;
  storage: OAuthStorage;
  keystore: Keystore;
}

/** Standard OAuth error body (RFC 6749 §5.2). */
export interface OAuthErrorBody {
  error: string;
  error_description?: string;
}

export function oauthError(error: string, description?: string): OAuthErrorBody {
  return description ? { error, error_description: description } : { error };
}

/** Match a requested redirect URI against a client's allow-list, honoring RFC 8252 loopback wildcards. */
export function redirectUriAllowed(registered: string[], requested: string): boolean {
  for (const entry of registered) {
    if (entry === requested) return true;
    if (entry.includes("://127.0.0.1:*") || entry.includes("://localhost:*")) {
      const pattern = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\*", "\\d+");
      if (new RegExp(`^${pattern}$`).test(requested)) return true;
    }
  }
  return false;
}

/** Intersect requested scope with what the client is allowed to request. */
export function filterScope(requested: string | undefined, allowed: string[]): string {
  if (!requested) return "";
  const set = new Set(allowed);
  return requested
    .split(/\s+/)
    .filter((s) => s.length > 0 && set.has(s))
    .join(" ");
}
