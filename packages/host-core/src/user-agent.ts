/**
 * Single source of truth for the User-Agent Deyin sends on every outbound HTTP
 * request: LLM providers, web search, GitHub, and the Openference APIs.
 *
 * Format follows the standard `product/version (comment)` convention:
 *
 *   Deyin/1.0.15 (desktop; Windows; node/22.10)
 *
 * The surface and version are supplied once at app startup via `initUserAgent`
 * (desktop: `app.getVersion()`, CLI: the package version, web host-server: the
 * package.json version); platform and runtime come from the ambient process.
 *
 * Pure string building with no `node:` imports: host-core's `/shared` surface
 * (which re-exports this module) is bundled into the desktop renderer and the
 * web client, where `process` may not exist.
 */

export type DeyinAppSurface = "desktop" | "cli" | "web-server" | "unknown";

let current = "";

/** Platform comment token for the running OS; "browser" without a process. */
function platformToken(): string {
 if (typeof process === "undefined") return "browser";
 switch (process.platform) {
 case "win32":
 return "Windows";
 case "darwin":
 return "macOS";
 default:
 return "Linux";
 }
}

/** Runtime comment token: the Node major.minor, or "browser" without a process. */
function runtimeToken(): string {
 if (typeof process === "undefined") return "browser";
 const node = (process.versions as Record<string, string | undefined> | undefined)?.node;
 if (!node) return "browser";
 return `node/${node.split(".").slice(0, 2).join(".")}`;
}

/** Build the canonical UA string without storing it (also used by the fallback). */
export function buildDeyinUserAgent(app: DeyinAppSurface, version: string): string {
 return `Deyin/${version} (${app}; ${platformToken()}; ${runtimeToken()})`;
}

/**
 * Store the process-wide User-Agent. Call once at app startup, before any
 * outbound request. Returns the stored UA for convenience.
 */
export function initUserAgent(app: Exclude<DeyinAppSurface, "unknown">, version: string): string {
 current = buildDeyinUserAgent(app, version);
 return current;
}

/**
 * The User-Agent for outbound requests. Returns the value stored by
 * `initUserAgent`; when startup wiring was missed, builds a distinctive
 * `Deyin/0.0.0 (unknown; …)` fallback — deliberately greppable in server logs,
 * never an empty header.
 */
export function deyinUserAgent(): string {
 if (current) return current;
 return buildDeyinUserAgent("unknown", "0.0.0");
}

/**
 * `init` with the Deyin User-Agent filled in unless the caller already set one
 * (any header casing, any `HeadersInit` shape). Plain-object headers stay plain
 * objects; `Headers`/tuple-array inputs are normalized into a `Headers`.
 *
 * Without this, Node's fetch (undici) identifies every request as bare `node`.
 */
export function withUserAgent(init?: RequestInit): RequestInit {
  const headers = init?.headers;
  if (headers === undefined) return { ...init, headers: { "user-agent": deyinUserAgent() } };
  if (headers instanceof Headers || Array.isArray(headers)) {
    const merged = new Headers(headers);
    if (!merged.has("user-agent")) merged.set("user-agent", deyinUserAgent());
    return { ...init, headers: merged };
  }
  if (Object.keys(headers).some((name) => name.toLowerCase() === "user-agent")) return { ...init, headers };
  return { ...init, headers: { ...headers, "user-agent": deyinUserAgent() } };
}

/**
 * `fetch` that identifies as Deyin unless the caller set a User-Agent. Pass it
 * wherever a library takes an injectable `fetch` (OAuth client, MCP transports,
 * bot connectors) so third-party request paths cannot fall back to `node`.
 */
export function fetchWithUserAgent(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (typeof Request !== "undefined" && input instanceof Request) {
    // Explicit init.headers replace the Request's own, so carry them across first.
    const headers = new Headers(input.headers);
    if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    return fetch(input, withUserAgent({ ...init, headers }));
  }
  return fetch(input, withUserAgent(init));
}

/** Test hook: restore the uninitialized state. */
export function resetUserAgentForTest(): void {
 current = "";
}
